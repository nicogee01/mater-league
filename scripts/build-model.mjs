#!/usr/bin/env node
/*
  Rest-of-season player values for the trade calculator (and the Player stats page).

    node scripts/build-model.mjs              # writes data/model.json
    node scripts/build-model.mjs --backtest   # how well weeks 1-3 predict the weeks after, vs plain points per game

  A GitHub Action runs it nightly. Every player at a Premier League club gets:

  1. rate  - expected fantasy points per game WHEN HE PLAYS, in this league's scoring. A blend of
             this season and last season (Sleeper has both), each half actual points and half
             "expected" points (goals and assists swapped for xG and xA, so luck washes out),
             pulled toward his position's typical starter while the sample is small.
  2. avail - chance he features in a given gameweek: how often he has played, times injury news.
             Injuries come from the official Fantasy Premier League data ("Expected back 7 Nov"),
             or from data/injury-overrides.csv when we know better ("unknown" -> mid-December).
  3. fixtures - each remaining gameweek's opponent difficulty (FPL's 2-5 rating). Easier games
             nudge the expectation up, harder ones down; defenders and keepers most (clean sheets).
  4. ros   - expected points for the rest of the season = sum over remaining gameweeks of
             avail x rate x fixture factor.
  Plus a boom/bust profile (spread, floor, ceiling of his weekly scores) and a hot/cold flag
  (goals well above or below xG).
*/
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LEAGUE_ID = "1390750210698780672";
const SPORT = "clubsoccer:epl";
const API = "https://api.sleeper.app/v1";
const FPL = "https://fantasy.premierleague.com/api";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "data", "model.json");
const OVERRIDES = join(root, "data", "injury-overrides.csv");
const BACKTEST = process.argv.includes("--backtest");
const SEASON_WEEKS = 38;

const get = async (url) => { const r = await fetch(url, { headers: { "user-agent": "mater-league-site" } }); if (!r.ok) throw new Error(`${url} → ${r.status}`); return r.json(); };
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };

// ---------------- load everything ----------------
const league = await get(`${API}/league/${LEAGUE_ID}`);
const scoring = league.scoring_settings;
const season = +league.season;
const lastScored = league.settings.last_scored_leg || 0;
const [players, boot, fixtures] = await Promise.all([get(`${API}/players/${SPORT}`), get(`${FPL}/bootstrap-static/`), get(`${FPL}/fixtures/`)]);
const weeksOf = (yr, n) => Promise.all(Array.from({ length: n }, (_, i) => get(`${API}/stats/${SPORT}/regular/${yr}/${i + 1}`).catch(() => ({}))));
const [cur, prev] = await Promise.all([weeksOf(season, lastScored), weeksOf(season - 1, SEASON_WEEKS)]);

// score one stat line in this league's scoring; "expected" swaps goals/assists for xG/xA
function score(line) {
  let pts = 0, ghost = 0, goalPts = 0, astPts = 0;
  for (const [k, v] of Object.entries(line || {})) {
    if (!k.startsWith("pos_") || scoring[k] === undefined || typeof v !== "number") continue;
    const p = v * scoring[k];
    pts += p;
    if (!/_(g|at|cs|cs90)$/.test(k)) ghost += p;
    if (/_g$/.test(k) && v) goalPts = scoring[k];
    if (/_at$/.test(k) && v) astPts = scoring[k];
  }
  // per-goal / per-assist value for his position, even in a game he didn't score
  const pre = Object.keys(line || {}).map((k) => k.match(/^pos_(gk|d|m|f)_/)).find(Boolean);
  const gv = pre ? scoring[`${pre[0]}g`] || 0 : 0, av = pre ? scoring[`${pre[0]}at`] || 0 : 0;
  const xpts = pts - gv * (line.g || 0) - av * (line.at || 0) + gv * (line.xg || 0) + av * (line.xa || 0);
  return { pts, ghost, xpts, min: line.min || 0, g: line.g || 0, xg: line.xg || 0 };
}
// every game a player featured in, per season
function gamesBy(weeks) {
  const out = {};
  weeks.forEach((wk, i) => {
    for (const [pid, line] of Object.entries(wk || {})) {
      if (!line || !(line.min > 0)) continue;
      (out[pid] ||= []).push({ week: i + 1, ...score(line) });
    }
  });
  return out;
}

