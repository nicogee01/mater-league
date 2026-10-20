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

  Stat corrections: Sleeper sometimes corrects a player's stats days after a gameweek, which changes that
  club's score for an already-logged week. Left alone, the change would land in the next derived week instead.
  So every run first re-scores each logged week from its recorded starting XI (data/lineups.csv) with Sleeper's
  current stats; where a club's XI now adds up differently (by up to 10 points, and only if all 11 starters
  are recorded) the logged score and the players' points are corrected, as long as the result doesn't flip.

    node scripts/log-scores.mjs --dry-run  # also shows any corrections it would make
*/
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LEAGUE_ID = "1390750210698780672";
const API = "https://api.sleeper.app/v1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MATCHUPS = join(root, "data", "matchups.csv"), FIXTURES = join(root, "data", "fixtures.csv"), LINEUPS = join(root, "data", "lineups.csv");
const DRY = process.argv.includes("--dry-run");
const get = async (p) => { const r = await fetch(API + p); if (!r.ok) throw new Error(`${p} → ${r.status}`); return r.json(); };
const money = (n) => Math.round(n * 100) / 100;
const rowsOf = (text) => text.split(/\r?\n/).filter((l) => l.trim()).slice(1).map((l) => l.split(",").map((x) => x.trim()));

const [league, users, rosters] = await Promise.all([get(`/league/${LEAGUE_ID}`), get(`/league/${LEAGUE_ID}/users`), get(`/league/${LEAGUE_ID}/rosters`)]);
const scored = league.settings.last_scored_leg || 0;
const text = await readFile(MATCHUPS, "utf8");
const head = text.split(/\r?\n/)[0];
const rows = rowsOf(text);
const logged = rows.length ? Math.max(...rows.map((r) => +r[0])) : 0;

// ---- stat corrections: re-score logged weeks from their recorded XIs ----
const scoring = league.scoring_settings;
const scoreLine = (l) => Object.entries(l || {}).reduce((t, [k, v]) => t + (k.startsWith("pos_") && scoring[k] !== undefined && typeof v === "number" ? v * scoring[k] : 0), 0);
const luText = await readFile(LINEUPS, "utf8").catch(() => "");
const luHead = luText.split(/\r?\n/)[0];
const lu = rowsOf(luText);   // week,manager,slot,player_id,player,pts,proj,min
const fixes = [], luFixes = [];
const luWeeks = [...new Set(lu.map((r) => +r[0]))].filter((w) => w <= logged);
const statWeeks = Object.fromEntries(await Promise.all(luWeeks.map(async (w) => [w, await get(`/stats/clubsoccer:epl/regular/${league.season}/${w}`).catch(() => null)])));
for (const r of rows) {
  const w = +r[0], st = statWeeks[w];
  if (!st) continue;
  for (const [mi, pi] of [[1, 3], [2, 4]]) {
    const xi = lu.filter((x) => +x[0] === w && x[1].toLowerCase() === r[mi].toLowerCase() && x[2] !== "BN");
    if (xi.length !== 11) continue;
    let total = 0;
    for (const x of xi) {
      const now = money(scoreLine(st[x[3]]));
      total += now;
      if (Math.abs(now - +x[5]) > 0.001) luFixes.push({ x, now });
    }
    total = money(total);
    const d = money(total - +r[pi]);
    if (Math.abs(d) < 0.001) continue;
    if (Math.abs(d) > 10) { console.log(`Warning: GW${w} ${r[mi]}'s XI adds up to ${total.toFixed(2)} but ${(+r[pi]).toFixed(2)} is logged; too big a gap for a stat correction, left alone.`); continue; }
    fixes.push({ r, w, who: r[mi], from: +r[pi], to: total, pi });
  }
}
for (const f of fixes) {
  const [h, a] = [+f.r[3], +f.r[4]];
  const before = Math.sign(h - a);
  f.r[f.pi] = f.to.toFixed(2);
  if (Math.sign(+f.r[3] - +f.r[4]) !== before) { console.error(`Not writing anything: a stat correction would change the result of GW${f.w} ${f.r[1]} v ${f.r[2]}. Check it by hand.`); process.exit(1); }
  console.log(`Stat correction: GW${f.w} ${f.who} ${f.from.toFixed(2)} -> ${f.to.toFixed(2)}`);
}
const corrected = fixes.length > 0;
const writeCorrections = async () => {
  if (!corrected) return;
  await writeFile(MATCHUPS, [head, ...rows.map((r) => r.join(","))].join("\n") + "\n");
  if (luFixes.length) {
    for (const { x, now } of luFixes) x[5] = String(now);
    await writeFile(LINEUPS, [luHead, ...lu.map((x) => x.join(","))].join("\n") + "\n");
  }
};

if (scored <= logged) {
  if (corrected && !DRY) { await writeCorrections(); console.log(`Nothing new to log (Sleeper has scored GW${scored}), but stat corrections were written. Next: node scripts/check-matchups.mjs`); }
  else console.log(`Nothing new: Sleeper has scored GW${scored}, matchups.csv has GW${logged}.${corrected ? " (dry run: corrections not written)" : ""}`);
  process.exit(0);
}
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
await writeCorrections();
await writeFile(MATCHUPS, [head, ...rows.map((r) => r.join(",")), ...out].join("\n") + "\n");
console.log(`Added GW${week} to matchups.csv. Next: node scripts/balance-home-away.mjs && node scripts/check-matchups.mjs`);
