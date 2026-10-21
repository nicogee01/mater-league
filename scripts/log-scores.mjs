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

  Player points: the lineup snapshot can be taken while a match is still going, so every run also refreshes the
  points and minutes of every recorded player (data/lineups.csv) in every scored week from Sleeper's stats.

  Stat corrections: Sleeper sometimes corrects a player's stats days after a gameweek, which changes that
  club's score for an already-logged week. Left alone, the change would land in the next derived week instead.
  So every run first re-scores each logged week from its recorded starting XI (data/lineups.csv) with Sleeper's
  current stats; where a club's XI now adds up differently (by up to 10 points, and only if all 11 starters
  are recorded) the logged score and the players' points are corrected, but only when Sleeper's own season
  totals confirm it: with the corrections applied, every club's points for and points against must match
  Sleeper's (player stats sometimes move without the league's scores following). A result is never flipped.

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
const pending = scored > logged ? logged + 1 : null;   // the gameweek about to be derived, if any
const luWeeks = [...new Set(lu.map((r) => +r[0]))].filter((w) => w <= logged || w === pending);
const statWeeks = Object.fromEntries(await Promise.all(luWeeks.map(async (w) => [w, await get(`/stats/clubsoccer:epl/regular/${league.season}/${w}`).catch(() => null)])));
// a club's recorded XI for a week, re-scored with Sleeper's current stats (null without all 11 starters)
const xiNow = (w, who) => {
  const st = statWeeks[w], xi = lu.filter((x) => +x[0] === w && x[1].toLowerCase() === who.toLowerCase() && x[2] !== "BN");
  if (!st || xi.length !== 11) return null;
  const pts = xi.map((x) => ({ x, now: money(scoreLine(st[x[3]])) }));
  return { total: money(pts.reduce((t, y) => t + y.now, 0)), pts };
};
// candidates: logged scores whose XI now adds up differently
const cands = {};
for (const r of rows) {
  const w = +r[0];
  for (const [mi, pi] of [[1, 3], [2, 4]]) {
    const re = xiNow(w, r[mi]);
    if (!re) continue;
    const d = money(re.total - +r[pi]);
    if (Math.abs(d) < 0.001) continue;
    if (Math.abs(d) > 10) { console.log(`Warning: GW${w} ${r[mi]}'s XI adds up to ${re.total.toFixed(2)} but ${(+r[pi]).toFixed(2)} is logged; too big a gap for a stat correction, left alone.`); continue; }
    (cands[r[mi].toLowerCase()] ||= []).push({ r, w, who: r[mi], from: +r[pi], to: re.total, d, pi, pts: re.pts });
  }
}
// Sleeper's league totals have the final say: a set of corrections is accepted only if, once applied (and the
// pending gameweek derived from them), every club's points for AND points against match Sleeper's season
// totals. Player stats sometimes move without the league's scores following; those corrections never pass.
const nameById = Object.fromEntries(users.map((u) => [u.user_id, u.display_name]));
const ppf = {}, ppa = {};
for (const r of rosters) { const s = r.settings || {}, u = (nameById[r.owner_id] || "").toLowerCase(); ppf[u] = money((s.fpts || 0) + (s.fpts_decimal || 0) / 100); ppa[u] = money((s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100); }
const fixW = pending ? rowsOf(await readFile(FIXTURES, "utf8")).filter((r) => +r[0] === pending) : [];
const all = Object.values(cands).flat();
const passes = (sub) => {
  const pf = {}, pa = {};
  const add = (u, v, o) => { u = u.toLowerCase(); o = o.toLowerCase(); pf[u] = money((pf[u] || 0) + v); pa[o] = money((pa[o] || 0) + v); };
  for (const r of rows) {
    const h = (sub.find((f) => f.r === r && f.pi === 3) || {}).to ?? +r[3], aw = (sub.find((f) => f.r === r && f.pi === 4) || {}).to ?? +r[4];
    add(r[1], h, r[2]); add(r[2], aw, r[1]);
  }
  if (pending) for (const [, h, aw] of fixW) {
    const dh = money(ppf[h.toLowerCase()] - (pf[h.toLowerCase()] || 0)), da = money(ppf[aw.toLowerCase()] - (pf[aw.toLowerCase()] || 0));
    add(h, dh, aw); add(aw, da, h);
  }
  return Object.keys(ppf).every((u) => Math.abs((pf[u] || 0) - ppf[u]) < 0.005 && Math.abs((pa[u] || 0) - ppa[u]) < 0.005);
};
if (all.length && all.length <= 12) {
  const subsets = [...Array(1 << all.length).keys()].sort((x, y) => bits(y) - bits(x));
  const m = subsets.find((k) => passes(all.filter((_, i) => k & (1 << i))));
  const pick = m === undefined ? [] : all.filter((_, i) => m & (1 << i));
  for (const f of pick) fixes.push(f);
  const skipped = all.filter((f) => !pick.includes(f));
  if (skipped.length) console.log(`Not applied (Sleeper's league totals don't reflect them): ${skipped.map((f) => `GW${f.w} ${f.who} ${f.from.toFixed(2)} -> ${f.to.toFixed(2)}`).join(", ")}`);
} else if (all.length) console.log(`Warning: ${all.length} possible stat corrections; too many to check, none applied.`);
// every recorded player (XI and bench) in a scored week: points and minutes from Sleeper's current stats
for (const x of lu) {
  const w = +x[0], st = statWeeks[w];
  if (!st || w > scored) continue;
  const l = st[x[3]], now = money(scoreLine(l)), min = String((l && l.min) || 0);
  if (Math.abs(now - +x[5]) > 0.001 || (x[7] !== undefined && x[7] !== min)) luFixes.push({ x, now, min });
}
if (luFixes.length) console.log(`Player points refreshed from Sleeper: ${luFixes.length} lineup row(s), e.g. ${luFixes.slice(0, 3).map(({ x, now }) => `GW${x[0]} ${x[4]} ${x[5]} -> ${now}`).join(", ")}`);
function bits(m) { let n = 0; for (; m; m >>= 1) n += m & 1; return n; }
// best possible lineups: Sleeper's max-points total moves with a correction too. Where a club's logged best
// lineups plus its corrections add up to Sleeper's max points exactly, the same change goes on that week's best.
const ppts = {};
for (const r of rosters) { const s2 = r.settings || {}; ppts[(nameById[r.owner_id] || "").toLowerCase()] = money((s2.ppts || 0) + (s2.ppts_decimal || 0) / 100); }
const bestSum = {};
for (const r of rows) { bestSum[r[1].toLowerCase()] = money((bestSum[r[1].toLowerCase()] || 0) + +r[5]); bestSum[r[2].toLowerCase()] = money((bestSum[r[2].toLowerCase()] || 0) + +r[6]); }
const byClub = {};
for (const f of fixes) (byClub[f.who.toLowerCase()] ||= []).push(f);
for (const [who, list] of Object.entries(byClub)) {
  const d = money(list.reduce((t, f) => t + f.d, 0));
  if (pending || Math.abs(money(bestSum[who] + d) - ppts[who]) >= 0.005) continue;   // with a week pending, its best absorbs it
  for (const f of list) { const bi = f.pi + 2; f.bestFrom = +f.r[bi]; f.r[bi] = money(+f.r[bi] + f.d).toFixed(2); }
}
for (const f of fixes) {
  const [h, a] = [+f.r[3], +f.r[4]];
  const before = Math.sign(h - a);
  f.r[f.pi] = f.to.toFixed(2);
  if (Math.sign(+f.r[3] - +f.r[4]) !== before) { console.error(`Not writing anything: a stat correction would change the result of GW${f.w} ${f.r[1]} v ${f.r[2]}. Check it by hand.`); process.exit(1); }
  console.log(`Stat correction (confirmed by Sleeper's season totals): GW${f.w} ${f.who} ${f.from.toFixed(2)} -> ${f.to.toFixed(2)}${f.bestFrom != null ? ` (best lineup ${f.bestFrom.toFixed(2)} -> ${f.r[f.pi + 2]})` : ""}`);
}
const corrected = fixes.length > 0 || luFixes.length > 0;
const writeCorrections = async () => {
  if (!corrected) return;
  if (fixes.length) await writeFile(MATCHUPS, [head, ...rows.map((r) => r.join(","))].join("\n") + "\n");
  if (luFixes.length) {
    for (const { x, now, min } of luFixes) { x[5] = String(now); if (x[7] !== undefined) x[7] = min; }
    await writeFile(LINEUPS, [luHead, ...lu.map((x) => x.join(","))].join("\n") + "\n");
  }
};

if (scored <= logged) {
  if (corrected && !DRY) { await writeCorrections(); console.log(`Nothing new to log (Sleeper has scored GW${scored}), but corrections were written.${fixes.length ? " Next: node scripts/check-matchups.mjs" : ""}`); }
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