// ---------------- FPL: injuries + fixtures, matched to Sleeper players ----------------
const teamAbbr = Object.fromEntries(boot.teams.map((t) => [t.id, t.short_name]));
const events = boot.events.map((e) => ({ id: e.id, deadline: new Date(e.deadline_time) }));
const gwForDate = (d) => (events.find((e) => e.deadline >= d) || { id: SEASON_WEEKS + 1 }).id;
const fplByKey = {};
for (const e of boot.elements) {
  const abbr = teamAbbr[e.team];
  for (const nm of new Set([e.second_name, e.web_name, `${e.first_name}${e.second_name}`])) (fplByKey[`${abbr}|${norm(nm)}`] ||= []).push(e);
}
function fplFor(p) {
  const abbr = p.team_abbr;
  const tries = [`${p.first_name}${p.last_name}`, p.last_name, p.full_name, (p.last_name || "").split(" ").pop()];
  for (const t of tries) { const hit = fplByKey[`${abbr}|${norm(t)}`]; if (hit && hit.length === 1) return hit[0]; }
  for (const t of tries) { const hit = fplByKey[`${abbr}|${norm(t)}`]; if (hit) return hit.find((e) => norm(e.first_name)[0] === norm(p.first_name)[0]) || null; }
  return null;
}
// "Expected back 7 Nov" -> the first gameweek after that date
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function returnGw(news, nextGw) {
  const m = /expected back (\d{1,2}) (\w{3})/i.exec(news || "");
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return null;
  const now = new Date();
  let d = new Date(Date.UTC(now.getUTCFullYear(), mon, +m[1]));
  if (d < now - 60 * 864e5) d = new Date(Date.UTC(now.getUTCFullYear() + 1, mon, +m[1]));
  return Math.max(nextGw, gwForDate(d));
}
const overrides = {};
if (existsSync(OVERRIDES)) {
  const lines = (await readFile(OVERRIDES, "utf8")).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  const head = lines.shift().split(",").map((h) => h.trim());
  for (const l of lines) {
    const c = l.split(","); const r = Object.fromEntries(head.map((h, i) => [h, (c[i] || "").trim()]));
    if (r.player) overrides[norm(r.player)] = { gw: +r.return_gw || null, note: r.note || "" };
  }
}
// difficulty of each club's remaining fixtures, by gameweek (a double gameweek = two entries)
const fixturesBy = {};
for (const f of fixtures) {
  if (!f.event || f.finished) continue;
  (fixturesBy[teamAbbr[f.team_h]] ||= []).push({ gw: f.event, opp: teamAbbr[f.team_a], home: true, d: f.team_h_difficulty });
  (fixturesBy[teamAbbr[f.team_a]] ||= []).push({ gw: f.event, opp: teamAbbr[f.team_h], home: false, d: f.team_a_difficulty });
}
const eplClubs = new Set(Object.values(teamAbbr));

