#!/usr/bin/env node
/*
  Records each club's starting XI straight from Sleeper once a gameweek is over.

    node scripts/snapshot-lineups.mjs            # snapshot any finished gameweek that isn't logged yet
    node scripts/snapshot-lineups.mjs --dry-run  # show what the current lineups would record, write nothing

  Sleeper's public API has no soccer matchups, but every roster carries its current `starters` and
  a per-gameweek formation. A player locks at his own kickoff, so by the time a gameweek's last match
  has finished every starter is locked in: that moment's starters ARE the gameweek's XI. The GitHub
  Action runs this hourly; it only writes during the window just after a gameweek's final match
  (before managers start setting next week's team), and only for a week with no starters logged yet.

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
// snapshot window after a gameweek's last kickoff: late enough that the match is over,
// early enough that nobody has reset their team for next week
const OPEN_H = 2.5, CLOSE_H = 14;

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
  const logged = new Set(text.split(/\r?\n/).slice(1).filter((l) => l && !l.includes(",BN,")).map((l) => +l.split(",")[0]));

  // which gameweek (if any) just finished?
  const now = Date.now();
  let week = null;
  for (const e of events.filter((e) => e.finished || e.is_current || e.is_previous)) {
    const fixtures = await get(`${FPL}/fixtures/?event=${e.id}`);
    const last = Math.max(...fixtures.map((f) => Date.parse(f.kickoff_time)).filter(Number.isFinite));
    const h = (now - last) / 36e5;
    if (h >= OPEN_H && h <= CLOSE_H) { week = e.id; break; }
  }
  if (DRY) week = week || league.settings.leg || 0;
  if (!week) { console.log("No gameweek has just finished; nothing to snapshot."); return; }
  if (!DRY && logged.has(week)) { console.log(`GW${week} already logged; nothing to do.`); return; }

  const rows = [];
  for (const r of rosters) {
    const mgr = manager[r.owner_id];
    const shapes = parseFormations(r.metadata && r.metadata.formation);
    const formation = ([...shapes].reverse().find((x) => x.wk <= week) || shapes[0] || { f: "3-4-3" }).f;
    const xi = lineUp(r, slotNames, formation, players);
    const counts = ["GK", "D", "M", "F"].map((k) => xi.filter((x) => x.line === k).length);
    const ok = xi.length === 11 && counts[0] === 1;
    console.log(`GW${week} ${String(mgr).padEnd(14)} ${formation}  ${xi.length} starters${ok ? "" : "  <-- CHECK: incomplete lineup"}`);
    for (const x of xi.sort((a, b) => ["GK", "D", "M", "F"].indexOf(a.line) - ["GK", "D", "M", "F"].indexOf(b.line)))
      rows.push([week, mgr, SLOT[x.line], x.pid, nameOf(x.pid)].join(","));
  }
  if (DRY) { console.log(`\n(dry run) would add ${rows.length} starter rows for GW${week}`); return; }
  await writeFile(FILE, text.replace(/\s*$/, "\n") + rows.join("\n") + "\n");
  console.log(`Added ${rows.length} starter rows for GW${week}. Next: node scripts/build-lineups.mjs`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
