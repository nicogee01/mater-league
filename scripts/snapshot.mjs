#!/usr/bin/env node
/*
  Logs head-to-head results into data/results.js.

  Sleeper's public API doesn't expose matchups for soccer leagues, but each
  roster's running totals (points for / against, W-L) do update. Run this once
  after every gameweek is scored: it diffs the totals against the last snapshot
  and pairs opponents (my points-for == your points-against, and vice versa).

    node scripts/snapshot.mjs          # record the latest gameweek
    node scripts/snapshot.mjs --init   # just save a baseline, record nothing

  Needs Node 18+ (built-in fetch). No dependencies.
*/
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LEAGUE_ID = "1390750210698780672";
const API = "https://api.sleeper.app/v1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = join(root, "data", "results.js");
const STATE = join(root, "data", "snapshot-state.json");

const get = async (p) => {
  const r = await fetch(API + p);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
const pts = (i, d) => Math.round(((i || 0) + (d || 0) / 100) * 100) / 100;

// the file's leading comment documents the format, so keep it on every write
let header = "";
async function readResults() {
  const src = await readFile(RESULTS, "utf8");
  // the header comment mentions the variable too, so parse from the last occurrence
  const at = src.lastIndexOf("window.NYM_RESULTS");
  const m = src.slice(at).match(/^window\.NYM_RESULTS\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (at < 0 || !m) throw new Error("Couldn't parse data/results.js. Keep it as `window.NYM_RESULTS = { ...valid JSON... };`");
  header = src.slice(0, at);
  return JSON.parse(m[1]);
}
async function writeResults(data) {
  data.matches.sort((a, b) => a.week - b.week || a.home - b.home);
  await writeFile(RESULTS, header + "window.NYM_RESULTS = " + JSON.stringify(data, null, 2) + ";\n");
}

async function main() {
  const [league, users, rosters] = await Promise.all([
    get(`/league/${LEAGUE_ID}`), get(`/league/${LEAGUE_ID}/users`), get(`/league/${LEAGUE_ID}/rosters`),
  ]);
  const week = league.settings.last_scored_leg;
  const now = Object.fromEntries(rosters.map((r) => {
    const s = r.settings;
    return [r.roster_id, { pf: pts(s.fpts, s.fpts_decimal), pa: pts(s.fpts_against, s.fpts_against_decimal), g: (s.wins || 0) + (s.losses || 0) + (s.ties || 0) }];
  }));

  const data = await readResults();
  // keep a readable roster-ID → team legend inside the results file
  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  data.teams = Object.fromEntries(rosters.map((r) => {
    const u = userById[r.owner_id] || {};
    return [r.roster_id, (u.metadata && u.metadata.team_name) || `${u.display_name} FC`];
  }));

  let prev = null;
  try { prev = JSON.parse(await readFile(STATE, "utf8")); } catch (_) {}

  if (process.argv.includes("--init") || !prev) {
    await writeFile(STATE, JSON.stringify({ week, totals: now }, null, 2));
    await writeResults(data);
    console.log(`Baseline saved at gameweek ${week}. Run again after the next gameweek is scored.`);
    return;
  }

  if (week <= prev.week) {
    console.log(`Nothing new: last scored gameweek is still ${week}.`);
    return;
  }
  if (week - prev.week > 1) {
    console.warn(`Heads up: ${week - prev.week} gameweeks passed since the last snapshot (GW ${prev.week} → ${week}).`);
    console.warn("Opponents can't be separated across multiple weeks. Add the missing results to data/results.js by hand, then run with --init.");
    process.exitCode = 1;
    return;
  }

  const d = Object.entries(now).map(([id, t]) => ({
    id: +id, pf: +(t.pf - prev.totals[id].pf).toFixed(2), pa: +(t.pa - prev.totals[id].pa).toFixed(2), g: t.g - prev.totals[id].g,
  })).filter((x) => x.g > 0);

  const used = new Set();
  const found = [];
  for (const a of d) {
    if (used.has(a.id)) continue;
    const b = d.find((x) => x.id !== a.id && !used.has(x.id) && Math.abs(x.pf - a.pa) < 0.02 && Math.abs(x.pa - a.pf) < 0.02);
    if (!b) { console.warn(`Couldn't find an opponent for roster ${a.id} (${data.teams[a.id]}).`); continue; }
    used.add(a.id); used.add(b.id);
    found.push({ week, home: a.id, away: b.id, homePts: a.pf, awayPts: b.pf });
  }

  data.matches = data.matches.filter((m) => m.week !== week).concat(found);
  await writeResults(data);
  await writeFile(STATE, JSON.stringify({ week, totals: now }, null, 2));
  console.log(`Gameweek ${week}: logged ${found.length} result(s).`);
  for (const m of found) console.log(`  ${data.teams[m.home]} ${m.homePts} – ${m.awayPts} ${data.teams[m.away]}`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
