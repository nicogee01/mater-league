#!/usr/bin/env node
/*
  Checks data/matchups.csv against Sleeper before it goes live.

    node scripts/check-matchups.mjs

  For every row it confirms:
    - both usernames are managers in the league and nobody plays twice in a week
    - the result (W/L/D) matches Sleeper's week-by-week record for BOTH teams
  Once every scored gameweek is in the file it also confirms each club's
  season points for / against (and, when filled in, best lineups vs Sleeper's
  "max points") match Sleeper to the cent.

  Exit code 1 if anything is wrong. Needs Node 18+ (built-in fetch).
*/
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LEAGUE_ID = "1390750210698780672";
const API = "https://api.sleeper.app/v1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const get = async (p) => {
  const r = await fetch(API + p);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
const money = (n) => Math.round(n * 100) / 100;

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift().split(",").map((h) => h.trim().toLowerCase());
  return lines.map((l, i) => ({ line: i + 2, ...Object.fromEntries(l.split(",").map((v, j) => [head[j], v.trim()])) }));
}

async function main() {
  const [league, users, rosters] = await Promise.all([
    get(`/league/${LEAGUE_ID}`), get(`/league/${LEAGUE_ID}/users`), get(`/league/${LEAGUE_ID}/rosters`),
  ]);
  const scored = league.settings.last_scored_leg;
  const start = league.settings.start_week || 1;
  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  const team = {};
  for (const r of rosters) {
    const u = userById[r.owner_id] || {};
    const s = r.settings;
    team[(u.display_name || "").toLowerCase()] = {
      user: u.display_name, name: (u.metadata && u.metadata.team_name) || `${u.display_name} FC`,
      record: (r.metadata && r.metadata.record) || "",
      pf: money((s.fpts || 0) + (s.fpts_decimal || 0) / 100),
      pa: money((s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100),
      pp: money((s.ppts || 0) + (s.ppts_decimal || 0) / 100),   // Sleeper "max points" = sum of best lineups
      sumFor: 0, sumAgainst: 0, sumBest: 0, bestRows: 0, weeks: new Set(),
    };
  }

  const rows = parseCSV(await readFile(join(root, "data", "matchups.csv"), "utf8"));
  const problems = [];
  const bad = (row, msg) => problems.push(`line ${row.line} (GW${row.week} ${row.home} v ${row.away}): ${msg}`);

  for (const row of rows) {
    const H = team[row.home.toLowerCase()], A = team[row.away.toLowerCase()];
    const wk = Number(row.week), hp = Number(row.home_pts), ap = Number(row.away_pts);
    if (!H) { bad(row, `unknown manager "${row.home}"`); continue; }
    if (!A) { bad(row, `unknown manager "${row.away}"`); continue; }
    if (!Number.isInteger(wk) || wk < 1) { bad(row, "week must be a whole number"); continue; }
    if (row.home_pts === "" || row.away_pts === "" || isNaN(hp) || isNaN(ap)) { bad(row, "missing or non-numeric score"); continue; }
    for (const [T, best, pts] of [[H, row.home_best, hp], [A, row.away_best, ap]]) {
      if (best !== "" && best !== undefined && (isNaN(+best) || +best < pts)) bad(row, `${T.user}'s best lineup (${best}) can't be lower than their score (${pts})`);
    }
    for (const T of [H, A]) {
      if (T.weeks.has(wk)) bad(row, `${T.user} already has a GW${wk} match`);
      T.weeks.add(wk);
    }
    if (wk > scored) { bad(row, `GW${wk} hasn't been scored by Sleeper yet (last scored: GW${scored})`); continue; }
    const res = (a, b) => (a > b ? "W" : a < b ? "L" : "T");
    for (const [T, mine, theirs] of [[H, hp, ap], [A, ap, hp]]) {
      const sleeper = T.record[wk - start];
      if (sleeper && sleeper !== res(mine, theirs)) bad(row, `${T.user} ${res(mine, theirs) === "W" ? "won" : "lost"} here, but Sleeper has a ${sleeper} for them in GW${wk}. Scores may be swapped or misheard.`);
      T.sumFor = money(T.sumFor + mine); T.sumAgainst = money(T.sumAgainst + theirs);
    }
    for (const [T, best] of [[H, row.home_best], [A, row.away_best]]) {
      if (best !== "" && best !== undefined && !isNaN(+best)) { T.sumBest = money(T.sumBest + +best); T.bestRows++; }
    }
  }

  // season totals only line up once every scored week is present
  const weeksIn = new Set(rows.map((r) => Number(r.week)));
  const complete = Array.from({ length: scored - start + 1 }, (_, i) => start + i).every((w) => weeksIn.has(w));
  if (complete) {
    for (const T of Object.values(team)) {
      if (Math.abs(T.sumFor - T.pf) > 0.011) problems.push(`${T.user}: points for add up to ${T.sumFor}, Sleeper says ${T.pf}`);
      if (Math.abs(T.sumAgainst - T.pa) > 0.011) problems.push(`${T.user}: points against add up to ${T.sumAgainst}, Sleeper says ${T.pa}`);
      // best lineups are optional, but when every week has one they must add up to Sleeper's max points
      if (T.bestRows === T.weeks.size && Math.abs(T.sumBest - T.pp) > 0.011) problems.push(`${T.user}: best lineups add up to ${T.sumBest}, Sleeper's max points is ${T.pp}`);
    }
  }

  const perWeek = {};
  rows.forEach((r) => (perWeek[r.week] = (perWeek[r.week] || 0) + 1));
  console.log(`matchups.csv: ${rows.length} match(es) across GW ${Object.keys(perWeek).sort((a, b) => a - b).map((w) => `${w} (${perWeek[w]})`).join(", ") || "none"}`);
  console.log(complete ? `All ${scored} scored gameweeks present: season totals checked.` : `Season totals checked once GW${start}–${scored} are all in.`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    problems.forEach((p) => console.log("  - " + p));
    process.exitCode = 1;
  } else console.log("All good.");
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
