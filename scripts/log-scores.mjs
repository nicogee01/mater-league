#!/usr/bin/env node
/*
  Logs a finished gameweek's scores into data/matchups.csv as soon as Sleeper finalizes them.

    node scripts/log-scores.mjs            # add any finalized gameweek that isn't logged yet
    node scripts/log-scores.mjs --dry-run  # show what would be added, write nothing

  Sleeper's public API has no soccer matchups, but each roster carries its season totals: points for
  (fpts) and max points (ppts, the best possible lineup). Once Sleeper has scored gameweek N
  (league.settings.last_scored_leg) and gameweeks 1..N-1 are already in matchups.csv, a club's
  gameweek-N score is its season total minus everything logged so far; same for its best lineup.
  Pairings and home/away come from data/fixtures.csv. Every result is checked against Sleeper's
  week-by-week W/L record before anything is written; if a single thing disagrees, nothing is.
  Only one gameweek at a time can be derived this way (that's why it runs every half hour).
*/
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LEAGUE_ID = "1390750210698780672";
const API = "https://api.sleeper.app/v1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MATCHUPS = join(root, "data", "matchups.csv"), FIXTURES = join(root, "data", "fixtures.csv");
const DRY = process.argv.includes("--dry-run");
const get = async (p) => { const r = await fetch(API + p); if (!r.ok) throw new Error(`${p} → ${r.status}`); return r.json(); };
const money = (n) => Math.round(n * 100) / 100;
const rowsOf = (text) => text.split(/\r?\n/).filter((l) => l.trim()).slice(1).map((l) => l.split(",").map((x) => x.trim()));

const [league, users, rosters] = await Promise.all([get(`/league/${LEAGUE_ID}`), get(`/league/${LEAGUE_ID}/users`), get(`/league/${LEAGUE_ID}/rosters`)]);
const scored = league.settings.last_scored_leg || 0;
const text = await readFile(MATCHUPS, "utf8");
const rows = rowsOf(text);
const logged = rows.length ? Math.max(...rows.map((r) => +r[0])) : 0;
if (scored <= logged) { console.log(`Nothing new: Sleeper has scored GW${scored}, matchups.csv has GW${logged}.`); process.exit(0); }
const week = logged + 1;
if (scored > week) console.log(`Note: Sleeper has scored up to GW${scored}; only GW${week} can be derived now (one week at a time).`);

const nameOf = Object.fromEntries(users.map((u) => [u.user_id, u.display_name]));
const club = {};
for (const r of rosters) {
  const s = r.settings || {}, m = nameOf[r.owner_id].toLowerCase();
  const pf = money((s.fpts || 0) + (s.fpts_decimal || 0) / 100), pp = money((s.ppts || 0) + (s.ppts_decimal || 0) / 100);
  let lf = 0, lb = 0;
  for (const x of rows) {
    if (x[1].toLowerCase() === m) { lf += +x[3]; lb += +x[5]; }
    if (x[2].toLowerCase() === m) { lf += +x[4]; lb += +x[6]; }
  }
  // Sleeper's record string: one letter per gameweek since week 1
  club[m] = { name: nameOf[r.owner_id], pts: money(pf - lf), best: money(pp - lb), res: ((r.metadata && r.metadata.record) || "")[week - 1] };
}

const fixtures = rowsOf(await readFile(FIXTURES, "utf8")).filter((r) => +r[0] === week);
if (fixtures.length * 2 !== rosters.length) { console.error(`fixtures.csv has ${fixtures.length} games for GW${week}; expected ${rosters.length / 2}.`); process.exit(1); }
const out = [], problems = [];
for (const [, h, a] of fixtures) {
  const H = club[h.toLowerCase()], A = club[a.toLowerCase()];
  if (!H || !A) { problems.push(`unknown manager in ${h} v ${a}`); continue; }
  const want = (x, y) => (x.pts > y.pts ? "W" : x.pts < y.pts ? "L" : "T");
  if (want(H, A) !== H.res || want(A, H) !== A.res) problems.push(`${h} ${H.pts} v ${a} ${A.pts} doesn't match Sleeper's record (${H.res}/${A.res})`);
  if (H.pts < 0 || A.pts < 0 || H.best < H.pts || A.best < A.pts) problems.push(`odd numbers for ${h} v ${a}`);
  out.push([week, h, a, H.pts.toFixed(2), A.pts.toFixed(2), H.best.toFixed(2), A.best.toFixed(2)].join(","));
}
for (const l of out) console.log("  " + l);
if (problems.length) { console.error("Not writing anything:\n  " + problems.join("\n  ")); process.exit(1); }
if (DRY) { console.log(`(dry run) would add GW${week}`); process.exit(0); }
await writeFile(MATCHUPS, text.replace(/\s*$/, "\n") + out.join("\n") + "\n");
console.log(`Added GW${week} to matchups.csv. Next: node scripts/balance-home-away.mjs && node scripts/check-matchups.mjs`);
