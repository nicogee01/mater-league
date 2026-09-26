#!/usr/bin/env node
/*
  Decides who is home and who is away in data/matchups.csv, and shuffles the order of each
  week's fixtures. Sleeper doesn't track home/away, so the site makes it up, fairly:

    node scripts/balance-home-away.mjs

  Week by week, the club with fewer home games so far (relative to its away games) is home.
  If that's level it avoids a third straight home or away game, and if that's level too it
  falls back to a coin flip seeded by the week and the two clubs, so it looks random but
  re-running the script always gives the same answer. Over a season every club stays within
  a game or two of an even home/away split.

  Only the order changes: each row's scores and best lineups travel with their club. Safe to
  run after adding a new gameweek; earlier weeks never change.
*/
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(root, "data", "matchups.csv");
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };

const text = await readFile(FILE, "utf8");
const lines = text.split(/\r?\n/).filter((l) => l.trim());
const head = lines.shift();
const cols = head.split(",").map((h) => h.trim().toLowerCase());
const at = (k) => cols.indexOf(k);
const rows = lines.map((l) => l.split(",").map((x) => x.trim()));
const weeks = [...new Set(rows.map((r) => +r[at("week")]))].sort((a, b) => a - b);

const tally = {};   // manager -> { home, away, last: [...recent venues] }
const T = (m) => (tally[m.toLowerCase()] ||= { home: 0, away: 0, last: [] });
const out = [];
for (const week of weeks) {
  const games = rows.filter((r) => +r[at("week")] === week);
  const decided = games.map((r) => {
    const a = r[at("home")], b = r[at("away")];
    const [x, y] = [a, b].sort((p, q) => p.toLowerCase().localeCompare(q.toLowerCase()));
    const tx = T(x), ty = T(y);
    const bal = (t) => t.home - t.away;
    const streak = (t, v) => t.last.length >= 2 && t.last.slice(-2).every((z) => z === v);
    let xHome;
    if (bal(tx) !== bal(ty)) xHome = bal(tx) < bal(ty);
    else if (streak(tx, "H") !== streak(ty, "H")) xHome = !streak(tx, "H");
    else if (streak(tx, "A") !== streak(ty, "A")) xHome = streak(tx, "A");
    else xHome = hash(`${week}|${x.toLowerCase()}|${y.toLowerCase()}`) % 2 === 0;
    const home = xHome ? x : y;
    // flip the row if needed so the home club (and its numbers) come first
    const row = [...r];
    if (home !== a) {
      for (const [p, q] of [["home", "away"], ["home_pts", "away_pts"], ["home_best", "away_best"]]) {
        if (at(p) < 0 || at(q) < 0) continue;
        [row[at(p)], row[at(q)]] = [r[at(q)], r[at(p)]];
      }
    }
    const H = T(row[at("home")]), A = T(row[at("away")]);
    H.home++; A.away++; H.last.push("H"); A.last.push("A");
    return row;
  });
  // shuffle the week's card order the same way every time
  decided.sort((p, q) => hash(`${week}|${p[at("home")].toLowerCase()}`) - hash(`${week}|${q[at("home")].toLowerCase()}`));
  out.push(...decided);
}

await writeFile(FILE, [head, ...out.map((r) => r.join(","))].join("\n") + "\n");
console.log("Home / away so far:");
for (const [m, t] of Object.entries(tally).sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${m.padEnd(14)} ${t.home} home, ${t.away} away   (${t.last.join("")})`);
