#!/usr/bin/env node
/*
  Records each club's starting XI straight from Sleeper, player by player, as the gameweek is played.

    node scripts/snapshot-lineups.mjs            # record every starter whose match has kicked off
    node scripts/snapshot-lineups.mjs --dry-run  # show what would be recorded, write nothing

  Sleeper's public API has no soccer matchups, but every roster carries its current `starters`. A
  player locks at his own club's kickoff, so a starter whose match has started can't be changed any
  more: that's when he is recorded. Each run adds the newly locked starters, so by the gameweek's last
  kickoff the whole XI is in. It has to happen during the gameweek: the moment the last match ends
  Sleeper moves on to the next week and unlocks every lineup. The GitHub Action runs this every ten
  minutes; outside a gameweek it exits straight away.

  New starter rows go into data/lineups.csv; run scripts/build-lineups.mjs afterwards to add points,
  projections and benches (the Action does both). Needs Node 18+.
*/
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LEAGUE_ID = "1390750210698780672";
const SPORT = "clubsoccer:epl";
const API = "https://api.sleeper.app/v1";
const FPL = "https://fantasy.premierleague.com/api";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(root, "data", "lineups.csv");
const DRY = process.argv.includes("--dry-run");

const get = async (url) => { const r = await fetch(url, { headers: { "user-agent": "mater-league-site" } }); if (!r.ok) throw new Error(`${url} → ${r.status}`); return r.json(); };
const FLEX = { FM_FLEX: ["F", "M"], MD_FLEX: ["M", "D"], FMD_FLEX: ["F", "M", "D"] };
const SLOT = { GK: "GK", D: "DEF", M: "MID", F: "FWD" };

function parseFormations(raw) {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw || {};
    return Object.entries(obj).map(([wk, f]) => ({ wk: +wk, f: String(f) })).filter((x) => /^\d-\d-\d$/.test(x.f)).sort((a, b) => a.wk - b.wk);
  } catch (_) { return []; }
}

// same rules as the site: fixed slots stay put, flex slots fill what the formation still needs
function lineUp(roster, slotNames, formation, players) {
  const [d, m, f] = formation.split("-").map(Number);
  const need = { GK: 1, D: d, M: m, F: f };
  const out = [];
  const flex = [];
  (roster.starters || []).forEach((pid, i) => {
    if (!pid || pid === "0") return;
    const slot = slotNames[i];
    if (need[slot] !== undefined) { out.push({ pid, line: slot }); need[slot]--; }
    else flex.push({ pid, allowed: FLEX[slot] || ["M"] });
  });
  for (const { pid, allowed } of flex) {
    const p = players[pid] || {};
    const own = (p.fantasy_positions || [p.position]).filter((x) => allowed.includes(x) && need[x] > 0);
    const line = own[0] || allowed.find((x) => need[x] > 0) || "M";
    out.push({ pid, line });
    need[line]--;
  }
  return out;
}

async function main() {
  const [league, users, rosters, players, events] = await Promise.all([
    get(`${API}/league/${LEAGUE_ID}`), get(`${API}/league/${LEAGUE_ID}/users`), get(`${API}/league/${LEAGUE_ID}/rosters`),
    get(`${API}/players/${SPORT}`), get(`${FPL}/bootstrap-static/`).then((b) => b.events),
  ]);
  const slotNames = league.roster_positions.filter((s) => s !== "BN" && s !== "IR");
  const nameOf = (id) => { const p = players[id]; return p ? (p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ")).replace(/,/g, "").trim() : id; };
  const manager = Object.fromEntries(users.map((u) => [u.user_id, u.display_name]));
  const text = await readFile(FILE, "utf8");
  const sport = await get(`${API}/state/${SPORT}`);

  // the gameweek being played: its first match has kicked off, and Sleeper hasn't moved on yet
  const now = Date.now();
  const gw = +sport.week;
  const fixtures = gw ? await get(`${FPL}/fixtures/?event=${gw}`) : [];
  const kicks = fixtures.map((f) => Date.parse(f.kickoff_time)).filter(Number.isFinite);
  const first = Math.min(...kicks), last = Math.max(...kicks);
  if (!DRY && (!kicks.length || now < first)) { console.log(`GW${gw} hasn't kicked off yet; nothing to record.`); return; }

  // each club's kickoff this gameweek (FPL and Sleeper share club codes); a player locks at his club's kickoff
  const teams = await get(`${FPL}/bootstrap-static/`).then((b) => Object.fromEntries(b.teams.map((t) => [t.id, t.short_name])));
  const kickoff = {};
  for (const f of fixtures) for (const t of [f.team_h, f.team_a]) {
    const k = Date.parse(f.kickoff_time), c = teams[t];
    if (Number.isFinite(k) && (!kickoff[c] || k < kickoff[c])) kickoff[c] = k;
  }
  // no match this week (or a club we can't place): locked once the last match has started
  const locked = (pid) => { const c = (players[pid] || {}).team_abbr; return DRY || now >= (kickoff[c] ?? last); };

  // starters already recorded for this gameweek, per manager
  const have = {};
  for (const l of text.split(/\r?\n/).slice(1)) {
    const c = l.split(",");
    if (+c[0] === gw && c[2] !== "BN") (have[c[1].toLowerCase()] ||= new Set()).add(c[3]);
  }

  const rows = [];
  for (const r of rosters) {
    const mgr = manager[r.owner_id];
    const got = have[String(mgr).toLowerCase()] || new Set();
    if (got.size >= 11) continue;
    const shapes = parseFormations(r.metadata && r.metadata.formation);
    const formation = ([...shapes].reverse().find((x) => x.wk <= gw) || shapes[0] || { f: "3-4-3" }).f;
    const xi = lineUp(r, slotNames, formation, players);
    const fresh = xi.filter((x) => locked(x.pid) && !got.has(x.pid)).slice(0, 11 - got.size);
    console.log(`GW${gw} ${String(mgr).padEnd(14)} ${formation}  ${got.size} recorded, +${fresh.length} now locked`);
    for (const x of fresh.sort((a, b) => ["GK", "D", "M", "F"].indexOf(a.line) - ["GK", "D", "M", "F"].indexOf(b.line)))
      rows.push([gw, mgr, SLOT[x.line], x.pid, nameOf(x.pid)].join(","));
  }
  if (DRY) { console.log(`\n(dry run) would add ${rows.length} starter rows for GW${gw}`); return; }
  if (!rows.length) { console.log("No newly locked starters."); return; }
  await writeFile(FILE, text.replace(/\s*$/, "\n") + rows.join("\n") + "\n");
  console.log(`Added ${rows.length} starter rows for GW${gw}. Next: node scripts/build-lineups.mjs`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
