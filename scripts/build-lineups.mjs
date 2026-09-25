#!/usr/bin/env node
/*
  Fills in data/lineups.csv from the starting XIs typed into it.

    node scripts/build-lineups.mjs

  You only ever add STARTERS (week, manager, slot GK/DEF/MID/FWD, player_id, player).
  This script then, for every week that has starters:
    - recomputes each player's points (pts) and Sleeper projection (proj) under this league's scoring
    - rebuilds each club's roster as it stood at the end of that gameweek (draft + every
      transaction up to the last kickoff) and writes everyone not starting as bench rows (slot BN)
    - checks every XI adds up to the score in data/matchups.csv and that every starter was
      actually on that roster
  Re-running it is safe: bench rows are always regenerated. Needs Node 18+.
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
const SLOTS = ["GK", "DEF", "MID", "FWD"];

const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} → ${r.status}`); return r.json(); };
const money = (n) => Math.round(n * 100) / 100;

function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).filter((l) => l.trim())) {
    const out = []; let f = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(f); f = ""; } else f += ch;
    }
    out.push(f); rows.push(out.map((x) => x.trim()));
  }
  const head = rows.shift().map((h) => h.toLowerCase());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

async function main() {
  const [league, users, rosters, drafts, players, events] = await Promise.all([
    get(`${API}/league/${LEAGUE_ID}`), get(`${API}/league/${LEAGUE_ID}/users`), get(`${API}/league/${LEAGUE_ID}/rosters`),
    get(`${API}/league/${LEAGUE_ID}/drafts`), get(`${API}/players/${SPORT}`), get(`${FPL}/bootstrap-static/`).then((b) => b.events),
  ]);
  const season = league.season;
  const scoring = league.scoring_settings;
  const userById = Object.fromEntries(users.map((u) => [u.user_id, u.display_name]));
  const managerOf = Object.fromEntries(rosters.map((r) => [r.roster_id, userById[r.owner_id]]));
  const rosterOf = Object.fromEntries(rosters.map((r) => [String(userById[r.owner_id]).toLowerCase(), r.roster_id]));
  const pointsOf = (line) => { let p = 0; for (const [k, v] of Object.entries(line || {})) if (scoring[k] !== undefined && typeof v === "number") p += v * scoring[k]; return money(p); };
  const nameOf = (id) => { const p = players[id]; return p ? (p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ")).trim() : id; };

  // every roster move, oldest first
  const picks = await get(`${API}/draft/${drafts[0].draft_id}/picks`);
  const legs = Math.max(league.settings.leg || 1, league.settings.last_scored_leg || 1) + 1;
  const txns = (await Promise.all(Array.from({ length: legs }, (_, i) => get(`${API}/league/${LEAGUE_ID}/transactions/${i + 1}`).catch(() => []))))
    .flat().filter((t) => t.status === "complete").sort((a, b) => a.status_updated - b.status_updated);
  const rosterAt = (time) => {
    const own = {};
    for (const p of picks) own[p.player_id] = p.roster_id;
    for (const t of txns) {
      if (t.status_updated > time) break;
      for (const pid of Object.keys(t.drops || {})) delete own[pid];
      for (const [pid, rid] of Object.entries(t.adds || {})) own[pid] = rid;
    }
    const by = {};
    for (const [pid, rid] of Object.entries(own)) (by[rid] ||= new Set()).add(pid);
    return by;
  };

  // sanity check: replaying everything must land on today's rosters
  const now = rosterAt(Infinity);
  for (const r of rosters) {
    const mine = now[r.roster_id] || new Set(), real = new Set(r.players || []);
    const diff = [...real].filter((x) => !mine.has(x)).concat([...mine].filter((x) => !real.has(x)));
    if (diff.length) console.log(`! ${managerOf[r.roster_id]}: replayed roster differs from Sleeper today by ${diff.map(nameOf).join(", ")}`);
  }

  const rows = parseCSV(await readFile(FILE, "utf8")).filter((r) => r.slot && r.slot.toUpperCase() !== "BN");
  const matchups = parseCSV(await readFile(join(root, "data", "matchups.csv"), "utf8"));
  const weeks = [...new Set(rows.map((r) => +r.week))].sort((a, b) => a - b);
  const out = [];
  const problems = [];

  for (const week of weeks) {
    const [stats, proj, fixtures] = await Promise.all([
      get(`${API}/stats/${SPORT}/regular/${season}/${week}`), get(`${API}/projections/${SPORT}/regular/${season}/${week}`),
      get(`${FPL}/fixtures/?event=${week}`),
    ]);
    // the roster Sleeper shows for a gameweek is the one at the end of it (after the last kickoff)
    const lastKick = Math.max(...fixtures.map((f) => Date.parse(f.kickoff_time)).filter(Number.isFinite));
    const end = (Number.isFinite(lastKick) ? lastKick : Date.parse(events.find((e) => e.id === week).deadline_time) + 4 * 864e5) + 3 * 36e5;
    const squads = rosterAt(end);
    const managers = [...new Set(rows.filter((r) => +r.week === week).map((r) => r.manager))];
    for (const manager of managers) {
      const rid = rosterOf[manager.toLowerCase()];
      const xi = rows.filter((r) => +r.week === week && r.manager === manager)
        .sort((a, b) => SLOTS.indexOf(a.slot.toUpperCase()) - SLOTS.indexOf(b.slot.toUpperCase()));
      const squad = squads[rid] || new Set();
      let total = 0;
      for (const r of xi) {
        const pts = pointsOf(stats[r.player_id]);
        total += pts;
        if (!squad.has(r.player_id)) problems.push(`GW${week} ${manager}: starter ${r.player} wasn't on the replayed roster`);
        out.push([week, manager, r.slot.toUpperCase(), r.player_id, r.player || nameOf(r.player_id), pts, (proj[r.player_id] ? pointsOf(proj[r.player_id]) : ""), stats[r.player_id]?.min ?? 0]);
      }
      const bench = [...squad].filter((pid) => !xi.some((r) => r.player_id === pid))
        .map((pid) => [week, manager, "BN", pid, nameOf(pid), pointsOf(stats[pid]), (proj[pid] ? pointsOf(proj[pid]) : ""), stats[pid]?.min ?? 0])
        .sort((a, b) => b[7] - a[7] || b[5] - a[5]);
      out.push(...bench);
      const m = matchups.find((x) => +x.week === week && [x.home, x.away].some((u) => u.toLowerCase() === manager.toLowerCase()));
      const score = m && (m.home.toLowerCase() === manager.toLowerCase() ? +m.home_pts : +m.away_pts);
      if (m && Math.abs(money(total) - score) > 0.011) problems.push(`GW${week} ${manager}: XI adds up to ${money(total)}, matchups.csv says ${score}`);
      console.log(`GW${week} ${manager.padEnd(14)} XI ${money(total).toFixed(2).padStart(7)}  bench ${bench.length}`);
    }
  }

  const q = (s) => (/[",]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
  await writeFile(FILE, ["week,manager,slot,player_id,player,pts,proj,min", ...out.map((r) => r.map(q).join(","))].join("\n") + "\n");
  if (problems.length) { console.log(`\n${problems.length} problem(s):`); problems.forEach((p) => console.log("  - " + p)); process.exitCode = 1; }
  else console.log("All XIs match their scores and every starter was on the roster.");
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
