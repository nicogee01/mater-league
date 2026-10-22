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
  3. fixtures - goals, assists and clean sheets are priced per fixture from club attack/defence
             ratings (goals scored and conceded, this season leaning on last), home or away, and the
             player's share of his club's goals and assists. Ghost points don't depend on the fixture.
  4. ros   - expected points for the rest of the season = sum over remaining gameweeks of
             avail x (ghost rate + that fixture's goal/assist/clean-sheet points).
  Plus a boom/bust profile (spread, floor, ceiling of his weekly scores) and a hot/cold flag
  (goals well above or below xG).
*/
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const applyFixes = async (players) => { try { const fx = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../data/player-fixes.json", import.meta.url), "utf8")); for (const [id, x] of Object.entries(fx)) if (!id.startsWith("_")) players[id] = { ...(players[id] || {}), ...x, player_id: id }; } catch (_) {} return players; };

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
const [players, boot, fixtures] = await Promise.all([get(`${API}/players/${SPORT}`).then(applyFixes), get(`${FPL}/bootstrap-static/`), get(`${FPL}/fixtures/`)]);
const weeksOf = (yr, n) => Promise.all(Array.from({ length: n }, (_, i) => get(`${API}/stats/${SPORT}/regular/${yr}/${i + 1}`).catch(() => ({}))));
const [cur, prev] = await Promise.all([weeksOf(season, lastScored), weeksOf(season - 1, SEASON_WEEKS)]);

// score one stat line in this league's scoring; "expected" swaps goals/assists for xG/xA
function score(line) {
  let pts = 0, ghost = 0, goalPts = 0, astPts = 0;
  for (const [k, v] of Object.entries(line || {})) {
    if (!k.startsWith("pos_") || scoring[k] === undefined || typeof v !== "number") continue;
    const p = v * scoring[k];
    pts += p;
    if (!/_(g|at|cs|cs90|og|yc|yc2|rc)$/.test(k)) ghost += p;
    if (/_g$/.test(k) && v) goalPts = scoring[k];
    if (/_at$/.test(k) && v) astPts = scoring[k];
  }
  // per-goal / per-assist value for his position, even in a game he didn't score
  const pre = Object.keys(line || {}).map((k) => k.match(/^pos_(gk|d|m|f)_/)).find(Boolean);
  const gv = pre ? scoring[`${pre[0]}g`] || 0 : 0, av = pre ? scoring[`${pre[0]}at`] || 0 : 0;
  const xpts = pts - gv * (line.g || 0) - av * (line.at || 0) + gv * (line.xg || 0) + av * (line.xa || 0);
  return { pts, ghost, xpts, min: line.min || 0, g: line.g || 0, xg: line.xg || 0, at: line.at || 0, xa: line.xa || 0 };
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

// each club's goals for and against, gameweek by gameweek (Sleeper's TEAM_<id> lines), keyed by club abbreviation
const abbrOfTeam = {};
for (const p of Object.values(players)) if (p && p.team && p.team_abbr) abbrOfTeam[p.team] = p.team_abbr;
function teamTable(weeks) {
  const out = {};
  weeks.forEach((wk, i) => {
    for (const [k, l] of Object.entries(wk || {})) {
      if (!k.startsWith("TEAM_") || !l || !l.gp) continue;
      const abbr = abbrOfTeam[k.slice(5)];
      if (abbr) (out[abbr] ||= {})[i + 1] = { gf: l.g || 0, ga: l.ga || 0 };
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
// typical points per game for a player new to the Premier League, by position (fitted on the 2024 and 2025
// seasons: their first six gameweeks vs the rest of the season; keepers had too few to fit)
const NEWCOMER = { GK: 5.5, DEF: 3.75, MID: 4.75, FWD: 5.25 };
const posOf = (p) => POS[(p.fantasy_positions || [])[0]] || null;
// Goals, assists and clean sheets come from the club: how many goals it should score in a given fixture, times the
// player's share of them, plus the chance it keeps a clean sheet (needs 60 minutes). Fitted on 2025/26 (586 cases):
// club ratings lean on last season for ~40 games; a player's share is pulled toward his position's typical share
// for ~35 games, with last season's games counting 1.5 each. Blended 75/25 with the plain points-based estimate.
const KT = 40, KS = 35, MPS = 1.5, BLEND = 0.75, HOME = 1.12, AWAY = 0.88;
const PRE = { GK: "pos_gk_", DEF: "pos_d_", MID: "pos_m_", FWD: "pos_f_" };
function buildModel(curGames, prevGames, weeksPlayed, nextGw, curTeams, prevTeams) {
  // club attack / defence: goals scored and conceded per game, this season leaning on last season
  const flat = (T, k) => Object.values(T).flatMap((t) => Object.values(t).map((x) => x[k]));
  const lgPrev = mean(flat(prevTeams, "gf")) || 1.4, lg = mean(flat(curTeams, "gf")) || lgPrev;
  const teams = {};
  for (const abbr of eplClubs) {
    const e = Object.values(curTeams[abbr] || {}), p = Object.values(prevTeams[abbr] || {});
    const pf = p.length ? mean(p.map((x) => x.gf)) : 0.8 * lgPrev, pa = p.length ? mean(p.map((x) => x.ga)) : 1.25 * lgPrev;   // promoted: weaker
    teams[abbr] = { att: (e.length * mean(e.map((x) => x.gf)) + KT * pf) / (e.length + KT), def: (e.length * mean(e.map((x) => x.ga)) + KT * pa) / (e.length + KT) };
  }
  // a position's typical share of its club's goals and assists (last season's regulars)
  const typ = {};
  for (const pos of Object.values(POS)) {
    const regs = Object.entries(prevGames).filter(([pid, gs]) => gs.length >= 10 && players[pid] && posOf(players[pid]) === pos).map(([, gs]) => gs);
    typ[pos] = { g: mean(regs.map((gs) => mean(gs.map((x) => x.g)) / lgPrev)), at: mean(regs.map((gs) => mean(gs.map((x) => x.at)) / lgPrev)) };
  }
  // each position's typical regular: the median points per game of players with 3+ appearances
  const baseline = {}, ghostBase = {};
  for (const pos of Object.values(POS)) {
    const rates = Object.entries(curGames).filter(([pid, gs]) => gs.length >= 3 && players[pid] && posOf(players[pid]) === pos).map(([, gs]) => mean(gs.map((g) => g.pts)));
    baseline[pos] = pct(rates, 0.5) || 4;
    // how much of a typical regular's points are ghost points (everything but goals, assists, clean sheets, own goals and cards (yellow or red))
    const regs = Object.entries(curGames).filter(([pid, gs]) => gs.length >= 3 && players[pid] && posOf(players[pid]) === pos);
    const gshare = mean(regs.map(([, gs]) => mean(gs.map((g) => g.ghost)))) / (mean(regs.map(([, gs]) => mean(gs.map((g) => g.pts)))) || 1);
    ghostBase[pos] = Math.min(0.9, Math.max(0.3, gshare || 0.6));
  }
  const out = {};
  for (const [pid, p] of Object.entries(players)) {
    const pos = posOf(p);
    if (!pos || p.fantasy_positions.includes("DEF") || !eplClubs.has(p.team_abbr)) continue;
    const c = curGames[pid] || [], v = prevGames[pid] || [];
    if (!c.length && !v.length) continue;
    // how good when he plays. This season: half actual points, half expected (goals and assists swapped for
    // xG and xA). Last season: actual points (Sleeper's older seasons have no xG). Small samples are pulled
    // toward a typical level: his position's regular for established players (3 games' worth), or, for players
    // new to the league, the newcomer level measured from the 2024 and 2025 seasons (9 games' worth).
    // Points are split in two and each part is estimated on its own:
    //  - ghost points (everything but goals, assists, clean sheets, own goals and cards (yellow or red)) are steady, so they need few games
    //    to trust (KG pretend games at a typical level);
    //  - goal / assist / clean-sheet points are swingy, so this season's come mostly from his chances
    //    (xG and xA, weight XM) and they're pulled toward a typical level for much longer (KA pretend games).
    const XM = +(process.env.MX || 0.75);
    const curGhost = (gs) => mean(gs.map((g) => g.ghost));
    const curGA = (gs) => (1 - XM) * mean(gs.map((g) => g.pts - g.ghost)) + XM * mean(gs.map((g) => g.xpts - g.ghost));
    const wc = c.length, wp = Math.min(v.length, 30) * +(process.env.MP || 0.3);
    const newcomer = !v.length;
    // fitted on 2024-25 (1,706 cases): ghost points are worth trusting after ~2 games, goals/assists/clean
    // sheets only after ~25; newcomers lean harder on the newcomer level for ghost points too
    const KG = newcomer ? 6 : +(process.env.KG || 2), KA = newcomer ? 30 : +(process.env.KA || 25);
    const prior = newcomer ? NEWCOMER[pos] : baseline[pos], pg = prior * ghostBase[pos], pa = prior * (1 - ghostBase[pos]);
    const ghostRate = (wc * (wc ? curGhost(c) : 0) + wp * (wp ? mean(v.map((g) => g.ghost)) : 0) + KG * pg) / (wc + wp + KG);
    const gaRate = (wc * (wc ? curGA(c) : 0) + wp * (wp ? mean(v.map((g) => g.pts - g.ghost)) : 0) + KA * pa) / (wc + wp + KA);
    // his share of the club's goals and assists: this season from his chances (75% xG/xA, 25% actual) over the club's
    // goals in games he played; last season from actual goals (over his club's goals if he stayed, else a typical club's)
    const T = teams[p.team_abbr] || { att: lg, def: lg };
    const stayed = (p.team_changed_at || 0) < Date.UTC(season - 1, 6, 15);
    const share2 = (k, xk) => {
      const cg = c.reduce((s, g) => s + (((curTeams[p.team_abbr] || {})[g.week] || {}).gf || 0), 0);
      const cs = cg ? ((1 - XM) * c.reduce((s, g) => s + g[k], 0) + XM * c.reduce((s, g) => s + g[xk], 0)) / cg : 0;
      const pgf = stayed && prevTeams[p.team_abbr] ? mean(Object.values(prevTeams[p.team_abbr]).map((x) => x.gf)) : lgPrev;
      const ps = v.length ? mean(v.map((g) => g[k])) / (pgf || lgPrev) : 0;
      const wcs = cg ? c.length : 0, wps = Math.min(v.length, 30) * MPS;
      return (wcs * cs + wps * ps + KS * typ[pos][k]) / (wcs + wps + KS);
    };
    const gS = share2("g", "xg"), aS = share2("at", "xa");
    const sixty = c.length ? c : v, p60 = sixty.length ? sixty.filter((g) => g.min >= 60).length / sixty.length : 0.7;
    const gv = scoring[PRE[pos] + "g"] || 0, av = scoring[PRE[pos] + "at"] || 0, cv = scoring[PRE[pos] + "cs"] || 0;
    // goal / assist / clean-sheet points in a fixture: club's expected goals x his share, plus clean-sheet chance
    const gaFix = (forG, against) => BLEND * (forG * (gS * gv + aS * av) + Math.exp(-against) * cv * p60) + (1 - BLEND) * gaRate;
    const rate = ghostRate + gaFix(T.att, T.def);
    // how often he plays, from his recent gameweeks: the last four (fewer if he only arrived lately; weeks
    // before his first appearance don't count against him). No games this season: last season's rate.
    let share;
    if (weeksPlayed && c.length) {
      const debut = Math.min(...c.map((g) => g.week));
      const from = Math.max(debut, weeksPlayed - 3);
      share = c.filter((g) => g.week >= from).length / (weeksPlayed - from + 1);
    } else share = v.length ? Math.min(0.9, v.length / SEASON_WEEKS) : 0.5;
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
    let ros = 0;
    const w = Array(Math.max(0, SEASON_WEEKS - nextGw + 1)).fill(0);   // expected points in each remaining gameweek (the trade calculator picks XIs from these)
    for (const f of fx) {
      const avail = back && f.gw < back ? 0 : share * (f.gw === nextGw ? nextChance : 1);
      const O = teams[f.opp] || { att: lg, def: lg }, h = f.home ? HOME : AWAY;
      const e = avail * (ghostRate + gaFix((T.att * O.def) / lg * h, (O.att * T.def) / lg * (f.home ? AWAY : HOME)));
      ros += e;
      if (f.gw - nextGw < w.length) w[f.gw - nextGw] += e;
    }
    const all = [...c, ...v].map((g) => g.pts);
    const goals = c.reduce((s, g) => s + g.g, 0), xg = c.reduce((s, g) => s + g.xg, 0);
    out[pid] = {
      rate: round(rate), ghost: round(ghostRate), gs: round(gS, 3), as: round(aS, 3), share: round(share), ros: round(ros, 1), w: w.map((x) => round(x, 1)), pos: posOf(p), ps: (p.fantasy_positions || []).filter((x) => x !== "DEF"), next5: fx.slice(0, 5).map((f) => [f.gw, f.opp, f.home ? 1 : 0, f.d]),
      back: back && back <= SEASON_WEEKS ? back : back ? 99 : null, note: note.slice(0, 80), chance: nextChance < 1 ? nextChance : undefined,
      sd: round(Math.sqrt(mean(all.map((x) => (x - mean(all)) ** 2)))), floor: round(pct(all, 0.1), 1), ceil: round(pct(all, 0.9), 1),
      prev: v.length ? round(mean(v.map((g) => g.pts))) : null, prevGp: v.length || undefined,
      hot: c.length >= 3 && goals - xg >= 1.5 ? 1 : c.length >= 3 && xg - goals >= 1.5 ? -1 : undefined,
    };
  }
  return { baseline, teams: Object.fromEntries(Object.entries(teams).map(([k, t]) => [k, { att: round(t.att), def: round(t.def) }])), players: out };
}

if (BACKTEST) {
  // predict each player's points per game in weeks 4..lastScored using only weeks 1-3 (+ last season)
  const split = +(process.env.SPLIT || 3);
  const train = gamesBy(cur.slice(0, split)), test = gamesBy(cur.map((w, i) => (i >= split ? w : {})));
  const prevG = gamesBy(prev);
  const m = buildModel(train, prevG, split, split + 1, teamTable(cur.slice(0, split)), teamTable(prev)).players;
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

// ---------------- trade value: what a player adds to a real lineup ----------------
// Raw points can't compare a midfielder with a defender: what matters is how much better a club's best XI gets.
// For every club in the league (other than his own) we add him to its squad, plus the best two free agents at each
// position, pick the best legal XI every remaining gameweek (same rules as the trade calculator: 1 GK, 3+ D, 3+ M,
// 1+ F, FM / MD / FMD flex spots) and measure the gain. His trade value is the average gain over those clubs.
// That prices position scarcity and flexibility directly: a forward/midfielder fills whichever line is weaker.
const FORMS = [];
for (let d = 3; d <= 5; d++) for (let m = 3; m <= 6; m++) for (let f = 1; f <= 3; f++) { const ed = d - 3, ef = f - 1; if (d + m + f === 10 && ed <= 2 && ef <= 2 && ed + ef <= 3) FORMS.push({ DEF: d, MID: m, FWD: f }); }
const PS = { D: "DEF", M: "MID", F: "FWD", GK: "GK" };
function xiTotal(pool, wk) {
  const ps = pool.map((m) => ({ v: m.w[wk] || 0, ps: m.ps.map((q) => PS[q]).filter(Boolean) })).sort((a, b) => b.v - a.v);
  let best = 0;
  for (const form of FORMS) {
    const room = { GK: 1, ...form }; let t = 0;
    for (const p of ps) { const slot = p.ps.filter((q) => room[q] > 0).sort((a, b) => room[b] - room[a])[0]; if (slot) { room[slot]--; t += p.v; } }
    if (t > best) best = t;
  }
  return best;
}
const seasonValue = (pool) => { let t = 0; const n = pool.length ? pool[0].w.length : 0; for (let w = 0; w < n; w++) t += xiTotal(pool, w); return t; };
function tradeValues(model, rosters) {
  const owner = {}; for (const r of rosters) for (const pid of r.players || []) owner[pid] = r.roster_id;
  const fa = ["GK", "DEF", "MID", "FWD"].flatMap((pos) => Object.entries(model).filter(([pid, m]) => !owner[pid] && m.pos === pos).sort((a, b) => b[1].ros - a[1].ros).slice(0, 2).map(([pid]) => pid));
  const clubs = rosters.map((r) => { const pids = [...(r.players || []), ...fa].filter((pid) => model[pid]); return { id: r.roster_id, pids, base: seasonValue(pids.map((pid) => model[pid])) }; });
  for (const [pid, m] of Object.entries(model)) {
    if (m.ros < 15) { m.tv = 0; continue; }
    const gains = clubs.filter((c) => c.id !== owner[pid]).map((c) => (c.pids.includes(pid) ? 0 : seasonValue([...c.pids.filter((x) => x !== pid), pid].map((x) => model[x])) - c.base));
    m.tv = round(mean(gains), 1);
  }
}

const nextGw = lastScored + 1;
const { baseline, teams, players: model } = buildModel(gamesBy(cur), gamesBy(prev), lastScored, nextGw, teamTable(cur), teamTable(prev));
tradeValues(model, await get(`${API}/league/${LEAGUE_ID}/rosters`));
await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString(), season, lastScored, nextGw, baseline, teams, players: model }));
const n = Object.keys(model).length;
console.log(`data/model.json: ${n} players, next gameweek ${nextGw}, baselines ${JSON.stringify(baseline)}`);