// ---------------- the model ----------------
const POS = { GK: "GK", D: "DEF", M: "MID", F: "FWD" };
const posOf = (p) => POS[(p.fantasy_positions || [])[0]] || null;
function buildModel(curGames, prevGames, weeksPlayed, nextGw) {
  // each position's typical regular: the median points per game of players with 3+ appearances
  const baseline = {};
  for (const pos of Object.values(POS)) {
    const rates = Object.entries(curGames).filter(([pid, gs]) => gs.length >= 3 && players[pid] && posOf(players[pid]) === pos).map(([, gs]) => mean(gs.map((g) => g.pts)));
    baseline[pos] = pct(rates, 0.5) || 4;
  }
  const out = {};
  for (const [pid, p] of Object.entries(players)) {
    const pos = posOf(p);
    if (!pos || p.fantasy_positions.includes("DEF") || !eplClubs.has(p.team_abbr)) continue;
    const c = curGames[pid] || [], v = prevGames[pid] || [];
    if (!c.length && !v.length) continue;
    // how good when he plays: half actual, half expected (xG/xA), weighted by sample size, shrunk to his position's typical regular
    const XM = +(process.env.MX || 0.5), rateOf = (gs) => (1 - XM) * mean(gs.map((g) => g.pts)) + XM * mean(gs.map((g) => g.xpts));
    const K = +(process.env.MK || 3), wc = c.length, wp = Math.min(v.length, 30) * +(process.env.MP || 0.5);
    const rate = (wc * (wc ? rateOf(c) : 0) + wp * (wp ? rateOf(v) : 0) + K * baseline[pos]) / (wc + wp + K);
    // how often he plays when fit: this season if he has played, else last season, else a squad player's 50%
    const share = weeksPlayed && c.length ? Math.min(1, c.length / weeksPlayed) : v.length ? Math.min(0.9, v.length / SEASON_WEEKS) : 0.5;
    // injuries: override file > FPL "expected back" date > FPL chance of playing > Sleeper's status
    const fpl = fplFor(p);
    const ov = overrides[norm(p.full_name)] || overrides[norm(`${p.first_name}${p.last_name}`)];
    let back = null, note = "", nextChance = 1;
    if (ov) { back = ov.gw; note = ov.note || `Back GW${ov.gw}`; }
    else if (fpl && fpl.status !== "a" && fpl.status !== "u") {
      note = fpl.news || "";
      const ch = fpl.chance_of_playing_next_round;
      if (ch === 0) back = returnGw(fpl.news, nextGw) || nextGw + 5;   // out, date unknown: assume ~5 gameweeks
      else if (ch != null) nextChance = ch / 100;
    } else if (!fpl && /out|ir/i.test(p.injury_status || "")) { back = nextGw + 3; note = `Sleeper: ${p.injury_status}`; }
    if (fpl && fpl.status === "u") { back = SEASON_WEEKS + 1; note = fpl.news || "Unavailable"; }   // left the club / unavailable
    // rest of season, gameweek by gameweek
    const fx = (fixturesBy[p.team_abbr] || []).filter((f) => f.gw >= nextGw);
    const tilt = pos === "GK" || pos === "DEF" ? 0.08 : 0.06;
    let ros = 0;
    for (const f of fx) {
      const avail = back && f.gw < back ? 0 : share * (f.gw === nextGw ? nextChance : 1);
      ros += avail * rate * (1 + tilt * (3 - f.d));
    }
    const all = [...c, ...v].map((g) => g.pts);
    const goals = c.reduce((s, g) => s + g.g, 0), xg = c.reduce((s, g) => s + g.xg, 0);
    out[pid] = {
      rate: round(rate), share: round(share), ros: round(ros, 1), next5: fx.slice(0, 5).map((f) => [f.gw, f.opp, f.home ? 1 : 0, f.d]),
      back: back && back <= SEASON_WEEKS ? back : back ? 99 : null, note: note.slice(0, 80), chance: nextChance < 1 ? nextChance : undefined,
      sd: round(Math.sqrt(mean(all.map((x) => (x - mean(all)) ** 2)))), floor: round(pct(all, 0.1), 1), ceil: round(pct(all, 0.9), 1),
      prev: v.length ? round(mean(v.map((g) => g.pts))) : null, prevGp: v.length || undefined,
      hot: c.length >= 3 && goals - xg >= 1.5 ? 1 : c.length >= 3 && xg - goals >= 1.5 ? -1 : undefined,
    };
  }
  return { baseline, players: out };
}

if (BACKTEST) {
  // predict each player's points per game in weeks 4..lastScored using only weeks 1-3 (+ last season)
  const split = 3;
  const train = gamesBy(cur.slice(0, split)), test = gamesBy(cur.map((w, i) => (i >= split ? w : {})));
  const prevG = gamesBy(prev);
  const m = buildModel(train, prevG, split, split + 1).players;
  const errs = { model: [], naive: [], lastSeason: [] };
  for (const [pid, gs] of Object.entries(test)) {
    if (!m[pid] || !train[pid] || gs.length < 1) continue;
    const actual = mean(gs.map((g) => g.pts));
    errs.model.push(Math.abs(m[pid].rate - actual));
    errs.naive.push(Math.abs(mean(train[pid].map((g) => g.pts)) - actual));
    if (prevG[pid]) errs.lastSeason.push(Math.abs(mean(prevG[pid].map((g) => g.pts)) - actual));
  }
  console.log(`Backtest: weeks 1-${split} -> weeks ${split + 1}-${lastScored}, ${errs.model.length} players`);
  for (const [k, e] of Object.entries(errs)) console.log(`  ${k.padEnd(11)} average miss ${mean(e).toFixed(2)} pts/game (${e.length} players)`);
  process.exit(0);
}

const nextGw = lastScored + 1;
const { baseline, players: model } = buildModel(gamesBy(cur), gamesBy(prev), lastScored, nextGw);
await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString(), season, lastScored, nextGw, baseline, players: model }));
const n = Object.keys(model).length;
console.log(`data/model.json: ${n} players, next gameweek ${nextGw}, baselines ${JSON.stringify(baseline)}`);
