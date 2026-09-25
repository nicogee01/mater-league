/* =========================================================
   The Mater League — live data from the Sleeper API,
   plus match results from data/matchups.csv + data/cup.csv
   ========================================================= */
(function () {
  const LEAGUE_ID = "1390750210698780672";
  const SPORT = "clubsoccer:epl";
  const API = "https://api.sleeper.app/v1";
  const PLAYOFF_SPOTS = 6;
  const PLAYER_CACHE_KEY = "nym-players-v2";
  const PLAYER_CACHE_TTL = 12 * 60 * 60 * 1000;
  const PHOTO_CACHE = "nym-photo-";
  const LORE = window.MATER_LEAGUE || {};

  // categorical order validated for dark surfaces (CVD-safe adjacent pairs); colour follows roster ID
  const SERIES = ["#00a35a", "#9460c9", "#b8860b", "#4a78d0", "#d0601c", "#1592b0", "#d6246f", "#8c8c2a"];

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // scores move in quarter-points, so keep up to two decimals (541.0, 79.75); d = 0 rounds to whole numbers
  const num = (n, d = 1) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d === 0 ? 0 : Math.max(d, 2) });
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = {
    league: null, teams: [], byRoster: {}, players: {}, txns: [], week: 0,
    results: [], hasResults: false, derbies: [], projections: {}, seasonPts: {}, rankHistory: null, cupLevels: [],
  };

  // ---------- fetch helpers ----------
  async function get(path) {
    const r = await fetch(API + path);
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  }

  // Players file is ~2 MB; keep a trimmed copy for 12h so repeat visits are instant.
  async function loadPlayers() {
    try {
      const cached = JSON.parse(localStorage.getItem(PLAYER_CACHE_KEY) || "null");
      if (cached && Date.now() - cached.t < PLAYER_CACHE_TTL) return cached.p;
    } catch (_) {}
    const raw = await get(`/players/${SPORT}`);
    const p = {};
    for (const [id, x] of Object.entries(raw)) {
      p[id] = {
        n: x.full_name || [x.first_name, x.last_name].filter(Boolean).join(" ") || "Unknown",
        l: x.last_name || x.full_name || "",
        c: x.team_abbr || "",
        p: (x.fantasy_positions && x.fantasy_positions[0]) || x.position || "",
        ps: x.fantasy_positions || [],
        t: x.team || "",
        i: x.injury_status || "",
      };
    }
    try { localStorage.setItem(PLAYER_CACHE_KEY, JSON.stringify({ t: Date.now(), p })); } catch (_) {}
    return p;
  }

  // Season points + per-90 projection for every player, from weekly Sleeper stats and league scoring.
  // Per-90 needs at least 90 minutes played, otherwise a 5-minute cameo would project absurdly high.
  function buildProjections(statsByWeek, scoring) {
    const agg = {};
    for (const week of statsByWeek) {
      for (const [pid, line] of Object.entries(week || {})) {
        let pts = 0;
        for (const [k, v] of Object.entries(line)) if (k.startsWith("pos_") && scoring[k] !== undefined) pts += Number(v) * Number(scoring[k]);
        const a = (agg[pid] ||= { pts: 0, min: 0, gp: 0 });
        a.pts += pts; a.min += Number(line.min) || 0; a.gp += 1;
      }
    }
    const proj = {}, season = {};
    for (const [pid, a] of Object.entries(agg)) {
      season[pid] = a.pts;
      proj[pid] = a.min >= 90 ? { v: (a.pts / a.min) * 90, per90: true } : { v: a.pts / a.gp, per90: false };
    }
    return { proj, season };
  }

  // Wikipedia headshots, cached (hits for 30 days, misses for 3)
  async function playerPhoto(name) {
    const key = PHOTO_CACHE + name;
    try {
      const c = JSON.parse(localStorage.getItem(key) || "null");
      if (c && Date.now() - c.t < (c.u ? 30 : 3) * 864e5) return c.u;
    } catch (_) {}
    let url = null;
    try {
      const s = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name + " footballer")}&srlimit=1&format=json&origin=*`).then((r) => r.json());
      const title = s.query && s.query.search && s.query.search[0] && s.query.search[0].title;
      if (title) {
        const sum = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`).then((r) => (r.ok ? r.json() : null));
        url = (sum && sum.thumbnail && sum.thumbnail.source) || null;
      }
    } catch (_) { return null; }
    try { localStorage.setItem(key, JSON.stringify({ u: url, t: Date.now() })); } catch (_) {}
    return url;
  }
  const sleeperHeadshot = (pid) => `https://sleepercdn.com/content/clubsoccer/players/${pid}.jpg`;
  const clubLogo = (teamId) => (teamId ? `<img class="club-logo" src="https://sleepercdn.com/images/team_logos/clubsoccer/${esc(teamId)}.png" alt="" width="16" height="16" loading="lazy" onerror="this.remove()">` : "");
  const loadImage = (url) => new Promise((res) => { const img = new Image(); img.onload = () => res(true); img.onerror = () => res(false); img.src = url; });
  // Sleeper's headshot first; fall back to Wikipedia (a few lookups at a time) for the handful Sleeper lacks
  async function loadPhotos(pids, root) {
    const queue = [...pids];
    const paint = (pid, url) => $$(`[data-photo="${pid}"]`, root).forEach((el) => { el.style.backgroundImage = `url("${url}")`; el.classList.add("has-photo"); });
    const worker = async () => {
      while (queue.length) {
        const pid = queue.shift();
        const p = state.players[pid];
        if (!p || !root.isConnected) continue;
        if (await loadImage(sleeperHeadshot(pid))) { paint(pid, sleeperHeadshot(pid)); continue; }
        const url = await playerPhoto(p.n);
        if (url && root.isConnected && (await loadImage(url))) paint(pid, url);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  // ---------- club identity ----------
  // classic kit pairs (both dark enough for white text on the banner gradient)
  const KITS = [
    ["#0b1f3a", "#c8102e"], ["#670e36", "#2a6db0"], ["#034694", "#0b1f3a"], ["#1b5e3b", "#9a7a34"],
    ["#8b0d1a", "#1a1a1a"], ["#132257", "#5a6f9c"], ["#7a263a", "#b08a3e"], ["#274488", "#c8102e"],
  ];
  function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
  function initials(name) {
    const words = String(name).replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
  }
  function crestSVG(t) {
    const [a, b] = t.kit;
    return `<svg viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" fill="${a}"/>
      <path d="M0 64 L64 0 L64 22 L22 64 Z" fill="${b}" opacity="0.9"/>
      <circle cx="32" cy="32" r="21" fill="rgba(14,0,19,0.78)" stroke="#fff" stroke-width="2"/>
      <text x="32" y="39" text-anchor="middle" font-family="Anton, Impact, sans-serif" font-size="20" fill="#fff">${esc(initials(t.name))}</text>
    </svg>`;
  }
  function crest(t, size = "") {
    const cls = `crest ${size ? "crest--" + size : ""}`;
    if (!t) return `<span class="${cls}"></span>`;
    if (t.logo) return `<span class="${cls}"><img src="${esc(t.logo)}" alt="" loading="lazy" width="96" height="96" data-fallback="${t.rosterId}"></span>`;
    return `<span class="${cls}">${crestSVG(t)}</span>`;
  }
  // swap broken logo images for the generated crest
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img.tagName === "IMG" && img.dataset.fallback) {
      const t = state.byRoster[img.dataset.fallback];
      if (t) img.parentElement.innerHTML = crestSVG(t);
    }
  }, true);
  const teamName = (id) => (state.byRoster[id] ? state.byRoster[id].name : "TBD");
  // power-rankings emblem: crown for No. 1, poo for last, from the latest public round
  const EMBLEM = { top: ["\u{1F451}", "No. 1 in the power rankings"], bottom: ["\u{1F4A9}", "Last in the power rankings"] };
  const emblem = (t) => {
    const e = t && t.prTag && EMBLEM[t.prTag];
    return e ? `<span class="pr-emblem pr-emblem--${t.prTag}" role="img" aria-label="${e[1]}" title="${e[1]} (Gameweek ${state.prEmblemWeek})">${e[0]}</span>` : "";
  };
  const club = (t) => (t ? esc(t.name) + emblem(t) : "TBD");           // club name as HTML, with emblem
  const clubById = (id) => club(state.byRoster[id]);
  // "Supports <badge> Chelsea" from data/league.js (favourite Premier League club)
  const EPL_ABBR = { "Arsenal": "ARS", "Aston Villa": "AVL", "Bournemouth": "BOU", "Brentford": "BRE", "Brighton": "BHA", "Chelsea": "CHE",
    "Crystal Palace": "CRY", "Everton": "EVE", "Fulham": "FUL", "Liverpool": "LIV", "Manchester City": "MCI", "Manchester United": "MUN",
    "Newcastle": "NEW", "Nottingham Forest": "NFO", "Spurs": "TOT", "Tottenham": "TOT", "West Ham": "WHU", "Wolves": "WOL",
    "Leeds": "LEE", "Burnley": "BUR", "Sunderland": "SUN", "Hull": "HUL", "Ipswich": "IPS" };
  function supports(t) {
    const fav = ((window.MATER_LEAGUE && window.MATER_LEAGUE.favourites) || {})[t.manager.toLowerCase()];
    if (!fav) return "";
    const abbr = EPL_ABBR[fav];
    const p = abbr && Object.values(state.players).find((x) => x.c === abbr && x.t);
    return `<span class="badge badge--fav">${p ? clubLogo(p.t) : ""}Supports ${esc(fav)}</span>`;
  }
  const clubText = (t) => t.name + (t.prTag ? " " + EMBLEM[t.prTag][0] : ""); // plain text (dropdowns)

  // ---------- build model ----------
  function buildTeams(users, rosters) {
    const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
    return rosters.map((r) => {
      const u = userById[r.owner_id] || {};
      const md = u.metadata || {};
      const s = r.settings || {};
      const manager = u.display_name || "Vacant";
      const name = md.team_name || `${manager} FC`;
      const logo = md.avatar || (u.avatar ? `https://sleepercdn.com/avatars/thumbs/${u.avatar}` : "");
      return {
        rosterId: r.roster_id,
        color: SERIES[(r.roster_id - 1) % SERIES.length],
        name, manager, logo,
        kit: KITS[hash(name) % KITS.length],
        w: s.wins || 0, l: s.losses || 0, d: s.ties || 0,
        pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
        pa: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
        pp: (s.ppts || 0) + (s.ppts_decimal || 0) / 100,
        faabUsed: s.waiver_budget_used || 0,
        record: (r.metadata && r.metadata.record) || "",
        streak: (r.metadata && r.metadata.streak) || "",
        starters: (r.starters || []).filter((id) => id && id !== "0"),
        slots: r.starters || [],
        formations: parseFormations(r.metadata && r.metadata.formation),
        players: r.players || [],
        reserve: r.reserve || [],
      };
    });
  }

  // roster metadata stores {"gameweek": "D-M-F"} for each week the manager changed shape
  function parseFormations(raw) {
    try {
      const obj = typeof raw === "string" ? JSON.parse(raw) : raw || {};
      return Object.entries(obj).map(([wk, f]) => ({ wk: +wk, f: String(f) })).filter((x) => /^\d-\d-\d$/.test(x.f)).sort((a, b) => a.wk - b.wk);
    } catch (_) { return []; }
  }
  // the formation in force for a week is the latest one set on or before it
  const formationFor = (t, week) => [...t.formations].reverse().find((x) => x.wk <= week) || t.formations[0] || null;

  // Put the XI on the lines the way Sleeper does: fixed slots stay put, flex slots
  // fill whatever the chosen formation still needs, preferring the player's own position.
  const FLEX = { FM_FLEX: ["F", "M"], MD_FLEX: ["M", "D"], FMD_FLEX: ["F", "M", "D"] };
  function lineUp(t, formation) {
    const lines = { GK: [], D: [], M: [], F: [] };
    const pl = (pid) => state.players[pid] || { n: `Player ${pid}`, l: pid, c: "", p: "", ps: [], i: "" };
    const slotNames = ((state.league && state.league.roster_positions) || []).filter((s) => s !== "BN" && s !== "IR");
    if (!formation || !slotNames.length) {
      t.starters.forEach((pid) => { const p = pl(pid); (lines[p.p] || lines.M).push({ ...p, id: pid }); });
      return lines;
    }
    const [d, m, f] = formation.split("-").map(Number);
    const need = { GK: 1, D: d, M: m, F: f };
    const flex = [];
    t.slots.forEach((pid, i) => {
      if (!pid || pid === "0") return;
      const slot = slotNames[i];
      if (lines[slot]) { lines[slot].push({ ...pl(pid), id: pid }); need[slot]--; }
      else flex.push({ pid, allowed: FLEX[slot] || ["M"] });
    });
    flex.forEach(({ pid, allowed }) => {
      const p = pl(pid);
      const own = (p.ps && p.ps.length ? p.ps : [p.p]).filter((x) => allowed.includes(x) && need[x] > 0);
      const line = own[0] || allowed.find((x) => need[x] > 0) || (lines[p.p] ? p.p : "M");
      lines[line].push({ ...p, id: pid });
      need[line]--;
    });
    return lines;
  }

  function rank(teams) {
    return [...teams].sort((a, b) => b.w - a.w || b.d - a.d || b.pf - a.pf).map((t, i) => Object.assign(t, { pos: i + 1 }));
  }

  // Streak runs straight from Sleeper's per-week record string ("WWLWW"), so they're live today.
  function streakRuns(t, startWeek) {
    const runs = [];
    t.record.split("").forEach((r, i) => {
      const wk = startWeek + i, last = runs[runs.length - 1];
      if (last && last.type === r) { last.len++; last.end = wk; } else runs.push({ type: r, len: 1, start: wk, end: wk });
    });
    return runs;
  }

  // Everything that needs real matchups: splits, h2h, all-play, consistency, optimal lineups.
  function deriveFromResults() {
    const T = state.teams;
    T.forEach((t) => Object.assign(t, { games: [], home: { w: 0, l: 0, d: 0 }, away: { w: 0, l: 0, d: 0 }, h2h: {}, allPlay: null, stdDev: null, optimal: null, robbed: 0 }));
    const res = (a, b) => (a > b ? "W" : a < b ? "L" : "D");
    for (const m of [...state.results].sort((a, b) => a.week - b.week)) {
      const H = state.byRoster[m.home], A = state.byRoster[m.away];
      const hr = res(m.homePts, m.awayPts), ar = res(m.awayPts, m.homePts);
      H.games.push({ week: m.week, score: m.homePts, oppScore: m.awayPts, opp: m.away, res: hr, best: m.homeBest });
      A.games.push({ week: m.week, score: m.awayPts, oppScore: m.homePts, opp: m.home, res: ar, best: m.awayBest });
      H.home[hr.toLowerCase()]++; A.away[ar.toLowerCase()]++;
      const hh = (H.h2h[m.away] ||= { w: 0, l: 0, d: 0 }), ah = (A.h2h[m.home] ||= { w: 0, l: 0, d: 0 });
      hh[hr.toLowerCase()]++; ah[ar.toLowerCase()]++;
    }
    if (!state.hasResults) return;
    const byWeek = {};
    T.forEach((t) => t.games.forEach((g) => (byWeek[g.week] ||= []).push({ id: t.rosterId, s: g.score })));
    T.forEach((t) => {
      const ap = { w: 0, l: 0, d: 0 };
      t.games.forEach((g) => byWeek[g.week].forEach((o) => { if (o.id !== t.rosterId) ap[o.s < g.score ? "w" : o.s > g.score ? "l" : "d"]++; }));
      t.allPlay = t.games.length ? ap : null;
      if (t.games.length > 1) {
        const mean = t.games.reduce((a, g) => a + g.score, 0) / t.games.length;
        t.stdDev = Math.sqrt(t.games.reduce((a, g) => a + (g.score - mean) ** 2, 0) / t.games.length);
      }
      const lg = t.games.filter((g) => Number.isFinite(g.best));
      if (lg.length) {
        t.optimal = { w: 0, l: 0, d: 0 };
        lg.forEach((g) => { const r = res(g.best, g.oppScore); t.optimal[r.toLowerCase()]++; if (g.res === "L" && r === "W") t.robbed++; });
      }
      const opps = Object.entries(t.h2h).map(([id, r]) => ({ id: +id, ...r, diff: r.w - r.l, n: r.w + r.l + r.d }));
      t.nemesis = opps.length ? [...opps].sort((a, b) => a.diff - b.diff || b.n - a.n)[0] : null;
      t.cupcake = opps.length ? [...opps].sort((a, b) => b.diff - a.diff || b.n - a.n)[0] : null;
      if (t.nemesis && t.cupcake && t.nemesis.id === t.cupcake.id) t.cupcake = null;
    });
  }

  // League position after each week. With logged matchups it's exact (wins, then points);
  // until then it's wins from the record string, ties split by season points for.
  function buildRankHistory() {
    const start = (state.league.settings && state.league.settings.start_week) || 1;
    const weeks = state.hasResults
      ? [...new Set(state.results.map((m) => m.week))].sort((a, b) => a - b)
      : Array.from({ length: Math.max(...state.teams.map((t) => t.record.length), 0) }, (_, i) => start + i);
    const hist = Object.fromEntries(state.teams.map((t) => [t.rosterId, []]));
    weeks.forEach((wk, i) => {
      const snap = state.teams.map((t) => {
        if (state.hasResults) {
          const g = t.games.filter((x) => x.week <= wk);
          return { id: t.rosterId, w: g.filter((x) => x.res === "W").length, pf: g.reduce((a, x) => a + x.score, 0) };
        }
        return { id: t.rosterId, w: (t.record.slice(0, i + 1).match(/W/g) || []).length, pf: t.pf };
      }).sort((a, b) => b.w - a.w || b.pf - a.pf);
      snap.forEach((s, r) => hist[s.id].push(r + 1));
    });
    return { weeks, hist, exact: state.hasResults };
  }

  // ---------- HERO ----------
  function renderHero() {
    $$(".js-week").forEach((el) => (el.textContent = state.week));
    if (!$("#sbTop")) return;
    const T = state.teams;
    const row = (t) => `<li class="sb__row"><span class="sb__pos">${t.pos}</span><span class="sb__name">${club(t)}</span><strong>${t.w}-${t.l}${t.d ? "-" + t.d : ""}</strong></li>`;
    $("#sbTop").innerHTML = T.slice(0, 3).map(row).join("");
    $("#sbBottom").innerHTML = T.slice(-2).map(row).join("");
    $("#heroEyebrow").textContent = `The Mater League · Matchweek ${state.week}`;
  }
  function streakLeader() {
    const val = (t) => (t.streak.endsWith("W") ? parseInt(t.streak, 10) : 0);
    const best = [...state.teams].sort((a, b) => val(b) - val(a))[0];
    return best && val(best) > 0 ? best : null;
  }

  // ---------- TABLE ----------
  const winPct = (t) => { const g = t.w + t.l + t.d; return g ? (t.w + t.d / 2) / g : 0; };
  const eff = (t) => (t.pp ? t.pf / t.pp : 0);
  const SORTS = {
    rank: (t) => -t.pos,
    winpct: winPct,
    pf: (t) => t.pf,
    pa: (t) => t.pa,
    diff: (t) => t.pf - t.pa,
    allplay: (t) => (t.allPlay ? t.allPlay.w - t.allPlay.l : -Infinity),
    eff,
  };
  let tableSort = { key: "rank", dir: -1 };
  function renderTable() {
    if (!$("#tableBody")) return;
    const n = state.teams.length;
    const rows = [...state.teams].sort((a, b) => (SORTS[tableSort.key](b) - SORTS[tableSort.key](a)) * -tableSort.dir || a.pos - b.pos);
    const byRank = tableSort.key === "rank" && tableSort.dir === -1;
    $("#tableBody").innerHTML = rows.map((t) => {
      const diff = t.pf - t.pa;
      const form = t.record.slice(-5).split("").map((r) => `<i class="${r}" title="${r === "W" ? "Win" : r === "L" ? "Loss" : "Draw"}">${r === "T" ? "D" : r}</i>`).join("");
      const cls = [t.pos <= PLAYOFF_SPOTS ? "is-po" : "", t.pos === n ? "is-spoon" : "", byRank && t.pos === PLAYOFF_SPOTS + 1 ? "cut" : ""].join(" ");
      const ap = t.allPlay ? `${t.allPlay.w}-${t.allPlay.l}${t.allPlay.d ? "-" + t.allPlay.d : ""}` : `<span class="dim" title="Needs logged matchups">–</span>`;
      return `<tr class="${cls}" data-roster="${t.rosterId}">
        <td class="c-pos"><span class="pos">${t.pos}</span></td>
        <td class="c-club"><div class="club-cell"><button type="button" data-open="${t.rosterId}" aria-label="Open ${esc(t.name)} club profile">${crest(t)}<span><span class="name">${club(t)}</span><span class="mgr">${esc(t.manager)}</span></span></button></div></td>
        <td class="rec">${t.w}-${t.d}-${t.l}</td>
        <td class="hide-sm">${(winPct(t) * 100).toFixed(1)}%</td>
        <td class="pf">${num(t.pf)}</td>
        <td class="hide-sm">${num(t.pa)}</td>
        <td class="hide-md">${diff > 0 ? "+" : ""}${num(diff)}</td>
        <td class="hide-md">${ap}</td>
        <td class="hide-md">${Math.round(eff(t) * 100)}%</td>
        <td class="c-form hide-sm"><span class="form" aria-label="Last five: ${esc(t.record.slice(-5))}">${form}</span></td>
      </tr>`;
    }).join("");
    $$(".league-table th").forEach((th) => {
      const b = $(".sort", th);
      if (!b) return;
      const on = b.dataset.sort === tableSort.key;
      th.setAttribute("aria-sort", on ? (tableSort.dir === -1 ? "descending" : "ascending") : "none");
      b.classList.toggle("is-on", on);
    });
  }
  $$(".league-table .sort").forEach((b) => b.addEventListener("click", () => {
    const key = b.dataset.sort;
    tableSort = tableSort.key === key ? { key, dir: -tableSort.dir } : { key, dir: -1 };
    renderTable();
  }));
  $("#tableBody")?.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-roster]");
    if (tr && !e.target.closest("button")) location.href = `clubs.html#club-${tr.dataset.roster}`;
  });

  // ---------- HEAD-TO-HEAD ----------
  // ---------- CSV DATA (data/matchups.csv, data/cup.csv) ----------
  // Small CSV reader: handles quoted fields, blank lines and a header row.
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') q = false;
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((x) => x.trim() !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((x) => x.trim() !== "")) rows.push(row);
    const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
    return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
  }
  async function getCSV(path) {
    try {
      const r = await fetch(path, { cache: "no-cache" });
      return r.ok ? parseCSV(await r.text()) : [];
    } catch (_) { return []; }
  }
  // rows name teams by Sleeper username; turn those into roster IDs
  const rosterOf = (username) => {
    const t = state.teams.find((x) => x.manager.toLowerCase() === String(username || "").trim().toLowerCase());
    return t ? t.rosterId : null;
  };
  const numOrNull = (v) => (v === "" || v == null || isNaN(+v) ? null : +v);
  function loadResults(rows) {
    return rows.map((r) => ({
      week: +r.week, home: rosterOf(r.home), away: rosterOf(r.away),
      homePts: numOrNull(r.home_pts), awayPts: numOrNull(r.away_pts),
      homeBest: numOrNull(r.home_best) ?? undefined, awayBest: numOrNull(r.away_best) ?? undefined,
    })).filter((m) => {
      const ok = m.week && m.home && m.away && m.homePts != null && m.awayPts != null;
      if (!ok) console.warn("Skipping matchups.csv row", m);
      return ok;
    });
  }
  // a club's league score in a given week (from matchups.csv), or null if not logged yet
  function weekScore(id, week) {
    const m = state.results.find((x) => x.week === week && (x.home === id || x.away === id));
    return m ? (m.home === id ? m.homePts : m.awayPts) : null;
  }
  // Cup legs are one "marquee" tie per gameweek, scored on each club's league score that week.
  // Typed scores in cup.csv win; otherwise they're filled from matchups.csv once that week is in.
  function loadCupRows(rows) {
    const seen = {};
    return rows.map((r) => {
      const key = `${r.round}|${r.leg}`;
      const tie = (seen[key] = (seen[key] || 0) + 1);
      const a = rosterOf(r.home), b = rosterOf(r.away), week = numOrNull(r.week);
      let aPts = numOrNull(r.home_pts), bPts = numOrNull(r.away_pts);
      if (a && b && week && aPts == null && bPts == null) { aPts = weekScore(a, week); bPts = weekScore(b, week); }
      return { round: r.round, leg: +r.leg || 1, week, tie, a, b, aPts: aPts ?? 0, bPts: bPts ?? 0, played: aPts != null && bPts != null };
    });
  }
  function h2h(a, b) {
    const games = state.results.filter((m) => (m.home === a && m.away === b) || (m.home === b && m.away === a));
    let wa = 0, wb = 0, dr = 0;
    for (const g of games) {
      const pa = g.home === a ? g.homePts : g.awayPts;
      const pb = g.home === a ? g.awayPts : g.homePts;
      pa > pb ? wa++ : pb > pa ? wb++ : dr++;
    }
    return { games, wa, wb, dr };
  }
  function renderH2HPicker() {
    if (!$("#h2hA")) return;
    const opts = state.teams.map((t) => `<option value="${t.rosterId}">${esc(clubText(t))}</option>`).join("");
    const A = $("#h2hA"), B = $("#h2hB");
    A.innerHTML = opts; B.innerHTML = opts;
    A.value = state.teams[0].rosterId;
    B.value = state.teams[1].rosterId;
    const update = (changed) => {
      if (A.value === B.value) (changed === A ? B : A).value = state.teams.find((t) => String(t.rosterId) !== changed.value).rosterId;
      renderH2H(+A.value, +B.value, changed === A ? "#h2hCrestA" : "#h2hCrestB");
    };
    A.addEventListener("change", () => update(A));
    B.addEventListener("change", () => update(B));
    renderH2H(+A.value, +B.value);
  }
  function renderH2H(a, b, popSel) {
    const r = h2h(a, b);
    $("#h2hCrestA").innerHTML = crest(state.byRoster[a], "lg");
    $("#h2hCrestB").innerHTML = crest(state.byRoster[b], "lg");
    if (popSel) { const el = $(popSel); el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); }
    $("#h2hWinsA").textContent = r.wa;
    $("#h2hWinsB").textContent = r.wb;
    $("#h2hMeta").textContent = r.games.length
      ? `${r.games.length} meeting${r.games.length > 1 ? "s" : ""}${r.dr ? ` · ${r.dr} draw${r.dr > 1 ? "s" : ""}` : ""}`
      : "No meetings logged yet";
    $("#h2hMeetings").innerHTML = r.games.sort((x, y) => y.week - x.week).map((g) => `<li><span class="wk">GW ${g.week}</span>
        <span class="a ${g.homePts > g.awayPts ? "win" : ""}">${clubById(g.home)}</span>
        <span class="sc">${num(g.homePts)} – ${num(g.awayPts)}</span>
        <span class="${g.awayPts > g.homePts ? "win" : ""}">${clubById(g.away)}</span></li>`).join("");
  }
  function renderMatrix() {
    if (!$("#h2hMatrix")) return;
    const T = state.teams;
    const head = `<thead><tr><th scope="col"><span class="visually-hidden">Club</span></th>${T.map((t) => `<th scope="col" title="${esc(t.name)}">${crest(t)}<span class="visually-hidden">${esc(t.name)}</span></th>`).join("")}</tr></thead>`;
    const body = T.map((row) => `<tr><th scope="row" title="${esc(row.name)}">${crest(row)}<span class="matrix__name">${club(row)}</span></th>${T.map((col) => {
      if (row === col) return `<td class="self" aria-label="Same club"></td>`;
      const r = h2h(row.rosterId, col.rosterId);
      const derby = row.derby && row.derby === col.derby;
      const d = derby ? ` is-derby" title="${esc(row.derby.name)}` : "";
      const dl = derby ? `<span class="visually-hidden"> (${esc(row.derby.name)})</span>` : "";
      if (!r.games.length) return `<td class="even${d}">–${dl}</td>`;
      const c = r.wa > r.wb ? "up" : r.wa < r.wb ? "down" : "even";
      return `<td class="${c}${d}">${r.wa}–${r.wb}${r.dr ? `–${r.dr}` : ""}${dl}</td>`;
    }).join("")}</tr>`).join("");
    $("#h2hMatrix").innerHTML = head + `<tbody>${body}</tbody>`;
    if (!state.hasResults) {
      const empty = $("#h2hEmpty");
      empty.hidden = false;
      empty.innerHTML = `Gold cells are derbies. Sleeper doesn't publish soccer matchups publicly, so head-to-heads fill in as results are added to <code>data/matchups.csv</code>.`;
    }
  }

  // ---------- DERBIES ----------
  // rivalries come from data/league.js, matched to clubs by Sleeper username
  function buildDerbies() {
    const byMgr = Object.fromEntries(state.teams.map((t) => [t.manager.toLowerCase(), t]));
    const list = (window.MATER_LEAGUE && window.MATER_LEAGUE.derbies) || [];
    return list.map((d) => {
      const [a, b] = d.managers.map((m) => byMgr[String(m).toLowerCase()]);
      if (!a || !b) return null;
      const derby = { ...d, a, b };
      a.derby = derby; b.derby = derby;
      return derby;
    }).filter(Boolean);
  }
  const derbyRival = (t) => (t.derby ? (t.derby.a === t ? t.derby.b : t.derby.a) : null);
  // who holds bragging rights: derby wins first, then league position
  function derbyVerdict(d) {
    const r = h2h(d.a.rosterId, d.b.rosterId);
    if (r.wa !== r.wb) {
      const lead = r.wa > r.wb ? d.a : d.b;
      return { lead, r, text: `${lead.name} lead the derby ${Math.max(r.wa, r.wb)}–${Math.min(r.wa, r.wb)}` };
    }
    const lead = d.a.pos < d.b.pos ? d.a : d.b, trail = lead === d.a ? d.b : d.a;
    const pre = r.games.length ? `Level at ${r.wa}–${r.wb} in meetings. ` : "";
    return { lead, r, text: `${pre}${lead.name} hold the bragging rights for now: ${ordinal(lead.pos)} vs ${ordinal(trail.pos)} in the table` };
  }
  function renderDerbies() {
    const el = $("#derbies");
    if (!el) return;
    el.innerHTML = state.derbies.map((d) => {
      const { lead, r, text } = derbyVerdict(d);
      const share = d.a.pf + d.b.pf ? d.a.pf / (d.a.pf + d.b.pf) : 0.5;
      const side = (t, cls) => `<div class="derby__side derby__side--${cls}${lead === t ? " is-lead" : ""}">
          ${crest(t, "lg")}<b>${club(t)}</b><small>${esc(t.manager)} · ${ordinal(t.pos)}</small></div>`;
      const row = (a, label, b) => `<div class="derby__row"><span>${a}</span><small>${label}</small><span>${b}</span></div>`;
      return `<article class="derby reveal" id="derby-${esc(d.slug)}">
        <header class="derby__head"><span class="derby__tag">${esc(d.tag)}</span><h3>${esc(d.name)}</h3></header>
        <div class="derby__clash">${side(d.a, "a")}<span class="derby__vs" aria-hidden="true">VS</span>${side(d.b, "b")}</div>
        <p class="derby__story">${esc(d.story)}</p>
        <div class="derby__stats">
          ${row(`${d.a.w}-${d.a.d}-${d.a.l}`, "Record", `${d.b.w}-${d.b.d}-${d.b.l}`)}
          ${row(num(d.a.pf), "Points", num(d.b.pf))}
          ${row(r.wa, "Derby wins", r.wb)}
        </div>
        <div class="derby__bar" role="img" aria-label="Share of combined points: ${esc(d.a.name)} ${Math.round(share * 100)}%, ${esc(d.b.name)} ${100 - Math.round(share * 100)}%"><span style="--share:${share}"></span></div>
        <p class="derby__verdict">${esc(text)}.</p>
        <button type="button" class="derby__open" data-a="${d.a.rosterId}" data-b="${d.b.rosterId}">Full head-to-head</button>
      </article>`;
    }).join("");
    $$(".derby__open", el).forEach((b) => b.addEventListener("click", () => {
      const A = $("#h2hA"), B = $("#h2hB");
      if (!A || !B) return;
      A.value = b.dataset.a; B.value = b.dataset.b;
      renderH2H(+A.value, +B.value, "#h2hCrestA");
      $("#versus").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
    }));
  }

  // ---------- CLUBS ----------
  const POS_ORDER = { GK: 0, D: 1, M: 2, F: 3 };
  function renderClubs() {
    if (!$("#clubGrid")) return;
    $("#clubGrid").innerHTML = state.teams.map((t) => `
      <button type="button" class="club-card" data-open="${t.rosterId}" aria-pressed="false" aria-controls="clubProfile" style="--c1:${t.kit[0]};--c2:${t.kit[1]}">
        <span class="top">${crest(t, "lg")}<span class="rank" aria-label="Position ${t.pos}">${String(t.pos).padStart(2, "0")}</span></span>
        <span><span class="cc-name">${club(t)}</span><span class="mgr">${esc(t.manager)}</span></span>
        <span class="stats">
          <span><b>${t.w}-${t.l}${t.d ? "-" + t.d : ""}</b><small>Record</small></span>
          <span><b>${num(t.pf, 0)}</b><small>Points</small></span>
          <span><b>${t.streak || "–"}</b><small>Streak</small></span>
        </span>
      </button>`).join("");
  }

  const rec = (r) => (r ? `${r.w}-${r.l}${r.d ? "-" + r.d : ""}` : "–");
  function recordTransfer(id) {
    const bids = state.txns.filter((t) => t.type === "waiver" && t.roster_ids[0] === id && t.settings && t.settings.waiver_bid);
    const top = bids.sort((a, b) => b.settings.waiver_bid - a.settings.waiver_bid)[0];
    if (!top) return null;
    const pid = Object.keys(top.adds || {})[0];
    return { name: state.players[pid] ? state.players[pid].n : "Unknown", bid: top.settings.waiver_bid, when: top.status_updated || top.created };
  }
  function sparklineSVG(games) {
    const W = 520, H = 140, P = 22;
    const vals = games.flatMap((g) => [g.score, Number.isFinite(g.best) ? g.best : g.score]);
    const lo = Math.min(...vals) * 0.95, hi = Math.max(...vals) * 1.02;
    const x = (i) => P + (games.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (games.length - 1));
    const y = (v) => H - P - ((v - lo) / (hi - lo || 1)) * (H - 2 * P);
    const line = (key) => games.map((g, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(g[key]).toFixed(1)}`).join("");
    const hasBest = games.every((g) => Number.isFinite(g.best));
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Points by week: ${games.map((g) => `GW${g.week} ${num(g.score)}`).join(", ")}">
      <line x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}" class="spark__axis"/>
      ${hasBest ? `<path d="${line("best")}" class="spark__best"/>` : ""}
      <path d="${line("score")}" class="spark__line"/>
      ${games.map((g, i) => `<circle cx="${x(i)}" cy="${y(g.score)}" r="4" class="spark__dot"><title>GW ${g.week}: ${num(g.score)}${hasBest ? ` (best ${num(g.best)})` : ""}</title></circle>
        <text x="${x(i)}" y="${H - 4}" class="spark__lbl">GW${g.week}</text>`).join("")}
    </svg>
    <p class="spark__key"><span class="k k--act"></span> Actual${hasBest ? ` <span class="k k--best"></span> Best possible` : ""}</p>`;
  }

  function openClub(id, scroll) {
    const t = state.byRoster[id];
    if (!t) return;
    const P = state.players;
    const pl = (pid) => P[pid] || { n: `Player ${pid}`, l: pid, c: "", p: "", i: "" };
    const pj = (pid) => { const x = state.projections[pid]; return x ? `${num(x.v)}${x.per90 ? "/90" : "/gm"}` : ""; };
    const starters = new Set(t.starters), reserve = new Set(t.reserve);

    // group the XI by line, GK at the bottom of the pitch
    const current = formationFor(t, state.week);
    const lines = lineUp(t, current && current.f);
    const shape = current ? current.f : [lines.D.length, lines.M.length, lines.F.length].filter(Boolean).join("-");
    // "3-4-3 (GW1–4) · 3-5-2 (GW5–)" style history of the shapes this manager has used
    // merge back-to-back weeks with the same shape into one span
    const spans = t.formations.reduce((acc, x) => {
      if (acc.length && acc[acc.length - 1].f === x.f) return acc;
      acc.push({ ...x });
      return acc;
    }, []);
    const shapeHistory = spans.map((x, i) => {
      const next = spans[i + 1];
      const end = next ? next.wk - 1 : null;
      return `${x.f} <small>(GW${x.wk}${end === x.wk ? "" : end ? `–${end}` : "–"})</small>`;
    }).join(" · ");
    let delay = 0;
    const row = (arr) => `<div class="pitch__row">${arr.map((p) => `
      <div class="pl" style="animation-delay:${(delay++) * 45}ms">
        <span class="pl__photo" data-photo="${p.id}"><span>${esc(initials(p.n))}</span></span>
        ${pj(p.id) ? `<span class="pl__proj">${pj(p.id)}</span>` : ""}
        <span class="pl__name">${esc(p.l)}</span><span class="pl__club">${clubLogo(p.t)}${esc(p.c)}</span>
      </div>`).join("")}</div>`;

    const squad = [...t.players].sort((a, b) => {
      const pa = pl(a), pb = pl(b);
      return (starters.has(b) - starters.has(a)) || ((POS_ORDER[pa.p] ?? 9) - (POS_ORDER[pb.p] ?? 9)) || pa.l.localeCompare(pb.l);
    });
    const rt = recordTransfer(id);
    const cs = t.cupStatus;
    const cupBadge = !cs ? `<span class="badge badge--tbd">McQueen Cup · not yet drawn</span>`
      : cs.result === "won" ? `<span class="badge badge--won">McQueen Cup · won ${esc(cs.round)} vs ${esc(teamName(cs.opp))}</span>`
      : cs.result === "lost" ? `<span class="badge badge--lost">McQueen Cup · out in ${esc(cs.round)} to ${esc(teamName(cs.opp))}</span>`
      : `<span class="badge badge--live">McQueen Cup · ${esc(cs.round)} vs ${esc(teamName(cs.opp))}</span>`;
    const form = t.record.slice(-5).split("").map((r) => `<i class="${r}" title="${r === "W" ? "Win" : r === "L" ? "Loss" : "Draw"}">${r === "T" ? "D" : r}</i>`).join("");
    const kpi = (v, l, note) => `<div class="kpi"><b>${v}</b><small>${l}</small>${note ? `<span class="kpi__note">${note}</span>` : ""}</div>`;
    const needs = state.hasResults ? "" : "Needs matchups";
    const h2hRows = state.teams.filter((o) => o !== t).map((o) => {
      const r = t.h2h[o.rosterId];
      return `<tr><td>${crest(o)}<span>${club(o)}</span></td><td class="r">${r ? rec(r) : "–"}</td></tr>`;
    }).join("");

    const el = $("#clubProfile");
    el.style.setProperty("--c1", t.kit[0]);
    el.style.setProperty("--c2", t.kit[1]);
    el.innerHTML = `
      <div class="cp__banner">
        ${crest(t, "xl")}
        <div class="cp__id">
          <h3>${club(t)}</h3>
          <p>Managed by ${esc(t.manager)} · ${ordinal(t.pos)} place <span class="form" aria-label="Last five: ${esc(t.record.slice(-5))}">${form}</span></p>
          <p class="cp__badges">${cupBadge}${t.derby ? `<span class="badge badge--derby">${esc(t.derby.name)}</span>` : ""}${supports(t)}</p>
        </div>
        <button class="cp__close" type="button" aria-label="Close club profile"><svg viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13"/></svg></button>
      </div>
      <div class="cp__body">
        <div class="cp__groups">
          <p class="cp__glabel">Record</p>
          <div class="cp__kpis">
            ${kpi(rec({ w: t.w, l: t.l, d: t.d }), "Overall")}
            ${kpi(state.hasResults ? rec(t.home) : "–", "Home", needs)}
            ${kpi(state.hasResults ? rec(t.away) : "–", "Away", needs)}
            ${kpi(rec(t.allPlay), "All-Play", needs)}
          </div>
          <p class="cp__glabel">Scoring</p>
          <div class="cp__kpis">
            ${kpi(num(t.pf), "Points for")}
            ${kpi(num(t.pa), "Points against")}
            ${kpi(t.stdDev != null ? num(t.stdDev) : "–", "Std dev", needs)}
            ${kpi("$" + faabLeft(t), "FAAB left", (() => { const x = faabLedger()[t.rosterId]; return `$${x.paid} spent${x.traded ? ` · ${x.traded > 0 ? "+" : "−"}$${Math.abs(x.traded)} traded` : ""}`; })())}
          </div>
          <p class="cp__glabel">Lineup management</p>
          <div class="cp__kpis">
            ${kpi(Math.round(eff(t) * 100) + "%", "Efficiency")}
            ${kpi(num(t.pp - t.pf), "Bench points left")}
            ${kpi(rec(t.optimal), "Optimal record", state.hasResults ? "" : needs)}
            ${kpi(state.hasResults ? t.robbed : "–", "Robbed by bench", needs)}
          </div>
        </div>

        ${t.games.length ? `<div class="cp__block cp__wide"><h4 class="subhead">Season sparkline</h4>${sparklineSVG(t.games)}</div>` : ""}

        ${t.derby ? (() => {
          const rival = derbyRival(t), v = derbyVerdict(t.derby);
          return `<a class="cp-derby cp__wide" href="h2h.html#derby-${esc(t.derby.slug)}">
            <span class="cp-derby__label">Derby rival · ${esc(t.derby.tag)}</span>
            <span class="cp-derby__name">${esc(t.derby.name)}</span>
            <span class="cp-derby__vs">${crest(t)}<b>vs</b>${crest(rival)}<span>${club(rival)}</span></span>
            <span class="cp-derby__verdict">${esc(v.text)}.</span>
          </a>`;
        })() : ""}

        ${t.nemesis || t.cupcake ? `<div class="nc cp__wide">
          ${t.nemesis ? `<div class="nc__item nc__item--nem"><small>Nemesis</small>${crest(state.byRoster[t.nemesis.id])}<b>${clubById(t.nemesis.id)}</b><span>${rec(t.nemesis)}</span></div>` : ""}
          ${t.cupcake ? `<div class="nc__item nc__item--cup"><small>Cupcake</small>${crest(state.byRoster[t.cupcake.id])}<b>${clubById(t.cupcake.id)}</b><span>${rec(t.cupcake)}</span></div>` : ""}
        </div>` : ""}

        <div class="formation">
          <div class="formation__label"><h4 class="subhead" style="margin:0">Starting XI</h4><b>${shape || "–"}</b></div>
          <div class="pitch" role="img" aria-label="${esc(t.name)} starting eleven in a ${shape} formation: ${esc(t.starters.map((pid) => pl(pid).n).join(", "))}">
            <span class="box"></span><span class="box box--six"></span>
            ${row(lines.GK)}${row(lines.D)}${row(lines.M)}${row(lines.F)}
          </div>
          ${shapeHistory ? `<p class="formation__hist"><b>Formations used:</b> ${shapeHistory}</p>` : ""}
          <p class="formation__note">Formation as set in Sleeper. Red tag = projected points per 90 minutes (per game for players under 90 minutes this season).</p>
        </div>
        <div class="squad">
          <h4>Squad (${t.players.length})</h4>
          <ul>${squad.map((pid) => {
            const p = pl(pid);
            const tag = reserve.has(pid) ? `<span class="tag inj">IR</span>`
              : p.i ? `<span class="tag inj">${esc(p.i)}</span>`
              : starters.has(pid) ? `<span class="tag xi">XI</span>` : `<span class="tag">Bench</span>`;
            const sp = state.seasonPts[pid];
            return `<li><span class="posb ${esc(p.p)}">${esc(p.p || "–")}</span>
              <span class="sq__photo" data-photo="${pid}" aria-hidden="true"></span>
              <span class="nm">${esc(p.n)}<small>${clubLogo(p.t)}${esc(p.c)}${sp != null ? ` · ${num(sp)} pts` : ""}${pj(pid) ? ` · ${pj(pid)}` : ""}</small></span>${tag}</li>`;
          }).join("")}</ul>
        </div>

        <div class="cp__block">
          <h4 class="subhead">Head-to-head</h4>
          <table class="h2h-mini"><tbody>${h2hRows}</tbody></table>
        </div>
        <div class="cp__block">
          <h4 class="subhead">Club record transfer</h4>
          ${rt ? `<div class="rt"><span class="rt__fee">$${rt.bid}</span><b>${esc(rt.name)}</b><small>${new Date(rt.when).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</small></div>`
               : `<p class="dim">No waiver fees paid yet.</p>`}
        </div>
      </div>`;
    el.hidden = false;
    $(".cp__close", el).addEventListener("click", closeClub);
    $$(".club-card").forEach((c) => c.setAttribute("aria-pressed", String(+c.dataset.open === id)));
    history.replaceState(null, "", `#club-${id}`);
    if (scroll) el.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
    loadPhotos([...t.starters, ...squad.filter((p) => !starters.has(p))], el);
  }
  function closeClub() {
    const el = $("#clubProfile");
    const open = $('.club-card[aria-pressed="true"]');
    el.hidden = true;
    $$(".club-card").forEach((c) => c.setAttribute("aria-pressed", "false"));
    history.replaceState(null, "", location.pathname);
    open && open.focus();
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-open]");
    if (!b) return;
    if (!$("#clubProfile")) { location.href = `clubs.html#club-${b.dataset.open}`; return; }
    if (b.classList.contains("club-card") && b.getAttribute("aria-pressed") === "true") return closeClub();
    openClub(+b.dataset.open, true);
  });
  const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || "th");

  // ---------- TRANSFERS ----------
  let feedFilter = "all";
  const IN = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1l5 6H8v4H4V7H1z"/></svg>`;
  const OUT = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 11L1 5h3V1h4v4h3z"/></svg>`;
  function txnSummary(tx) {
    const nm = (pid) => (state.players[pid] ? state.players[pid].n : `Player ${pid}`);
    const adds = tx.adds || {}, drops = tx.drops || {};
    const teams = tx.roster_ids.map((id) => state.byRoster[id]).filter(Boolean);
    const main = teams[0];
    const perTeam = teams.map((t) => ({
      t,
      ins: Object.keys(adds).filter((p) => adds[p] === t.rosterId).map(nm),
      outs: Object.keys(drops).filter((p) => drops[p] === t.rosterId).map(nm),
    }));
    let head;
    if (tx.type === "trade") head = `${teams.map(club).join(" and ")} agree a deal`;
    else {
      const ins = perTeam[0] ? perTeam[0].ins : [];
      head = ins.length
        ? `${club(main)} ${tx.type === "waiver" ? "win the race for" : "snap up"} ${esc(ins.join(", "))}`
        : `${club(main)} release ${esc((perTeam[0] ? perTeam[0].outs : []).join(", "))}`;
    }
    const moves = perTeam.map(({ t, ins, outs }) => [
      ...ins.map((n) => `<span class="in">${IN}<b>${esc(n)}</b>${tx.type === "trade" ? ` → ${club(t)}` : " in"}</span>`),
      ...(tx.type === "trade" ? [] : outs.map((n) => `<span class="out">${OUT}<b>${esc(n)}</b> out</span>`)),
    ].join("")).join("");
    return { head, moves, main };
  }
  function when(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  // feed grouped by gameweek; the newest gameweek starts open, the rest collapse
  let openLegs = null;
  const TYPE_LABEL = { waiver: "Waiver", free_agent: "Free agent", trade: "Trade" };
  function feedItem(tx, i) {
    const { head, moves, main } = txnSummary(tx);
    const bid = tx.settings && tx.settings.waiver_bid;
    return `<li class="feed__item" style="animation-delay:${Math.min(i, 8) * 40}ms">
      ${main ? crest(main) : ""}
      <div class="body"><span class="feed__type ${tx.type}">${TYPE_LABEL[tx.type] || tx.type}</span><div class="feed__head">${head}</div><div class="moves">${moves}</div></div>
      <div class="feed__side">${bid != null && tx.type === "waiver" ? `<div class="feed__fee">$${bid}<small>FAAB fee</small></div>` : ""}<div class="feed__when">${when(tx.status_updated || tx.created)}</div></div>
    </li>`;
  }
  function renderFeed() {
    const el = $("#gwGroups");
    if (!el) return;
    const list = state.txns.filter((t) => feedFilter === "all" || t.type === feedFilter);
    const legs = [...new Set(state.txns.map((t) => t.leg))].sort((a, b) => b - a);
    if (!openLegs) openLegs = new Set(legs.slice(0, 1));
    const groups = legs.map((leg) => ({ leg, items: list.filter((t) => t.leg === leg) })).filter((g) => g.items.length);
    el.innerHTML = groups.length ? groups.map((g) => {
      const fees = g.items.reduce((s, t) => s + ((t.type === "waiver" && t.settings && t.settings.waiver_bid) || 0), 0);
      const trades = g.items.filter((t) => t.type === "trade").length;
      return `<details class="gw" data-leg="${g.leg}"${openLegs.has(g.leg) ? " open" : ""}>
        <summary class="gw__sum">
          <span class="gw__title">Gameweek ${g.leg}</span>
          <span class="gw__meta"><b>${g.items.length}</b> move${g.items.length > 1 ? "s" : ""}${fees ? ` · <b>$${fees}</b> in fees` : ""}${trades ? ` · <b>${trades}</b> trade${trades > 1 ? "s" : ""}` : ""}</span>
          <svg class="gw__chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
        </summary>
        <ol class="feed">${g.items.map(feedItem).join("")}</ol>
      </details>`;
    }).join("") : `<p class="empty">Quiet window. No ${feedFilter === "all" ? "" : feedFilter.replace("_", " ") + " "}moves yet.</p>`;
    $$(".gw", el).forEach((d) => d.addEventListener("toggle", () => {
      d.open ? openLegs.add(+d.dataset.leg) : openLegs.delete(+d.dataset.leg);
    }));
  }
  $$("#transfers-filters .chip").forEach((c) => c.addEventListener("click", () => {
    feedFilter = c.dataset.filter;
    $$("#transfers-filters .chip").forEach((x) => { x.classList.toggle("is-active", x === c); x.setAttribute("aria-pressed", String(x === c)); });
    renderFeed();
  }));

  // FAAB can be traded in this league, so a club can bid past the starting budget.
  // Sleeper's waiver_budget_used is net (bids + FAAB sent - FAAB received): right for the
  // balance, wrong for "spent". Winning bids and traded FAAB come from the transactions.
  function faabLedger() {
    const L = Object.fromEntries(state.teams.map((t) => [t.rosterId, { paid: 0, signings: 0, traded: 0 }]));
    for (const tx of state.txns) {
      const bid = tx.type === "waiver" && tx.settings && tx.settings.waiver_bid;
      if (bid && L[tx.roster_ids[0]]) { L[tx.roster_ids[0]].paid += bid; L[tx.roster_ids[0]].signings++; }
      for (const m of tx.waiver_budget || []) {
        if (L[m.sender]) L[m.sender].traded -= m.amount;
        if (L[m.receiver]) L[m.receiver].traded += m.amount;
      }
    }
    return L;
  }
  const faabBudget = () => (state.league.settings && state.league.settings.waiver_budget) || 0;
  const faabLeft = (t) => faabBudget() - t.faabUsed;

  // sidebar: FAAB left, biggest spenders, busiest clubs, window totals
  function renderMarket() {
    if (!$("#mkFaab")) return;
    const budget = (state.league.settings && state.league.settings.waiver_budget) || 0;
    const T = state.teams;
    const moves = {};
    state.txns.forEach((t) => t.roster_ids.forEach((id) => (moves[id] = (moves[id] || 0) + 1)));
    const ledger = faabLedger();
    const spent = T.reduce((s, t) => s + ledger[t.rosterId].paid, 0);
    const topBid = Math.max(0, ...state.txns.map((t) => (t.type === "waiver" && t.settings && t.settings.waiver_bid) || 0));
    const stat = (v, l) => `<div class="mk-stat"><b>${v}</b><small>${l}</small></div>`;
    $("#mkTotals").innerHTML = stat("$" + spent.toLocaleString(), "FAAB spent") + stat(state.txns.length, "Moves") +
      stat(state.txns.filter((t) => t.type === "trade").length, "Trades") + stat("$" + topBid, "Top bid");

    const bar = (t, value, max, label, extra = "") => `<li class="mk-row">
        ${crest(t)}<span class="mk-row__name">${club(t)}</span><span class="mk-row__val">${label}</span>
        <span class="mk-bar" aria-hidden="true"><span style="--w:${max ? Math.max(0, Math.min(1, value / max)) : 0}"></span></span>${extra}
      </li>`;
    const signed = (t) => `${ledger[t.rosterId].signings} paid signing${ledger[t.rosterId].signings === 1 ? "" : "s"}`;
    const traded = (t) => { const x = ledger[t.rosterId].traded; return x ? ` · ${x > 0 ? "+" : "−"}$${Math.abs(x)} via trades` : ""; };
    const maxLeft = Math.max(budget, ...T.map(faabLeft));
    $("#mkFaab").innerHTML = [...T].sort((a, b) => faabLeft(b) - faabLeft(a))
      .map((t) => bar(t, faabLeft(t), maxLeft, `$${faabLeft(t)} left`, traded(t) ? `<small class="mk-row__sub">${traded(t).slice(3)}</small>` : "")).join("");
    const maxSpend = Math.max(1, ...T.map((t) => ledger[t.rosterId].paid));
    $("#mkSpend").innerHTML = [...T].sort((a, b) => ledger[b.rosterId].paid - ledger[a.rosterId].paid).slice(0, 5)
      .map((t) => bar(t, ledger[t.rosterId].paid, maxSpend, `$${ledger[t.rosterId].paid}`, `<small class="mk-row__sub">${signed(t)}${traded(t)}</small>`)).join("");
    const maxMoves = Math.max(1, ...Object.values(moves));
    $("#mkBusy").innerHTML = [...T].sort((a, b) => (moves[b.rosterId] || 0) - (moves[a.rosterId] || 0)).slice(0, 5)
      .map((t) => bar(t, moves[t.rosterId] || 0, maxMoves, `${moves[t.rosterId] || 0} moves`)).join("");
    $("#mkBudget").textContent = `of $${budget}`;
  }

  function renderTicker() {
    if (!$("#ticker")) return;
    const items = state.txns.slice(0, 10).map((tx) => {
      const bid = tx.type === "waiver" && tx.settings && tx.settings.waiver_bid ? ` for $${tx.settings.waiver_bid}` : "";
      return txnSummary(tx).head + bid;
    });
    const leader = state.teams[0];
    if (leader) items.unshift(`${club(leader)} top the table on ${leader.w} wins`);
    const hot = streakLeader();
    if (hot) items.push(`${club(hot)} on a ${esc(hot.streak)} streak`);
    state.derbies.forEach((d) => items.push(`${esc(d.name)}: ${esc(derbyVerdict(d).text)}`));
    const nextCup = (state.cupRows || []).find((r) => r.week >= state.week && !r.played);
    if (nextCup) items.push(`McQueen Cup: ${esc(nextCup.round.replace(/s$/, ""))} ${nextCup.round === "Final" ? "" : nextCup.tie + " "}leg ${nextCup.leg} is the Gameweek ${nextCup.week} marquee`);
    // two identical copies so the -50% marquee loop is seamless; the copy is hidden from screen readers
    $("#ticker").innerHTML = items.map((s) => `<span>${s}</span>`).join("") + items.map((s) => `<span aria-hidden="true">${s}</span>`).join("");
    $("#ticker").style.setProperty("--marquee", Math.max(30, items.length * 7) + "s");
  }

  // ---------- HALL OF RECORDS ----------
  const ICONS = {
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    bench: '<path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"/><path d="M5 18v2"/><path d="M19 18v2"/>',
    rain: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.24"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/>',
    spoon: '<ellipse cx="12" cy="6.5" rx="4" ry="4.5"/><path d="M12 11v11"/>',
    cash: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    swap: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    swords: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/>',
    trend: '<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
    down: '<path d="M22 17 13.5 8.5 8.5 13.5 2 7"/><path d="M16 17h6v-6"/>',
    scale: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7 2 14a3 3 0 0 0 6 0Z"/><path d="M19 7l-3 7a3 3 0 0 0 6 0Z"/>',
    wave: '<path d="M2 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/>',
    ruler: '<path d="M3 12h18"/><path d="M7 8v8M12 6v12M17 8v8"/>',
  };
  // record categories drive the scoreboard colours and filters
  const CATS = { glory: "Glory", shame: "Shame", market: "Transfer market", matchday: "Matchday" };
  const CAT_OF = {
    "Golden Boot": "glory", "Tactical Genius": "glory", "Longest Winning Streak": "glory", "In Form": "glory",
    "Highest Score of the Season": "glory", "Most Consistent Scorer": "glory",
    "Tinkerman Award": "shame", "Hard Luck FC": "shame", "Longest Losing Streak": "shame", "Wooden Spoon": "shame",
    "Most Inconsistent Scorer": "shame", "Costliest Bench Blunder": "shame", "Robbed by the Bench": "shame",
    "Chequebook Manager": "market", "Record Signing": "market", "Super Agent": "market",
    "Biggest Blowout": "matchday", "Closest Game": "matchday", "Lowest Winning Score": "matchday",
    "Highest Scoring Matchup": "matchday", "Lowest Scoring Matchup": "matchday",
  };
  function renderRecords() {
    if (!$("#recRows")) return;
    const T = state.teams;
    const top = (f) => [...T].sort((a, b) => f(b) - f(a))[0];
    const cards = [];
    // who: a team object, or a list of team objects for ties
    const add = (tone, icon, title, who, val, blurb) => who && cards.push({ tone, icon, title, who: [].concat(who), val, blurb });

    // --- live from Sleeper ---
    const boot = top((t) => t.pf);
    add("gold", "trophy", "Golden Boot", boot, num(boot.pf), "Most points scored this season.");
    const genius = top(eff);
    add("cyan", "target", "Tactical Genius", genius, Math.round(eff(genius) * 100) + "%", "Best lineup efficiency: points scored vs the best possible XI.");
    const bench = top((t) => t.pp - t.pf);
    add("pink", "bench", "Tinkerman Award", bench, num(bench.pp - bench.pf), "Most points left on the bench. Rotate less.");
    const unlucky = top((t) => t.pa);
    add("pink", "rain", "Hard Luck FC", unlucky, num(unlucky.pa), "Most points conceded. Opponents always turn up against them.");

    const start = (state.league.settings && state.league.settings.start_week) || 1;
    const runs = T.flatMap((t) => streakRuns(t, start).map((r) => ({ t, ...r })));
    const wk = (r) => (r.start === r.end ? `Week ${r.start}` : `Weeks ${r.start}–${r.end}`);
    const longest = (type) => {
      const list = runs.filter((r) => r.type === type);
      const max = Math.max(0, ...list.map((r) => r.len));
      return { max, ties: list.filter((r) => r.len === max) };
    };
    const ws = longest("W"), ls = longest("L");
    if (ws.max) add("green", "trend", "Longest Winning Streak", ws.ties.map((r) => r.t), `${ws.max} games`, ws.ties.map((r) => `${r.t.name}, ${wk(r)}`).join(" · "));
    if (ls.max) add("pink", "down", "Longest Losing Streak", ls.ties.map((r) => r.t), `${ls.max} games`, ls.ties.map((r) => `${r.t.name}, ${wk(r)}`).join(" · "));
    const hot = streakLeader();
    if (hot) add("green", "flame", "In Form", hot, hot.streak, "Longest current winning run.");
    const spoon = T[T.length - 1];
    add("pink", "spoon", "Wooden Spoon", spoon, `${spoon.w}-${spoon.l}`, "Bottom of the table. Plenty of season left, maybe.");
    const ledger = faabLedger();
    const spender = top((t) => ledger[t.rosterId].paid);
    add("gold", "cash", "Chequebook Manager", spender, "$" + ledger[spender.rosterId].paid, `Most FAAB paid in winning bids, across ${ledger[spender.rosterId].signings} signings.`);
    const bids = state.txns.filter((t) => t.type === "waiver" && t.settings && t.settings.waiver_bid);
    const recordBid = [...bids].sort((a, b) => b.settings.waiver_bid - a.settings.waiver_bid)[0];
    if (recordBid) {
      const p = state.players[Object.keys(recordBid.adds || {})[0]];
      add("gold", "pen", "Record Signing", state.byRoster[recordBid.roster_ids[0]], "$" + recordBid.settings.waiver_bid, `${p ? p.n : "A mystery man"}, the league's most expensive signing.`);
    }
    const counts = {};
    state.txns.forEach((t) => t.roster_ids.forEach((id) => (counts[id] = (counts[id] || 0) + 1)));
    const busy = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (busy) add("cyan", "swap", "Super Agent", state.byRoster[busy[0]], busy[1] + " moves", "Most active in the window. Never met a free agent they didn't like.");

    // --- from logged matchups ---
    const LOCKED = ["Biggest Blowout", "Closest Game", "Highest Score of the Season", "Lowest Winning Score", "Highest Scoring Matchup",
      "Lowest Scoring Matchup", "Most Inconsistent Scorer", "Most Consistent Scorer", "Costliest Bench Blunder", "Robbed by the Bench"];
    if (state.hasResults) {
      const M = state.results.map((m) => {
        const homeWon = m.homePts >= m.awayPts;
        return { ...m, win: homeWon ? m.home : m.away, loss: homeWon ? m.away : m.home, wp: Math.max(m.homePts, m.awayPts), lp: Math.min(m.homePts, m.awayPts) };
      });
      const extreme = (list, f, dir) => { const v = dir * Math.max(...list.map((x) => dir * f(x))); return { v, ties: list.filter((x) => Math.abs(f(x) - v) < 0.005) }; };
      const game = (m) => `${teamName(m.win)} ${num(m.wp)}–${num(m.lp)} ${teamName(m.loss)}, GW ${m.week}`;
      const winners = (ties) => ties.map((m) => state.byRoster[m.win]);

      const blow = extreme(M, (m) => m.wp - m.lp, 1);
      add("pink", "swords", "Biggest Blowout", winners(blow.ties), "+" + num(blow.v), blow.ties.map(game).join(" · "));
      const close = extreme(M, (m) => m.wp - m.lp, -1);
      add("cyan", "ruler", "Closest Game", winners(close.ties), num(close.v), close.ties.map(game).join(" · "));
      const scores = M.flatMap((m) => [{ id: m.home, s: m.homePts, week: m.week }, { id: m.away, s: m.awayPts, week: m.week }]);
      const hi = extreme(scores, (s) => s.s, 1);
      add("green", "zap", "Highest Score of the Season", hi.ties.map((s) => state.byRoster[s.id]), num(hi.v), hi.ties.map((s) => `GW ${s.week}`).join(" · "));
      const lowWin = extreme(M, (m) => m.wp, -1);
      add("gold", "pen", "Lowest Winning Score", winners(lowWin.ties), num(lowWin.v), lowWin.ties.map(game).join(" · "));
      const hiT = extreme(M, (m) => m.wp + m.lp, 1);
      add("green", "flame", "Highest Scoring Matchup", winners(hiT.ties), num(hiT.v), hiT.ties.map(game).join(" · "));
      const loT = extreme(M, (m) => m.wp + m.lp, -1);
      add("pink", "rain", "Lowest Scoring Matchup", winners(loT.ties), num(loT.v), loT.ties.map(game).join(" · "));
      const sd = T.filter((t) => t.stdDev != null);
      if (sd.length) {
        const inc = extreme(sd, (t) => t.stdDev, 1), con = extreme(sd, (t) => t.stdDev, -1);
        add("pink", "wave", "Most Inconsistent Scorer", inc.ties, num(inc.v) + " sd", "Biggest week-to-week swings.");
        add("cyan", "scale", "Most Consistent Scorer", con.ties, num(con.v) + " sd", "Metronomic. You know what you're getting.");
      }
      const lg = T.flatMap((t) => t.games.filter((g) => Number.isFinite(g.best)).map((g) => ({ t, ...g })));
      if (lg.length) {
        const blunder = extreme(lg, (g) => g.best - g.score, 1);
        add("pink", "bench", "Costliest Bench Blunder", blunder.ties.map((g) => g.t), num(blunder.v), blunder.ties.map((g) => `Scored ${num(g.score)} with ${num(g.best)} available, GW ${g.week}`).join(" · "));
        const maxR = Math.max(...T.map((t) => t.robbed));
        if (maxR > 0) add("pink", "down", "Robbed by the Bench", T.filter((t) => t.robbed === maxR), `${maxR} loss${maxR > 1 ? "es" : ""}`, "Defeats that the best lineup would have won.");
      }
    }
    const unlocked = new Set(cards.map((c) => c.title));
    const locked = LOCKED.filter((l) => !unlocked.has(l));

    // ---- render as a stadium scoreboard: a rotating spotlight plus a split-flap board ----
    cards.forEach((c) => (c.cat = CAT_OF[c.title] || "glory"));
    const lockedRows = locked.map((title) => ({ title, cat: CAT_OF[title] || "matchday", locked: true }));
    recState.cards = cards;
    recState.rows = [...cards, ...lockedRows];
    renderRecordRows();
    setSpot(recState.spot < cards.length ? recState.spot : 0, false);
    startSpot();
  }

  // --- split-flap tiles ---
  const FLAP_DIGITS = "0123456789", FLAP_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function flaps(text) {
    return `<span class="flaps" aria-hidden="true">${String(text).toUpperCase().split("").map((ch) =>
      ch === " " ? `<span class="flap flap--gap"></span>` : `<span class="flap" data-c="${esc(ch)}">${esc(ch)}</span>`).join("")}</span>`;
  }
  // each tile cycles through random characters, then lands on its own, left to right
  function spinFlaps(root, delay = 0) {
    if (reduceMotion()) return;
    $$(".flap[data-c]", root).forEach((tile, i) => {
      const final = tile.dataset.c;
      const pool = /\d/.test(final) ? FLAP_DIGITS : /[A-Z]/.test(final) ? FLAP_LETTERS : null;
      if (!pool) return;
      clearTimeout(tile._t);
      let n = 5 + i * 2;
      tile.classList.add("is-spin");
      const tick = () => {
        if (n-- <= 0) { tile.textContent = final; tile.classList.remove("is-spin"); tile.classList.add("is-land"); setTimeout(() => tile.classList.remove("is-land"), 250); return; }
        tile.textContent = pool[(Math.random() * pool.length) | 0];
        tile._t = setTimeout(tick, 42);
      };
      tile._t = setTimeout(tick, delay + i * 28);
    });
  }

  const recState = { cards: [], rows: [], spot: 0, filter: "all", timer: 0, paused: false, hover: false };
  const who = (c) => [...new Set(c.who)];
  function renderRecordRows() {
    const el = $("#recRows");
    if (!el) return;
    const rows = recState.rows.filter((r) => recState.filter === "all" || r.cat === recState.filter);
    el.innerHTML = rows.map((r) => r.locked
      ? `<li class="rec-row is-locked cat-${r.cat}">
          <span class="rec-row__light" aria-hidden="true"></span>
          <span class="rec-row__title">${esc(r.title)}</span>
          <span class="rec-row__who"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>Needs matchups</span>
          <span class="rec-row__val">${flaps("---")}</span>
        </li>`
      : `<li><button type="button" class="rec-row cat-${r.cat}${recState.cards.indexOf(r) === recState.spot ? " is-on" : ""}" data-i="${recState.cards.indexOf(r)}" aria-label="${esc(r.title)}: ${esc(who(r).map((t) => t.name).join(" and "))}, ${esc(r.val)}. Show in spotlight">
          <span class="rec-row__light" aria-hidden="true"></span>
          <span class="rec-row__title">${esc(r.title)}</span>
          <span class="rec-row__who">${who(r).slice(0, 2).map((t) => crest(t)).join("")}<span>${who(r).map(club).join(" & ")}</span></span>
          <span class="rec-row__val">${flaps(r.val)}</span>
        </button></li>`).join("");
    if (el.dataset.seen) $$(".rec-row", el).forEach((row, i) => spinFlaps(row, i * 70));
  }
  function setSpot(i, manual) {
    const spot = $("#recSpot");
    if (!spot || !recState.cards.length) return;
    recState.spot = (i + recState.cards.length) % recState.cards.length;
    const c = recState.cards[recState.spot];
    spot.dataset.cat = c.cat;
    $("#spotCat").textContent = CATS[c.cat];
    $("#spotTitle").textContent = c.title;
    $("#spotVal").innerHTML = flaps(c.val);
    $("#spotVal").setAttribute("aria-label", c.val);
    $("#spotWho").innerHTML = who(c).slice(0, 3).map((t) => crest(t, "lg")).join("") + `<b>${who(c).map(club).join(" & ")}</b>`;
    $("#spotBlurb").textContent = c.blurb;
    $("#spotCount").textContent = `${recState.spot + 1} / ${recState.cards.length}`;
    $("#spotIcon").innerHTML = ICONS[c.icon] || "";
    spot.setAttribute("aria-live", manual ? "polite" : "off");
    const body = $(".rec-spot__body", spot);
    body.classList.remove("is-in"); void body.offsetWidth; body.classList.add("is-in");
    spinFlaps($("#spotVal"));
    const prog = $("#spotProg"); prog.classList.remove("is-run"); void prog.offsetWidth;
    if (spotRunning()) prog.classList.add("is-run");
    $$(".rec-row[data-i]").forEach((r) => r.classList.toggle("is-on", +r.dataset.i === recState.spot));
  }
  const SPOT_MS = 7000;
  const spotRunning = () => !recState.paused && !recState.hover && !reduceMotion() && recState.cards.length > 1;
  function startSpot() {
    clearInterval(recState.timer);
    const prog = $("#spotProg");
    if (!prog) return;
    prog.classList.remove("is-run"); void prog.offsetWidth;
    if (!spotRunning()) return;
    prog.classList.add("is-run");
    recState.timer = setInterval(() => setSpot(recState.spot + 1, false), SPOT_MS);
  }
  function bindRecords() {
    const spot = $("#recSpot");
    if (!spot) return;
    $("#spotPrev").addEventListener("click", () => { setSpot(recState.spot - 1, true); startSpot(); });
    $("#spotNext").addEventListener("click", () => { setSpot(recState.spot + 1, true); startSpot(); });
    const pause = $("#spotPause");
    pause.hidden = reduceMotion();
    pause.addEventListener("click", () => {
      recState.paused = !recState.paused;
      pause.setAttribute("aria-pressed", String(recState.paused));
      pause.setAttribute("aria-label", recState.paused ? "Play spotlight rotation" : "Pause spotlight rotation");
      pause.innerHTML = recState.paused ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3l9 5-9 5z"/></svg>' : '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/></svg>';
      startSpot();
    });
    // rotation holds while the pointer or keyboard focus is on the spotlight
    const hold = (v) => { recState.hover = v; startSpot(); };
    spot.addEventListener("pointerenter", () => hold(true));
    spot.addEventListener("pointerleave", () => hold(false));
    spot.addEventListener("focusin", () => hold(true));
    spot.addEventListener("focusout", (e) => { if (!spot.contains(e.relatedTarget)) hold(false); });
    $("#recRows").addEventListener("click", (e) => {
      const row = e.target.closest(".rec-row[data-i]");
      if (!row) return;
      setSpot(+row.dataset.i, true); startSpot();
      const r = spot.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) spot.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
    });
    $$("#recFilters .chip").forEach((c) => c.addEventListener("click", () => {
      recState.filter = c.dataset.filter;
      $$("#recFilters .chip").forEach((x) => { x.classList.toggle("is-active", x === c); x.setAttribute("aria-pressed", String(x === c)); });
      renderRecordRows();
    }));
    // flip the whole board the first time it scrolls into view
    new IntersectionObserver(([e], io) => {
      if (!e.isIntersecting) return;
      $("#recRows").dataset.seen = "1";
      $$(".rec-row", $("#recRows")).forEach((row, i) => spinFlaps(row, i * 70));
      io.disconnect();
    }, { threshold: 0.15 }).observe($("#recRows"));
  }
  bindRecords();

  // ---------- McQUEEN CUP ----------
  const ROUND_BY_TIES = { 8: "Round of 16", 4: "Quarterfinals", 2: "Semifinals", 1: "Final" };
  function buildCup() {
    const rows = state.cupRows || [];
    const levels = [];
    for (let ties = state.teams.length / 2; ties >= 1; ties /= 2) {
      const name = ROUND_BY_TIES[ties] || `Round of ${ties * 2}`;
      const mine = rows.filter((r) => r.round === name);
      const drawn = mine.filter((r) => state.byRoster[r.a] && state.byRoster[r.b]);
      const sched = mine.filter((r) => !(state.byRoster[r.a] && state.byRoster[r.b]));
      const map = new Map();
      drawn.forEach((r) => {
        const key = [r.a, r.b].sort((x, y) => x - y).join("-");
        if (!map.has(key)) map.set(key, { ids: [r.a, r.b], legs: [] });
        map.get(key).legs.push(r);
      });
      const real = [...map.values()].map((t) => {
        t.legs.sort((x, y) => x.leg - y.leg);
        const agg = { [t.ids[0]]: 0, [t.ids[1]]: 0 };
        const played = t.legs.filter((l) => l.played !== false);
        played.forEach((l) => { agg[l.a] += Number(l.aPts) || 0; agg[l.b] += Number(l.bPts) || 0; });
        const complete = played.length >= 2;
        const [a, b] = t.ids;
        const winner = complete && agg[a] !== agg[b] ? (agg[a] > agg[b] ? a : b) : null;
        return { real: true, ids: t.ids, legs: t.legs, agg, complete, winner };
      });
      const tbd = Array.from({ length: Math.max(0, ties - real.length) }, (_, i) => {
        const weeks = {};
        sched.forEach((r) => { const byLeg = sched.filter((x) => x.leg === r.leg); if (byLeg[i] && byLeg[i].week) weeks[r.leg] = byLeg[i].week; });
        return { real: false, weeks };
      });
      levels.push({ name, ties: [...real, ...tbd] });
    }
    levels.forEach((lv) => lv.ties.forEach((t) => {
      if (!t.real) return;
      t.ids.forEach((id) => {
        const opp = t.ids.find((x) => x !== id);
        const team = state.byRoster[id];
        if (team) team.cupStatus = { round: lv.name, opp, result: !t.complete ? "pending" : t.winner === id ? "won" : "lost" };
      });
    }));
    return levels;
  }
  // the McQueen Cup itself (media/mcqueen-cup.png, background removed); a glint sweeps across it
  const CUP_IMG = "media/mcqueen-cup.png";
  const LEAGUE_IMG = "media/league-trophy.png";   // the Mater League trophy (background removed)
  const TROPHY = `<span class="final-trophy" aria-hidden="true"><img src="${CUP_IMG}" alt="" width="289" height="497"></span>`;

  function tieCard(t) {
    const CHECK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>`;
    if (!t.real) {
      const wk = Object.keys(t.weeks).sort().map((l) => `Leg ${l} · GW ${t.weeks[l]}`).join(" · ");
      return `<div class="tie tie--tbd"><div class="tie__row"><span class="tie__crest"></span><span class="tie__name">TBD</span><span class="tie__agg">–</span></div>
        <div class="tie__row"><span class="tie__crest"></span><span class="tie__name">TBD</span><span class="tie__agg">–</span></div>
        <p class="tie__meta">${wk || "Awaiting random draw"}</p></div>`;
    }
    const legs = t.legs.map((l) => (l.played === false
      ? `Leg ${l.leg}${l.week ? ` · GW ${l.week}` : ""}`
      : `Leg ${l.leg}: ${num(l.aPts)}–${num(l.bPts)}`)).join(" · ");
    const meta = t.complete ? (t.winner ? `Won on aggregate · ${legs}` : `Level on aggregate · ${legs}`)
      : t.legs.length < 2 ? `${legs} · Leg 2 to come` : legs;
    return `<div class="tie">${t.ids.map((id) => `<div class="tie__row ${t.winner === id ? "is-win" : t.winner ? "is-out" : ""}">
        ${crest(state.byRoster[id])}<span class="tie__name">${clubById(id)}${t.winner === id ? `<span class="visually-hidden"> (through)</span>` : ""}</span>
        <span class="tie__agg">${num(t.agg[id])}</span>${t.winner === id ? CHECK : ""}</div>`).join("")}
      <p class="tie__meta">${meta}</p></div>`;
  }
  // ---- cup calendar: every marquee leg, gameweek by gameweek ----
  const ROUND_SHORT = { Quarterfinals: "QF", Semifinals: "SF", Final: "Final" };
  function renderCupCalendar() {
    const el = $("#cupCal");
    if (!el) return;
    const rows = [...(state.cupRows || [])].sort((x, y) => x.week - y.week);
    const next = rows.find((r) => !r.played && r.week >= state.week);
    el.innerHTML = rows.map((r) => {
      const label = r.round === "Final" ? `Final · Leg ${r.leg}` : `${ROUND_SHORT[r.round] || r.round}${r.tie} · Leg ${r.leg}`;
      const side = (id, pts, won) => id
        ? `<span class="cal__club${won ? " is-win" : ""}">${crest(state.byRoster[id])}<b>${clubById(id)}</b>${r.played ? `<em>${num(pts)}</em>` : ""}</span>`
        : `<span class="cal__club is-tbd"><span class="tie__crest"></span><b>To be drawn</b></span>`;
      const status = r.played ? "Played" : r === next ? "Next up" : r.week < state.week ? "Awaiting score" : "Upcoming";
      return `<li class="cal__row${r === next ? " is-next" : ""}${r.played ? " is-played" : ""}">
        <span class="cal__gw"><small>Gameweek</small><b>${r.week}</b></span>
        <span class="cal__label">${label}<small>${status}</small></span>
        <span class="cal__match">${side(r.a, r.aPts, r.played && r.aPts > r.bPts)}<i>vs</i>${side(r.b, r.bPts, r.played && r.bPts > r.aPts)}</span>
      </li>`;
    }).join("");
  }

  // bracket connector lines: each pair of ties joins the tie it feeds in the next round
  function drawBracketLines() {
    const br = $("#bracket");
    if (!br) return;
    const old = $(".bracket__lines", br);
    if (old) old.remove();
    const box = br.getBoundingClientRect();
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - box.left + br.scrollLeft, r: r.right - box.left + br.scrollLeft, m: (r.top + r.bottom) / 2 - box.top + br.scrollTop };
    };
    const rounds = $$(".bracket__round", br).map((rd) => {
      const stage = $(".final-stage", rd);
      return $$(".tie", rd).map((t) => ({ el: t, edge: stage ? rect(stage).l : null, winner: t.querySelector(".tie__row.is-win") }));
    });
    let d = "", gold = "";
    for (let i = 0; i < rounds.length - 1; i++) {
      rounds[i + 1].forEach((next, k) => {
        const to = rect(next.el), toX = next.edge != null ? next.edge : to.l;
        const feeders = [rounds[i][2 * k], rounds[i][2 * k + 1]].filter(Boolean);
        // into the final stage, meet exactly halfway between the two semi-finals, like a printed bracket
        const toY = next.edge != null && feeders.length === 2 ? (rect(feeders[0].el).m + rect(feeders[1].el).m) / 2 : to.m;
        feeders.forEach((from) => {
          const a = rect(from.el), mid = (a.r + toX) / 2;
          const path = `M${a.r} ${a.m}H${mid}V${toY}H${toX}`;
          from.winner ? (gold += path) : (d += path);
        });
      });
    }
    br.insertAdjacentHTML("afterbegin", `<svg class="bracket__lines" width="${br.scrollWidth}" height="${br.scrollHeight}" aria-hidden="true"><path d="${d}"/><path class="is-through" d="${gold}"/></svg>`);
  }
  let bracketTimer;
  window.addEventListener("resize", () => { clearTimeout(bracketTimer); bracketTimer = setTimeout(drawBracketLines, 150); });

  function renderCup() {
    renderCupCalendar();
    if (!$("#bracket")) return;
    const last = state.cupLevels.length - 1;
    $("#bracket").innerHTML = state.cupLevels.map((lv, li) => {
      if (li === last) {
        const t = lv.ties[0];
        const champ = t && t.winner ? state.byRoster[t.winner] : null;
        return `<div class="bracket__round bracket__round--final">
          <div class="final-stage${champ ? " is-crowned" : ""}">
            <span class="final-stage__flashes" aria-hidden="true"></span>
            <span class="spot spot--l" aria-hidden="true"></span><span class="spot spot--r" aria-hidden="true"></span><span class="spot spot--m" aria-hidden="true"></span>
            <span class="final-stage__pool" aria-hidden="true"></span>
            <p class="final-stage__kicker"><span class="live-dot"></span>${esc(lv.name)}</p>
            ${TROPHY}
            <p class="final-stage__title">${champ ? `${club(champ)} lift the cup` : "One tie. One cup."}</p>
            ${t ? tieCard(t) : ""}
            <p class="final-stage__meta">Two legs. The aggregate winner lifts the McQueen Cup.</p>
          </div>
        </div>`;
      }
      return `<div class="bracket__round">
        <p class="bracket__name">${lv.name}</p>
        <div class="bracket__ties">${lv.ties.map(tieCard).join("")}</div>
      </div><div class="bracket__link" aria-hidden="true"></div>`;
    }).join("");
    requestAnimationFrame(drawBracketLines);
    if (document.fonts) document.fonts.ready.then(drawBracketLines);
  }

  // ---------- VICTORY ROAD ----------
  function renderVictoryRoad() {
    if (!$("#victoryRoad")) return;
    const H = LORE.honours || {};
    const col = (label, list, pending, trophy) => `
      <div class="vr__col reveal">
        <p class="vr__label">${label}</p>
        ${(list && list.length ? [...list].sort((a, b) => b.year - a.year) : [{ year: new Date().getFullYear(), champion: null }]).map((s) => {
          const champ = state.byRoster[rosterOf(s.champion)], ru = state.byRoster[rosterOf(s.runnerUp)];
          return `<div class="vr__season ${champ ? "is-won" : ""}">
            <span class="vr__year">${s.year}</span>
            <img class="vr__trophy vr__trophy--img" src="${trophy}" alt="" loading="lazy">
            <div class="vr__champ">${champ ? crest(champ) : ""}<b>${champ ? club(champ) : "TBD"}</b></div>
            <p class="vr__ru">Runner-up · ${ru ? club(ru) : "TBD"}</p>
            ${champ ? "" : `<span class="vr__status">${pending}</span>`}
          </div>`;
        }).join("")}
      </div>`;
    $("#victoryRoad").innerHTML = col("Mater League Champions", H.league, "Season in progress", LEAGUE_IMG) + col("McQueen Cup Champions", H.cup, "Bracket in progress", CUP_IMG);
  }

  // ---------- MATCHUPS ----------
  // Fixtures come from matchups.csv. lineups.csv holds, per week, the starting XIs (read off Sleeper's
  // matchup screens) plus bench rows (slot BN) that scripts/build-lineups.mjs rebuilds from the draft
  // and transactions, so a bench only ever shows players on that roster at the time.
  const SLOT_ORDER = ["GK", "DEF", "MID", "FWD"];
  const SLOT_NAME = { GK: "Goalkeeper", DEF: "Defence", MID: "Midfield", FWD: "Attack" };
  const mu = { week: null, open: new Set() };
  const optNum = (v) => (v === "" || v == null || isNaN(+v) ? null : +v);
  function squadFor(id, week) {
    const rows = (state.lineups || []).filter((r) => +r.week === week && rosterOf(r.manager) === id)
      .map((r) => ({ pid: r.player_id, name: r.player, slot: r.slot, pts: +r.pts || 0, proj: optNum(r.proj), min: +r.min || 0 }));
    return {
      xi: rows.filter((p) => p.slot !== "BN").sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot)),
      bench: rows.filter((p) => p.slot === "BN"),
    };
  }
  const shape = (xi) => ["DEF", "MID", "FWD"].map((s) => xi.filter((p) => p.slot === s).length).join("-");
  const projTotal = (xi) => (xi.some((p) => p.proj != null) ? xi.reduce((a, p) => a + (p.proj || 0), 0) : null);
  const playerRow = (p, star, extra = "") => `
    <li class="mu-p${p === star ? " is-star" : ""}${p.pts <= 0 ? " is-blank" : ""}${extra}">
      <button type="button" class="mu-p__btn" data-pid="${esc(p.pid)}" aria-label="${esc(p.name)}: ${num(p.pts)} points. Open recent games">
        <span class="mu-p__photo" data-photo="${esc(p.pid)}" aria-hidden="true"><span>${esc(initials(p.name))}</span></span>
        <span class="mu-p__name">${esc(p.name)}<small>${p.slot === "BN" ? (p.min ? `${p.min}′ played` : "Did not play") : esc(p.slot)}${p === star ? " · Top scorer" : ""}</small></span>
        <span class="mu-p__pts">${num(p.pts)}<small>${p.proj != null ? `proj ${num(p.proj)}` : "&nbsp;"}</small></span>
      </button>
    </li>`;
  function renderSheet(sq, star) {
    let last = null;
    const xi = sq.xi.map((p) => {
      const head = p.slot !== last ? `<li class="mu-line" aria-hidden="true">${SLOT_NAME[p.slot]}</li>` : "";
      last = p.slot;
      return head + playerRow(p, star);
    }).join("");
    const benchPts = sq.bench.reduce((a, p) => a + p.pts, 0);
    const bench = sq.bench.length ? `
      <li class="mu-line mu-line--bench"><span>Bench</span><small>${num(benchPts)} pts not counted</small></li>
      ${sq.bench.map((p) => playerRow(p, null, " is-bench")).join("")}` : "";
    return `<ol class="mu-sheet__list">${xi}${bench}</ol>`;
  }
  function renderMatchups() {
    const list = $("#muList");
    if (!list) return;
    const weeks = [...new Set(state.results.map((m) => m.week))].sort((a, b) => a - b);
    if (!weeks.length) { list.innerHTML = `<p class="pending-note">No gameweeks logged yet.</p>`; return; }
    const withXI = new Set((state.lineups || []).map((r) => +r.week));
    if (mu.week == null) mu.week = [...weeks].reverse().find((w) => withXI.has(w)) ?? weeks[weeks.length - 1];
    $("#muWeeks").innerHTML = weeks.map((w) => `<button type="button" class="chip${w === mu.week ? " is-active" : ""}" data-week="${w}" aria-pressed="${w === mu.week}">GW${w}${withXI.has(w) ? `<i class="mu-dot" title="Lineups logged"></i>` : ""}</button>`).join("");
    const games = state.results.filter((m) => m.week === mu.week);
    list.innerHTML = games.map((m, gi) => {
      const H = state.byRoster[m.home], A = state.byRoster[m.away];
      const hs = squadFor(m.home, m.week), as = squadFor(m.away, m.week);
      const all = [...hs.xi, ...as.xi];
      const star = all.length ? all.reduce((a, b) => (b.pts > a.pts ? b : a)) : null;
      const key = `${m.week}-${m.home}`, open = mu.open.has(key);
      const side = (t, pts, win, sq, align) => {
        const pj = projTotal(sq.xi);
        return `<div class="mu-side mu-side--${align}${win ? " is-win" : ""}">
          ${crest(t)}<span class="mu-side__name">${club(t)}<small>${sq.xi.length ? shape(sq.xi) : "&nbsp;"}</small></span>
          <span class="mu-side__score"><b>${num(pts, 2)}</b>${pj != null ? `<small>proj ${num(pj, 2)}</small>` : ""}</span>
        </div>`;
      };
      const body = all.length ? `
          <p class="mu-card__motm"><span>Top scorer</span> ${esc(star.name)} <b>${num(star.pts)}</b> for ${club(hs.xi.includes(star) ? H : A)}</p>
          <div class="mu-sheets">
            <section class="mu-sheet" aria-label="${esc(H.name)} team sheet">${renderSheet(hs, star)}</section>
            <section class="mu-sheet" aria-label="${esc(A.name)} team sheet">${renderSheet(as, star)}</section>
          </div>`
        : `<p class="mu-card__none">Starting XIs for this gameweek aren't logged yet.</p>`;
      const derby = H.derby && derbyRival(H) === A ? H.derby : null;
      return `<article class="mu-card reveal${open ? " is-open" : ""}${derby ? " is-derby" : ""}">
        <h2 class="visually-hidden">${esc(H.name)} v ${esc(A.name)}${derby ? `, ${esc(derby.name)}` : ""}</h2>
        ${derby ? `<p class="mu-derby">Derby day <b>${esc(derby.name)}</b>${derby.tag ? `<small>${esc(derby.tag)}</small>` : ""}</p>` : ""}
        <button type="button" class="mu-card__head" aria-expanded="${open}" aria-controls="mu-body-${gi}" data-key="${key}">
          ${side(H, m.homePts, m.homePts > m.awayPts, hs, "home")}
          <span class="mu-card__mid"><span class="mu-card__ft">FT</span><span class="mu-card__chev" aria-hidden="true"></span></span>
          ${side(A, m.awayPts, m.awayPts > m.homePts, as, "away")}
        </button>
        <div class="mu-card__body" id="mu-body-${gi}"${open ? "" : " hidden"}>${body}</div>
      </article>`;
    }).join("");
    $("#muNote").textContent = withXI.has(mu.week)
      ? "Tap a fixture to open both team sheets, then tap any player for recent games. Starting XIs come from Sleeper's matchup screens and add up to each club's score; benches show only players on that roster at the end of the gameweek. Projections are Sleeper's."
      : "";
    observeReveals();
  }
  function paintMatchPhotos(card) {
    if (Object.keys(state.players || {}).length) loadPhotos($$("[data-photo]", card).map((el) => el.dataset.photo), card);
  }

  // ---- player drawer: recent gameweeks from Sleeper's weekly stats ----
  // One column per stat. "Stats" shows the raw count (1 goal = 1); "Fantasy points" shows what that stat
  // was worth under this league's scoring for the position he played (a midfielder's goal = 9), so a
  // row's columns plus "Other" add up to that gameweek's points.
  const STAT_COLS = [["g", "G", "Goals"], ["at", "A", "Assists"], ["sot", "SOT", "Shots on target"], ["kp", "KP", "Key passes"],
    ["tkw", "TKW", "Tackles won"], ["int", "INT", "Interceptions"], ["aer", "AER", "Aerial duels won"], ["clr", "CLR", "Clearances"],
    ["bs", "BS", "Blocked shots"], ["cs", "CS", "Clean sheets"], ["sv", "SV", "Saves"], ["ga", "GA", "Goals conceded"],
    ["dis", "DIS", "Times dispossessed"], ["yc", "YC", "Yellow cards"], ["rc", "RC", "Red cards"]];
  const pd = { mode: (() => { try { return localStorage.getItem("nym-pd-mode") || "stats"; } catch (_) { return "stats"; } })(), rows: null };
  let weeklyStats = null;
  function loadWeeklyStats() {
    if (weeklyStats) return weeklyStats;
    const season = state.league.season, last = (state.league.settings && state.league.settings.last_scored_leg) || Math.max(1, state.week - 1);
    const wk = (kind, w) => get(`/${kind}/${SPORT}/regular/${season}/${w}`).catch(() => ({}));
    weeklyStats = Promise.all(Array.from({ length: last }, (_, i) => Promise.all([wk("stats", i + 1), wk("projections", i + 1)])
      .then(([stats, proj]) => ({ week: i + 1, stats, proj }))));
    return weeklyStats;
  }
  const scorePts = (line) => { const sc = state.league.scoring_settings || {}; let p = 0; for (const [k, v] of Object.entries(line || {})) if (sc[k] !== undefined && typeof v === "number") p += v * sc[k]; return Math.round(p * 100) / 100; };
  // what one stat was worth: the line carries position-scoped keys (pos_m_g, pos_d_cs, ...) that the league scores
  function statPts(line, key) {
    const sc = state.league.scoring_settings || {};
    const pre = Object.keys(line || {}).map((k) => k.match(/^pos_(gk|d|m|f)_/)).find(Boolean);
    if (!pre) return 0;
    const k = pre[0] + key, v = line[k] ?? line[key] ?? 0;
    return (sc[k] || 0) * v;
  }
  function renderPlayerTable() {
    const box = $("#pdTable");
    if (!box || !pd.rows) return;
    const pts = pd.mode === "pts";
    const played = pd.rows.filter((r) => r.line && r.line.min > 0);
    // hide columns this player never registered
    const cols = STAT_COLS.filter(([k]) => played.some((r) => (pts ? statPts(r.line, k) : r.line[k] || 0) !== 0));
    const cell = (r, k) => {
      const v = pts ? statPts(r.line, k) : r.line[k] || 0;
      return `<td class="${v === 0 ? "is-zero" : v < 0 ? "is-neg" : ""}">${v === 0 ? "·" : pts ? num(v) : v}</td>`;
    };
    const other = (r) => Math.round((r.pts - cols.reduce((a, [k]) => a + statPts(r.line, k), 0)) * 100) / 100;
    const showOther = pts && played.some((r) => other(r) !== 0);
    const span = cols.length + (showOther ? 1 : 0);
    box.innerHTML = `<table class="data-table pd__table">
      <caption class="visually-hidden">${pts ? "Fantasy points by stat" : "Stats"} per gameweek</caption>
      <thead><tr><th scope="col">GW</th><th scope="col">Min</th><th scope="col">Pts</th><th scope="col">Proj</th>
        ${cols.map(([, ab, full]) => `<th scope="col" title="${full}"><abbr title="${full}">${ab}</abbr></th>`).join("")}
        ${showOther ? `<th scope="col" title="Everything else the league scores: penalties, crosses, successful dribbles, high claims and more">Other</th>` : ""}</tr></thead>
      <tbody>${pd.rows.map((r) => {
        const on = r.line && r.line.min > 0;
        return `<tr${on ? "" : ' class="is-dnp"'}>
          <th scope="row">GW${r.week}</th><td>${r.line ? r.line.min || 0 : 0}</td><td><b>${on ? num(r.pts) : "DNP"}</b></td>
          <td>${r.proj != null ? num(r.proj) : "–"}</td>
          ${on ? cols.map(([k]) => cell(r, k)).join("") + (showOther ? `<td class="${other(r) === 0 ? "is-zero" : other(r) < 0 ? "is-neg" : ""}">${other(r) === 0 ? "·" : num(other(r))}</td>` : "")
            : `<td colspan="${Math.max(1, span)}" class="pd__dnp">Did not play</td>`}
        </tr>`;
      }).join("")}</tbody>
    </table>`;
    $$("#pdMode .chip").forEach((c) => { const on = c.dataset.mode === pd.mode; c.classList.toggle("is-active", on); c.setAttribute("aria-pressed", String(on)); });
  }
  async function openPlayer(pid, fallbackName) {
    const dlg = $("#playerDlg");
    const p = state.players[pid] || {};
    const name = p.n || fallbackName || "Player";
    const owner = state.teams.find((t) => (t.players || []).includes(pid));
    pd.rows = null;
    $("#playerDlgBody").innerHTML = `
      <header class="pd__head">
        <span class="pd__photo" data-photo="${esc(pid)}" aria-hidden="true"><span>${esc(initials(name))}</span></span>
        <div><h2 class="pd__name" id="playerDlgTitle">${esc(name)}</h2>
          <p class="pd__meta">${clubLogo(p.t)}${esc(p.c || "")}${p.p ? ` · ${esc(p.p)}` : ""} · ${owner ? `${crest(owner)}${club(owner)}` : `<span class="fa-tag">Free agent</span>`}</p></div>
      </header>
      <div class="pd__body"><div class="skeleton" style="height:160px"></div></div>`;
    dlg.showModal();
    loadPhotos([pid], dlg);
    const weeks = await loadWeeklyStats();
    if (!dlg.open) return;
    pd.rows = weeks.map(({ week, stats, proj }) => ({ week, line: stats[pid], pts: scorePts(stats[pid]), proj: proj[pid] ? scorePts(proj[pid]) : null }))
      .filter((r) => r.line || r.proj != null).reverse();
    const played = pd.rows.filter((r) => r.line && r.line.min > 0);
    const total = played.reduce((a, r) => a + r.pts, 0);
    $(".pd__body", dlg).innerHTML = `
      <div class="pd__tiles">
        <div class="stat-tile"><span class="stat-tile__label">Season points</span><b class="stat-tile__v">${num(total)}</b></div>
        <div class="stat-tile"><span class="stat-tile__label">Per game</span><b class="stat-tile__v">${played.length ? num(total / played.length) : "–"}</b></div>
        <div class="stat-tile"><span class="stat-tile__label">Games played</span><b class="stat-tile__v">${played.length}</b></div>
      </div>
      <div class="pd__bar">
        <h3 class="pd__sub">Gameweek by gameweek</h3>
        <div class="filters" id="pdMode" role="group" aria-label="Show">
          <button type="button" class="chip" data-mode="stats" aria-pressed="false">Stats</button>
          <button type="button" class="chip" data-mode="pts" aria-pressed="false">Fantasy points</button>
        </div>
      </div>
      ${pd.rows.length ? `<div class="table-scroll" id="pdTable"></div>` : `<p class="pending-note">No Premier League minutes recorded this season.</p>`}`;
    renderPlayerTable();
  }
  document.addEventListener("click", (e) => {
    const wb = e.target.closest("#muWeeks .chip");
    if (wb) { mu.week = +wb.dataset.week; renderMatchups(); return; }
    const head = e.target.closest(".mu-card__head");
    if (head) {
      const card = head.closest(".mu-card"), open = !card.classList.contains("is-open");
      card.classList.toggle("is-open", open);
      head.setAttribute("aria-expanded", String(open));
      $(".mu-card__body", card).hidden = !open;
      open ? mu.open.add(head.dataset.key) : mu.open.delete(head.dataset.key);
      if (open) paintMatchPhotos(card);
      return;
    }
    const mb = e.target.closest("#pdMode .chip");
    if (mb) { pd.mode = mb.dataset.mode; try { localStorage.setItem("nym-pd-mode", pd.mode); } catch (_) {} renderPlayerTable(); return; }
    const pb = e.target.closest(".mu-p__btn");
    if (pb) { openPlayer(pb.dataset.pid, $(".mu-p__name", pb).firstChild.textContent.trim()); return; }
    if (e.target.id === "playerDlg" || e.target.closest(".pd__close")) $("#playerDlg").close();
  });

  // ---------- ANALYTICS ----------
  const tip = $("#tooltip");
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 14)) + "px";
    tip.style.top = Math.max(8, y - r.height - 12) + "px";
  }
  const hideTip = () => { tip.hidden = true; };
  // hover and keyboard focus both show the same tooltip
  function bindTip(root, sel, htmlFor) {
    root.addEventListener("pointermove", (e) => { const t = e.target.closest(sel); t ? showTip(htmlFor(t), e.clientX, e.clientY) : hideTip(); });
    root.addEventListener("pointerdown", (e) => { const t = e.target.closest(sel); if (t) showTip(htmlFor(t), e.clientX, e.clientY); });
    root.addEventListener("pointerleave", hideTip);
    root.addEventListener("focusin", (e) => { const t = e.target.closest(sel); if (!t) return; const r = t.getBoundingClientRect(); showTip(htmlFor(t), r.left + r.width / 2, r.top); });
    root.addEventListener("focusout", hideTip);
  }

  // ---------- WEEK BY WEEK ----------
  // One focus club scopes every chart below: it's drawn in its colour, the rest in grey.
  const DIV = { pos: "#3a6cc0", neg: "#c8102e" };                          // diverging poles (validated)
  const SEQ = ["#9aaec9", "#7089ae", "#4d6a96", "#2c4b76", "#0b1f3a"];     // navy sequential ramp (validated)
  const wkState = { team: null };
  const focusTeam = () => state.byRoster[wkState.team] || state.teams[0];
  const playedWeeks = () => [...new Set(state.results.map((m) => m.week))].sort((a, b) => a - b);
  const gameIn = (t, w) => t.games.find((g) => g.week === w);
  const avgIn = (w) => { const s = state.teams.map((t) => gameIn(t, w)).filter(Boolean).map((g) => g.score); return s.reduce((a, b) => a + b, 0) / (s.length || 1); };
  const rankIn = (g, w) => state.teams.map((t) => gameIn(t, w)).filter(Boolean).filter((o) => o.score > g.score).length + 1;
  const seasonAvg = (t) => t.games.reduce((a, g) => a + g.score, 0) / (t.games.length || 1);
  const ord = (n) => n + ((n % 100 > 10 && n % 100 < 14) ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
  // expected wins: each week, the share of the other clubs this score would have beaten (ties count half)
  function expectedWins(t) {
    return t.games.reduce((sum, g) => {
      const others = state.teams.filter((o) => o !== t).map((o) => gameIn(o, g.week)).filter(Boolean);
      if (!others.length) return sum;
      return sum + others.reduce((a, o) => a + (o.score < g.score ? 1 : o.score === g.score ? 0.5 : 0), 0) / others.length;
    }, 0);
  }
  const wins = (t) => t.games.filter((g) => g.res === "W").length + t.games.filter((g) => g.res === "D").length / 2;
  const winsTxt = (t) => String(Math.round(wins(t) * 10) / 10);
  const bench = (g) => (Number.isFinite(g.best) ? Math.max(0, g.best - g.score) : null);
  const signed = (n, d = 2) => (n > 0.005 ? "+" : n < -0.005 ? "−" : "") + num(Math.abs(n), d);
  function dataTable(caption, head, rows) {
    return `<div class="table-scroll"><table class="data-table"><caption>${caption}</caption><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${c}</td>` : `<th scope="row">${c}</th>`)).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  // every chart card has a Table button; the chosen view survives re-renders
  function mountChart(el, viz, table) {
    const showTable = el.dataset.view === "table";
    el.innerHTML = `<div class="viz"${showTable ? " hidden" : ""}>${viz}</div><div class="viz-table"${showTable ? "" : " hidden"}>${table}</div>`;
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".chart-toggle");
    if (!b) return;
    const el = document.getElementById(b.getAttribute("aria-controls"));
    if (!el || !$(".viz", el)) return;
    const table = el.dataset.view !== "table";
    el.dataset.view = table ? "table" : "chart";
    $(".viz", el).hidden = table; $(".viz-table", el).hidden = !table;
    b.setAttribute("aria-pressed", String(table)); b.textContent = table ? "Chart" : "Table";
    hideTip();
  });

  // SVG charts are drawn at the card's real width so their text stays 12-13px on phones
  const chartWidth = (el, max) => Math.round(Math.min(max, Math.max(300, el.clientWidth || max)));
  // gameweek labels: every week while they fit (~44px each), otherwise every 2nd/3rd... plus the last
  function weekTicks(weeks, span) {
    const every = Math.max(1, Math.ceil(weeks.length / Math.max(1, Math.floor(span / 44))));
    return weeks.map((w, i) => [w, i]).filter(([, i]) => i % every === 0 || i === weeks.length - 1);
  }
  let wkResize = 0, wkWidth = 0;
  window.addEventListener("resize", () => {
    clearTimeout(wkResize);
    wkResize = setTimeout(() => {
      const el = $("#scoreChart");
      if (!el || !state.rankHistory || Math.abs(el.clientWidth - wkWidth) < 24) return;
      wkWidth = el.clientWidth; renderScoreChart(); renderRankChart();
    }, 150);
  });

  function renderWkTiles() {
    const el = $("#wkTiles");
    if (!el) return;
    const t = focusTeam(), G = t.games;
    if (!G.length) { el.innerHTML = ""; return; }
    const avg = seasonAvg(t);
    const avgRank = state.teams.filter((o) => seasonAvg(o) > avg).length + 1;
    const best = [...G].sort((a, b) => b.score - a.score)[0];
    const xw = expectedWins(t), luck = wins(t) - xw;
    const benchPts = G.map(bench).filter((x) => x != null);
    const benchSum = benchPts.reduce((a, b) => a + b, 0);
    const tile = (v, label, sub) => `<div class="stat-tile"><span class="stat-tile__label">${label}</span><b class="stat-tile__v">${v}</b><span class="stat-tile__sub">${sub}</span></div>`;
    el.innerHTML = tile(num(avg), "Average score", `${ord(avgRank)} of ${state.teams.length} in the league`)
      + tile(num(best.score), "Best week", `Gameweek ${best.week} vs ${clubById(best.opp)}`)
      + tile(signed(luck), "Luck", `${winsTxt(t)} ${wins(t) === 1 ? "win" : "wins"} from ${num(xw)} expected`)
      + tile(benchPts.length ? num(benchSum) : "–", "Left on the bench", benchPts.length ? `${num(benchSum / benchPts.length)} a gameweek` : "Needs best lineups");
  }

  // weekly scores: focus club in colour, other clubs grey, league average as a neutral reference
  function renderScoreChart() {
    const el = $("#scoreChart");
    if (!el) return;
    const weeks = playedWeeks(), me = focusTeam();
    if (!weeks.length) { el.innerHTML = `<p class="pending-note">No gameweeks logged yet.</p>`; return; }
    const W = chartWidth(el, 760), narrow = W < 520, H = narrow ? 240 : 300, L = 40, R = narrow ? 14 : 104, Tp = 14, B = 30;
    const all = state.results.flatMap((m) => [m.homePts, m.awayPts]);
    const lo = Math.floor(Math.min(...all) / 20) * 20, hi = Math.ceil(Math.max(...all) / 20) * 20;
    const x = (i) => L + (weeks.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (weeks.length - 1));
    const y = (v) => Tp + ((hi - v) * (H - Tp - B)) / (hi - lo || 1);
    const path = (vals) => vals.map((v, i) => (v == null ? "" : `${i && vals[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)).join("");
    const ticks = []; for (let v = lo; v <= hi + 1e-9; v += (hi - lo) / 4) ticks.push(v);
    const series = (t) => weeks.map((w) => { const g = gameIn(t, w); return g ? g.score : null; });
    const avg = weeks.map(avgIn), mine = series(me);
    const others = state.teams.filter((t) => t !== me).map((t) => `<path class="sc__bg" d="${path(series(t))}"/>`).join("");
    const lastI = mine.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0).pop() ?? 0;
    // keep the two end labels from colliding
    let ly1 = y(mine[lastI] ?? avg[lastI]), ly2 = y(avg[weeks.length - 1]);
    if (Math.abs(ly1 - ly2) < 16) { const mid = (ly1 + ly2) / 2, s = ly1 <= ly2 ? -1 : 1; ly1 = mid + s * 8; ly2 = mid - s * 8; }
    const short = me.name.length > 14 ? me.name.slice(0, 13) + "…" : me.name;
    const step = (W - L - R) / Math.max(1, weeks.length - 1);
    const viz = `
      <p class="viz-legend"><span><i class="sw" style="background:${me.color}"></i>${club(me)}</span><span><i class="sw sw--line sw--avg"></i>League average</span><span><i class="sw sw--line sw--bg"></i>Other clubs</span></p>
      <svg class="sc" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly scores for ${esc(me.name)} against the league average">
        ${ticks.map((v) => `<line class="ax__grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax__t" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${num(v, 0)}</text>`).join("")}
        ${weekTicks(weeks, W - L - R).map(([w, i]) => `<text class="ax__t" x="${x(i)}" y="${H - 8}" text-anchor="middle">GW${w}</text>`).join("")}
        <line class="ax__cross" x1="0" x2="0" y1="${Tp}" y2="${H - B}" visibility="hidden"/>
        ${others}
        <path class="sc__avg" d="${path(avg)}"/>
        <path class="sc__me" style="--c:${me.color}" d="${path(mine)}"/>
        ${mine.map((v, i) => (v == null ? "" : `<circle class="sc__dot" style="--c:${me.color}" cx="${x(i)}" cy="${y(v)}" r="5"/>`)).join("")}
        ${narrow ? "" : `<text class="sc__lbl" x="${x(lastI) + 12}" y="${ly1 + 4}">${esc(short)}</text>
        <text class="sc__lbl sc__lbl--avg" x="${x(weeks.length - 1) + 12}" y="${ly2 + 4}">League avg</text>`}
        ${weeks.map((w, i) => `<rect class="ax__hit" data-i="${i}" x="${x(i) - step / 2}" y="0" width="${step}" height="${H}"/>`).join("")}
      </svg>`;
    const table = dataTable(`Weekly scores: ${esc(me.name)}`, ["Gameweek", "Score", "League avg", "Difference", "Result"],
      weeks.map((w, i) => { const g = gameIn(me, w); return [`GW${w}`, g ? num(g.score) : "–", num(avg[i]), g ? signed(g.score - avg[i]) : "–", g ? `${g.res} vs ${clubById(g.opp)}` : "–"]; }));
    mountChart(el, viz, table);
    const svg = $(".sc", el);
    const cross = $(".ax__cross", svg);
    const move = (e) => {
      const hit = e.target.closest(".ax__hit");
      if (!hit) return;
      const i = +hit.dataset.i, w = weeks[i], g = gameIn(me, w);
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      showTip(`<b>Gameweek ${w}</b>${g ? `<span class="tt-row"><i style="background:${me.color}"></i>${club(me)} <strong>${num(g.score)}</strong></span><span>${ord(rankIn(g, w))} highest of the week · ${g.res} vs ${clubById(g.opp)}</span>` : ""}<span>League average <strong>${num(avg[i])}</strong></span>`, e.clientX, e.clientY);
    };
    svg.addEventListener("pointermove", move); svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  }

  // luck: diverging bars around zero (actual wins minus expected wins)
  function renderLuckChart() {
    const el = $("#luckChart");
    if (!el) return;
    if (!state.hasResults) { el.innerHTML = `<p class="pending-note">Needs logged matchups.</p>`; return; }
    const me = focusTeam();
    const rows = state.teams.map((t) => ({ t, w: wins(t), x: expectedWins(t) })).map((r) => ({ ...r, d: r.w - r.x })).sort((a, b) => b.d - a.d);
    const span = Math.max(1, ...rows.map((r) => Math.abs(r.d)));
    const viz = `
      <p class="viz-legend"><span><i class="sw" style="background:${DIV.pos}"></i>More wins than their scores earned</span><span><i class="sw" style="background:${DIV.neg}"></i>Fewer</span></p>
      <ul class="lk" role="list">${rows.map((r) => `
        <li class="lk__row${r.t === me ? " is-focus" : ""}" tabindex="0" data-id="${r.t.rosterId}" aria-label="${esc(r.t.name)}: ${signed(r.d)} wins against expected">
          <span class="lk__name">${club(r.t)}</span>
          <span class="lk__track"><span class="lk__zero"></span><span class="lk__bar ${r.d >= 0 ? "is-pos" : "is-neg"}" style="background:${r.d >= 0 ? DIV.pos : DIV.neg};${r.d >= 0 ? "left" : "right"}:50%;width:${(Math.abs(r.d) / span) * 50}%"></span></span>
          <span class="lk__val">${signed(r.d)}</span>
        </li>`).join("")}</ul>`;
    const table = dataTable("Luck: wins against expected wins", ["Club", "Wins", "Expected", "Luck"], rows.map((r) => [esc(r.t.name), winsTxt(r.t), num(r.x), signed(r.d)]));
    mountChart(el, viz, table);
    bindTip(el, ".lk__row", (row) => {
      const r = rows.find((q) => String(q.t.rosterId) === row.dataset.id);
      return `<b>${club(r.t)}</b><span>Actual wins <strong>${winsTxt(r.t)}</strong></span><span>Expected wins <strong>${num(r.x)}</strong></span><span>${r.d >= 0 ? "Luckier" : "Unluckier"} by <strong>${num(Math.abs(r.d))}</strong> wins</span>`;
    });
  }

  // bench points per gameweek for the focus club, with a league-average tick
  function renderBenchChart() {
    const el = $("#benchChart");
    if (!el) return;
    const me = focusTeam(), weeks = playedWeeks();
    const lg = (w) => { const b = state.teams.map((t) => gameIn(t, w)).filter(Boolean).map(bench).filter((v) => v != null); return b.length ? b.reduce((a, c) => a + c, 0) / b.length : null; };
    const cols = weeks.map((w) => { const g = gameIn(me, w); return { w, v: g ? bench(g) : null, avg: lg(w), g }; });
    if (!cols.some((c) => c.v != null)) { el.innerHTML = `<p class="pending-note">Needs best lineups.</p>`; return; }
    const max = (Math.max(...cols.flatMap((c) => [c.v || 0, c.avg || 0])) || 1) * 1.15;  // headroom for the top label
    const top = Math.max(...cols.map((c) => c.v || 0));
    const viz = `
      <p class="viz-legend"><span><i class="sw" style="background:${me.color}"></i>${club(me)}</span><span><i class="sw sw--tick"></i>League average</span></p>
      <div class="bc" role="list">${cols.map((c) => `
        <div class="bc__col" role="listitem" tabindex="0" data-w="${c.w}" aria-label="Gameweek ${c.w}: ${c.v == null ? "no data" : num(c.v) + " points left on the bench"}">
          <span class="bc__plot">
            ${c.v != null ? `<span class="bc__bar" style="background:${me.color};height:${(c.v / max) * 100}%">${c.v === top && top > 0 ? `<em>${num(c.v)}</em>` : ""}</span>` : ""}
            ${c.avg != null ? `<span class="bc__tick" style="bottom:${(c.avg / max) * 100}%"></span>` : ""}
          </span>
          <span class="bc__x">GW${c.w}</span>
        </div>`).join("")}</div>`;
    const table = dataTable(`Left on the bench: ${esc(me.name)}`, ["Gameweek", "Scored", "Best possible", "On the bench", "League avg"],
      cols.map((c) => [`GW${c.w}`, c.g ? num(c.g.score) : "–", c.g && Number.isFinite(c.g.best) ? num(c.g.best) : "–", c.v != null ? num(c.v) : "–", c.avg != null ? num(c.avg) : "–"]));
    mountChart(el, viz, table);
    bindTip(el, ".bc__col", (col) => {
      const c = cols.find((q) => String(q.w) === col.dataset.w);
      return `<b>Gameweek ${c.w}</b>${c.g ? `<span>Scored <strong>${num(c.g.score)}</strong> of ${num(c.g.best)} possible</span>` : ""}<span>Left on the bench <strong>${c.v != null ? num(c.v) : "–"}</strong></span><span>League average <strong>${c.avg != null ? num(c.avg) : "–"}</strong></span>${c.g && c.g.res === "L" && c.g.best > c.g.oppScore ? `<span>The best lineup would have won this one</span>` : ""}`;
    });
  }

  // score grid: clubs × gameweeks, one-hue sequential ramp in five steps
  function renderHeatChart() {
    const el = $("#heatChart");
    if (!el) return;
    const weeks = playedWeeks(), me = focusTeam();
    if (!weeks.length) { el.innerHTML = `<p class="pending-note">No gameweeks logged yet.</p>`; return; }
    const all = state.results.flatMap((m) => [m.homePts, m.awayPts]);
    const lo = Math.min(...all), hi = Math.max(...all);
    const bin = (v) => Math.min(SEQ.length - 1, Math.floor(((v - lo) / (hi - lo || 1)) * SEQ.length));
    const T = [...state.teams].sort((a, b) => seasonAvg(b) - seasonAvg(a));
    const viz = `
      <div class="hm-scroll"><div class="hm" style="--cols:${weeks.length}">
        <span></span>${weeks.map((w) => `<span class="hm__x">GW${w}</span>`).join("")}<span class="hm__x">Avg</span>
        ${T.map((t) => `<span class="hm__y${t === me ? " is-focus" : ""}">${club(t)}</span>${weeks.map((w) => {
          const g = gameIn(t, w);
          return g ? `<span class="hm__c${t === me ? " is-focus" : ""}" data-id="${t.rosterId}" data-w="${w}" style="background:${SEQ[bin(g.score)]}"></span>` : `<span class="hm__c is-empty"></span>`;
        }).join("")}<span class="hm__avg${t === me ? " is-focus" : ""}">${num(seasonAvg(t))}</span>`).join("")}
      </div></div>
      <p class="hm__key"><span>${num(lo)}</span>${SEQ.map((c) => `<i style="background:${c}"></i>`).join("")}<span>${num(hi)}</span></p>`;
    const table = dataTable("Score grid", ["Club", ...weeks.map((w) => `GW${w}`), "Average"],
      T.map((t) => [esc(t.name), ...weeks.map((w) => { const g = gameIn(t, w); return g ? num(g.score) : "–"; }), num(seasonAvg(t))]));
    mountChart(el, viz, table);
    bindTip(el, ".hm__c[data-id]", (c) => {
      const t = state.byRoster[c.dataset.id], w = +c.dataset.w, g = gameIn(t, w);
      return `<b>${club(t)} · GW${w}</b><span>Scored <strong>${num(g.score)}</strong> (${ord(rankIn(g, w))} of the week)</span><span>${g.res === "W" ? "Beat" : g.res === "L" ? "Lost to" : "Drew with"} ${clubById(g.opp)}, ${num(g.oppScore)}</span>`;
    });
  }

  function renderLineupChart() {
    const T = [...state.teams].sort((a, b) => b.pf - a.pf);
    const max = Math.max(...T.map((t) => t.pp || t.pf));
    const el = $("#lineupChart");
    if (!el) return;
    const me = focusTeam();
    const viz = `<p class="viz-legend"><span><i class="sw" style="background:var(--pos)"></i>Points scored</span><span><i class="sw sw--outline"></i>Best possible</span></p>
      <ul class="lc" role="list">${T.map((t) => `
      <li class="lc__row${t === me ? " is-focus" : ""}" tabindex="0" data-id="${t.rosterId}" aria-label="${esc(t.name)}: ${num(t.pf)} of ${num(t.pp)} possible, ${Math.round(eff(t) * 100)}%">
        <span class="lc__name">${club(t)}</span>
        <span class="lc__track">
          <span class="lc__pot" style="width:${(t.pp / max) * 100}%"></span>
          <span class="lc__act" style="width:${(t.pf / max) * 100}%"></span>
        </span>
        <span class="lc__val">${num(t.pf, 0)}<small> / ${num(t.pp, 0)}</small></span>
      </li>`).join("")}</ul>`;
    const table = dataTable("Points scored vs. best possible lineup", ["Club", "Scored", "Best possible", "On the bench", "Efficiency"],
      T.map((t) => [esc(t.name), num(t.pf), num(t.pp), num(t.pp - t.pf), Math.round(eff(t) * 100) + "%"]));
    mountChart(el, viz, table);
    bindTip(el, ".lc__row", (row) => {
      const t = state.byRoster[row.dataset.id];
      return `<b>${club(t)}</b><span>Scored <strong>${num(t.pf)}</strong></span><span>Best possible <strong>${num(t.pp)}</strong></span><span>Left on bench <strong>${num(t.pp - t.pf)}</strong> (${Math.round(eff(t) * 100)}% efficient)</span>`;
    });
  }

  function renderRankChart() {
    const { weeks, hist, exact } = state.rankHistory;
    const el = $("#rankChart");
    if (!el) return;
    const n = state.teams.length, me = focusTeam();
    if (!weeks.length) { el.innerHTML = `<p class="pending-note">No matchweeks played yet.</p>`; return; }
    const W = chartWidth(el, 720), H = W < 520 ? 280 : 340, L = 34, R = 20, Tp = 16, B = 32;
    const x = (i) => L + (weeks.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (weeks.length - 1));
    const y = (r) => Tp + ((r - 1) * (H - Tp - B)) / (n - 1);
    const step = (W - L - R) / Math.max(1, weeks.length - 1);
    // focus club drawn last so it sits on top of the grey lines
    const order = [...state.teams.filter((t) => t !== me), me];
    const lines = order.map((t) => {
      const pts = hist[t.rosterId];
      return `<g class="rk__series${t === me ? " is-on" : ""}" data-id="${t.rosterId}" style="--c:${t.color}">
        <path class="rk__line" d="${pts.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(r).toFixed(1)}`).join("")}"/>
        ${pts.map((r, i) => `<circle class="rk__dot" cx="${x(i)}" cy="${y(r)}" r="4.5"/>`).join("")}
      </g>`;
    }).join("");
    const viz = `
      <div class="rk__legend" role="group" aria-label="Focus a club">${state.teams.map((t) => `<button type="button" class="rk__chip" data-id="${t.rosterId}" aria-pressed="${t === me}" style="--c:${t.color}"><span class="sw"></span>${club(t)}</button>`).join("")}</div>
      <svg class="rk" viewBox="0 0 ${W} ${H}" role="img" aria-label="League position by week, ${esc(me.name)} highlighted">
        ${Array.from({ length: n }, (_, i) => `<line class="ax__grid" x1="${L}" x2="${W - R}" y1="${y(i + 1)}" y2="${y(i + 1)}"/><text class="ax__t" x="${L - 10}" y="${y(i + 1) + 4}" text-anchor="end">${i + 1}</text>`).join("")}
        ${weekTicks(weeks, W - L - R).map(([w, i]) => `<text class="ax__t" x="${x(i)}" y="${H - 8}" text-anchor="middle">GW${w}</text>`).join("")}
        <line class="ax__cross" x1="0" x2="0" y1="${Tp - 6}" y2="${H - B + 6}" visibility="hidden"/>
        ${lines}
        ${weeks.map((w, i) => `<rect class="ax__hit" data-i="${i}" x="${x(i) - step / 2}" y="0" width="${step}" height="${H}"/>`).join("")}
      </svg>
      ${exact ? "" : `<p class="chart-note">Until matchups are logged, positions use each week's wins with ties split by season points for.</p>`}`;
    const table = dataTable("League position by week", ["Club", ...weeks.map((w) => `GW${w}`)], state.teams.map((t) => [esc(t.name), ...hist[t.rosterId]]));
    mountChart(el, viz, table);

    const svg = $(".rk", el), cross = $(".ax__cross", svg);
    // hovering a chip previews that club; clicking makes it the focus club for the whole section
    const preview = (id) => $$(".rk__series", el).forEach((g) => g.classList.toggle("is-on", g.dataset.id === String(id ?? me.rosterId)));
    $$(".rk__chip", el).forEach((c) => {
      c.addEventListener("click", () => setFocus(c.dataset.id));
      c.addEventListener("pointerenter", () => preview(c.dataset.id));
      c.addEventListener("pointerleave", () => preview(null));
    });
    const move = (e) => {
      const hit = e.target.closest(".ax__hit");
      if (!hit) return;
      const i = +hit.dataset.i;
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      const byRank = [...state.teams].sort((a, b) => hist[a.rosterId][i] - hist[b.rosterId][i]);
      showTip(`<b>Gameweek ${weeks[i]}</b>${byRank.map((t) => `<span class="tt-row${t === me ? " is-me" : ""}"><i style="background:${t === me ? t.color : "rgba(255,255,255,0.35)"}"></i>${hist[t.rosterId][i]}. ${club(t)}</span>`).join("")}`, e.clientX, e.clientY);
    };
    svg.addEventListener("pointermove", move); svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  }

  function setFocus(id) {
    wkState.team = +id;
    const sel = $("#wkTeam");
    if (sel) sel.value = String(id);
    renderWeekly();
  }
  function renderWeekly() {
    const sel = $("#wkTeam");
    if (wkState.team == null) wkState.team = (state.teams.find((t) => t.manager.toLowerCase() === "nicog01") || state.teams[0]).rosterId;
    if (sel && !sel.options.length) {
      sel.innerHTML = [...state.teams].sort((a, b) => a.name.localeCompare(b.name)).map((t) => `<option value="${t.rosterId}">${esc(t.name)}</option>`).join("");
      sel.value = String(wkState.team);
      sel.addEventListener("change", () => setFocus(sel.value));
    }
    renderWkTiles(); renderScoreChart(); renderLuckChart(); renderBenchChart(); renderHeatChart(); renderLineupChart(); renderRankChart();
  }

  // ---------- DATA HUB ----------
  // Sleeper gives per-player, per-gameweek match stats. It doesn't expose past lineups, so a
  // club's numbers are what its CURRENT players have produced this season: either the current
  // XI or the whole squad. "good: -1" means lower is better (conceded, cards, dispossessed).
  const HUB_METRICS = [
    { group: "Overall", key: "fpts", label: "Fantasy points", dp: 1 },
    { group: "Overall", key: "min", label: "Minutes played", dp: 0 },
    { group: "Attack", key: "g", label: "Goals", dp: 0 },
    { group: "Attack", key: "xg", label: "Expected goals (xG)", dp: 2 },
    { group: "Attack", key: "sat", label: "Shots", dp: 0 },
    { group: "Attack", key: "sot", label: "Shots on target", dp: 0 },
    { group: "Creativity", key: "at", label: "Assists", dp: 0 },
    { group: "Creativity", key: "xa", label: "Expected assists (xA)", dp: 2 },
    { group: "Creativity", key: "kp", label: "Key passes", dp: 0 },
    { group: "Defence & goalkeeping", key: "cs", label: "Clean sheets (DEF & GK)", dp: 0, pos: ["D", "GK"] },
    { group: "Defence & goalkeeping", key: "ga", label: "Goals conceded (DEF & GK)", dp: 0, pos: ["D", "GK"], good: -1 },
    { group: "Defence & goalkeeping", key: "sv", label: "Saves (GK)", dp: 0, pos: ["GK"] },
    { group: "Defence & goalkeeping", key: "tkw", label: "Tackles won", dp: 0 },
    { group: "Defence & goalkeeping", key: "int", label: "Interceptions", dp: 0 },
    { group: "Defence & goalkeeping", key: "clr", label: "Clearances", dp: 0 },
    { group: "Defence & goalkeeping", key: "aer", label: "Aerial duels won", dp: 0 },
    { group: "Defence & goalkeeping", key: "bs", label: "Blocked shots", dp: 0 },
    { group: "Discipline", key: "yc", label: "Yellow cards", dp: 0, good: -1 },
    { group: "Discipline", key: "rc", label: "Red cards", dp: 0, good: -1 },
    { group: "Discipline", key: "dis", label: "Times dispossessed", dp: 0, good: -1 },
  ];
  const hub = { team: null, compare: "avg", scope: "xi", lead: "g", pool: "all" };

  // season totals per player (raw stats + fantasy points under this league's scoring)
  function buildPlayerTotals(statsByWeek, scoring) {
    const out = {};
    for (const week of statsByWeek) {
      for (const [pid, line] of Object.entries(week || {})) {
        const t = (out[pid] ||= { fpts: 0 });
        for (const [k, v] of Object.entries(line)) {
          if (k.startsWith("pos_")) { if (scoring[k] !== undefined) t.fpts += Number(v) * Number(scoring[k]); continue; }
          if (typeof v === "number") t[k] = (t[k] || 0) + v;
        }
      }
    }
    return out;
  }
  // a metric limited to positions counts a player listed at any of them (a DEF/MID counts for defenders)
  const playsIn = (p, pos) => !!p && (p.ps && p.ps.length ? p.ps : [p.p]).some((x) => pos.includes(x));
  function clubValue(t, m, scope) {
    const ids = scope === "xi" ? t.starters : t.players;
    return ids.reduce((sum, pid) => {
      const p = state.players[pid];
      if (m.pos && !playsIn(p, m.pos)) return sum;
      return sum + ((state.playerTotals[pid] || {})[m.key] || 0);
    }, 0);
  }
  const ordinalRank = (vals, v, good) => 1 + vals.filter((x) => (good === -1 ? x < v : x > v)).length;

  function renderHub() {
    const el = $("#hubGroups");
    if (!el || !state.playerTotals) return;
    const T = state.teams;
    const team = state.byRoster[hub.team] || T[0];
    const cmp = hub.compare === "avg" ? null : state.byRoster[hub.compare];
    const rows = HUB_METRICS.map((m) => {
      const vals = T.map((t) => ({ t, v: clubValue(t, m, hub.scope) }));
      const nums = vals.map((x) => x.v);
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
      const mine = vals.find((x) => x.t === team).v;
      const rk = ordinalRank(nums, mine, m.good);
      return { m, vals, avg, mine, rk, lo: Math.min(...nums), hi: Math.max(...nums) };
    });

    // strengths / weaknesses: where this club ranks best and worst
    // skip stats where the club shares its value with 2+ others (e.g. "0 red cards"): not a real edge
    const ranked = rows.filter((r) => r.hi > r.lo && r.vals.filter((x) => x.v === r.mine).length < 3);
    const best = ranked.filter((r) => r.rk <= 2).sort((a, b) => a.rk - b.rk).slice(0, 3);
    const worst = ranked.filter((r) => r.rk >= T.length - 1).sort((a, b) => b.rk - a.rk).slice(0, 3);
    const fmtV = (r, v) => num(v, r.m.dp);
    const chip = (r, cls) => `<li class="hub-chip hub-chip--${cls}"><b>${ordinal(r.rk)}</b> ${esc(r.m.label)} <span>${fmtV(r, r.mine)}</span></li>`;
    $("#hubSummary").innerHTML = `
      <div class="hub-sum">
        ${crest(team, "lg")}
        <div><p class="hub-sum__name">${club(team)}</p>
        <p class="hub-sum__sub">${hub.scope === "xi" ? "Current starting XI" : `Full squad (${team.players.length} players)`}, season to date${cmp ? ` · vs ${club(cmp)}` : " · vs league average"}</p></div>
      </div>
      <div class="hub-sum__lists">
        <div><p class="hub-sum__label hub-sum__label--up">Strengths</p><ul>${best.map((r) => chip(r, "up")).join("") || "<li class=\"hub-chip\">Nothing top-two yet</li>"}</ul></div>
        <div><p class="hub-sum__label hub-sum__label--down">Weaknesses</p><ul>${worst.map((r) => chip(r, "down")).join("") || "<li class=\"hub-chip\">Nothing bottom-two</li>"}</ul></div>
      </div>`;

    const groups = [...new Set(HUB_METRICS.map((m) => m.group))];
    el.innerHTML = groups.map((g) => `
      <section class="hub-group reveal is-in">
        <h3 class="hub-group__title">${g}</h3>
        ${rows.filter((r) => r.m.group === g).map((r) => {
          const span = r.hi - r.lo || 1;
          const pos = (v) => (r.hi === r.lo ? 50 : ((v - r.lo) / span) * 100);
          const other = cmp ? r.vals.find((x) => x.t === cmp).v : r.avg;
          const diff = r.avg ? ((r.mine - r.avg) / r.avg) * 100 : 0;
          const better = r.m.good === -1 ? diff < 0 : diff > 0;
          const diffTxt = Math.abs(diff) < 0.5 ? "on the average" : `${Math.abs(diff).toFixed(0)}% ${diff > 0 ? "above" : "below"} avg`;
          return `<div class="hub-row" tabindex="0" aria-label="${esc(r.m.label)}: ${esc(team.name)} ${fmtV(r, r.mine)}, ${r.hi === r.lo ? "level with every club" : `ranked ${ordinal(r.rk)} of ${T.length}`}. ${cmp ? `${esc(cmp.name)} ${fmtV(r, other)}.` : ""} League average ${fmtV(r, r.avg)}.">
            <span class="hub-row__label">${esc(r.m.label)}${r.m.good === -1 ? ` <small>lower is better</small>` : ""}</span>
            <span class="hub-strip" aria-hidden="true">
              <span class="hub-strip__avg" style="left:${pos(r.avg)}%"></span>
              ${r.vals.filter((x) => x.t !== team && x.t !== cmp).map((x) => `<span class="hub-dot" data-id="${x.t.rosterId}" data-m="${r.m.key}" style="left:${pos(x.v)}%"></span>`).join("")}
              ${cmp ? `<span class="hub-dot hub-dot--cmp" data-id="${cmp.rosterId}" data-m="${r.m.key}" style="left:${pos(other)}%"></span>` : ""}
              <span class="hub-dot hub-dot--me" data-id="${team.rosterId}" data-m="${r.m.key}" style="left:${pos(r.mine)}%"></span>
            </span>
            <span class="hub-row__val"><b>${fmtV(r, r.mine)}</b><small>${cmp ? `vs ${fmtV(r, other)}` : `avg ${fmtV(r, r.avg)}`}</small></span>
            ${r.hi === r.lo
              ? `<span class="hub-row__rank"><b>Level</b><small>all clubs equal</small></span>`
              : `<span class="hub-row__rank ${better ? "is-up" : Math.abs(diff) < 0.5 ? "" : "is-down"}"><b>${ordinal(r.rk)}</b><small>${diffTxt}</small></span>`}
          </div>`;
        }).join("")}
      </section>`).join("");
    $("#hubLegend").innerHTML = `<span class="hub-key hub-key--me"></span>${club(team)}
      ${cmp ? `<span class="hub-key hub-key--cmp"></span>${club(cmp)}` : ""}
      <span class="hub-key hub-key--avg"></span>League average <span class="hub-key hub-key--other"></span>Other clubs`;
    hubRowsCache = rows;
    renderLeaders();
  }
  let hubRowsCache = [];

  function renderLeaders() {
    const el = $("#leaders");
    if (!el) return;
    const m = HUB_METRICS.find((x) => x.key === hub.lead) || HUB_METRICS[2];
    const owner = {};
    state.teams.forEach((t) => t.players.forEach((pid) => (owner[pid] = t)));
    // every player Sleeper has stats for: rostered clubs plus free agents
    const pool = hub.pool === "fa" ? Object.keys(state.playerTotals).filter((pid) => !owner[pid])
      : hub.pool === "rostered" ? Object.keys(owner) : [...new Set([...Object.keys(owner), ...Object.keys(state.playerTotals)])];
    const list = pool
      .map((pid) => ({ pid, p: state.players[pid], v: (state.playerTotals[pid] || {})[m.key] || 0 }))
      .filter((x) => x.p && (!m.pos || playsIn(x.p, m.pos)) && (m.good !== -1 || (state.playerTotals[x.pid] || {}).min > 0))
      .sort((a, b) => (m.good === -1 ? a.v - b.v : b.v - a.v))
      .slice(0, 10);
    el.innerHTML = list.map((x, i) => `
      <li class="lead-row${owner[x.pid] === (state.byRoster[hub.team] || state.teams[0]) ? " is-mine" : ""}">
        <span class="lead-row__rank">${i + 1}</span>
        <span class="lead-row__photo" data-photo="${x.pid}" aria-hidden="true"><span>${esc(initials(x.p.n))}</span></span>
        <span class="lead-row__name">${esc(x.p.n)}<small>${clubLogo(x.p.t)}${esc(x.p.c)} · ${esc(x.p.p)} · ${owner[x.pid] ? `${crest(owner[x.pid])}${club(owner[x.pid])}` : `<span class="fa-tag">Free agent</span>`}</small></span>
        <span class="lead-row__val">${num(x.v, m.dp)}</span>
      </li>`).join("");
    loadPhotos(list.map((x) => x.pid), el);
  }

  function initHub() {
    const sel = $("#hubTeam");
    if (!sel) return;
    const opts = state.teams.map((t) => `<option value="${t.rosterId}">${esc(clubText(t))}</option>`).join("");
    sel.innerHTML = opts;
    $("#hubCompare").innerHTML = `<option value="avg">League average</option>` + opts;
    // default to the site owner's club when present
    const me = state.teams.find((t) => t.manager.toLowerCase() === "nicog01") || state.teams[0];
    hub.team = me.rosterId; sel.value = me.rosterId;
    sel.addEventListener("change", () => { hub.team = +sel.value; if (String(hub.compare) === sel.value) { hub.compare = "avg"; $("#hubCompare").value = "avg"; } renderHub(); });
    $("#hubCompare").addEventListener("change", (e) => { hub.compare = e.target.value === "avg" ? "avg" : +e.target.value; renderHub(); });
    $$("#hubScope .chip").forEach((c) => c.addEventListener("click", () => {
      hub.scope = c.dataset.scope;
      $$("#hubScope .chip").forEach((x) => { x.classList.toggle("is-active", x === c); x.setAttribute("aria-pressed", String(x === c)); });
      renderHub();
    }));
    $("#leadMetric").innerHTML = HUB_METRICS.filter((m) => m.key !== "min").map((m) => `<option value="${m.key}"${m.key === hub.lead ? " selected" : ""}>${esc(m.label)}</option>`).join("");
    $("#leadMetric").addEventListener("change", (e) => { hub.lead = e.target.value; renderLeaders(); });
    $$("#leadPool .chip").forEach((c) => c.addEventListener("click", () => {
      hub.pool = c.dataset.pool;
      $$("#leadPool .chip").forEach((x) => { x.classList.toggle("is-active", x === c); x.setAttribute("aria-pressed", String(x === c)); });
      renderLeaders();
    }));
    bindTip($("#hubGroups"), ".hub-dot", (d) => {
      const t = state.byRoster[d.dataset.id];
      const r = hubRowsCache.find((x) => x.m.key === d.dataset.m);
      const v = r.vals.find((x) => x.t === t).v;
      return `<b>${club(t)}</b><span>${esc(r.m.label)}: <strong>${num(v, r.m.dp)}</strong></span><span>${ordinal(ordinalRank(r.vals.map((x) => x.v), v, r.m.good))} of ${state.teams.length}</span>`;
    });
  }

  // ---------- POWER RANKINGS ----------
  // Ballots live in Supabase behind functions that only accept a club's code and only
  // return anonymous results (see supabase/power-rankings.sql). The publishable key is
  // meant to be public; it can call those functions and nothing else.
  const SUPABASE_URL = "https://jhnjoxqhxspmrwzrnycy.supabase.co";
  const SUPABASE_KEY = "sb_publishable_4ByLBCAe8R6uaOUnWwEjhg_9QaRUPJS";
  const PR_STORE = "mater-pr-voter";
  async function rpc(fn, args = {}) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`${fn} → ${r.status}`);
    return r.json();
  }

  const pr = { week: 0, voter: null, code: "", order: [], notes: {}, results: null, prev: null, rounds: [] };
  const teamByManager = (m) => state.byRoster[rosterOf(m)];

  // context shown on each ballot card, so votes aren't just the table order
  function weekMedians() {
    const by = {};
    state.results.forEach((m) => { (by[m.week] ||= []).push(m.homePts, m.awayPts); });
    const med = {};
    for (const [w, arr] of Object.entries(by)) {
      const s = [...arr].sort((a, b) => a - b), n = s.length;
      med[w] = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    }
    return med;
  }
  function prContext(t, med) {
    const played = t.w + t.l + t.d;
    const best = t.games.length ? Math.max(...t.games.map((g) => g.score)) : null;
    const hardLuck = t.games.filter((g) => g.res === "L" && g.score > med[g.week]).length;
    return { played, avg: played ? t.pf / played : 0, best, hardLuck };
  }
  function miniSpark(games) {
    if (games.length < 2) return "";
    const W = 120, H = 30, vals = games.map((g) => g.score), lo = Math.min(...vals), hi = Math.max(...vals);
    const x = (i) => 3 + (i * (W - 6)) / (games.length - 1), y = (v) => H - 4 - ((v - lo) / (hi - lo || 1)) * (H - 8);
    return `<svg class="pr-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${games.map((g, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(g.score).toFixed(1)}`).join("")}"/>
      ${games.map((g, i) => `<circle cx="${x(i)}" cy="${y(g.score)}" r="2.6" class="${g.res}"/>`).join("")}</svg>`;
  }

  // ---- results ----
  function renderPRResults() {
    const el = $("#prResults");
    if (!el) return;
    const data = pr.viewing === pr.week ? pr.results : pr.archive;
    const wk = pr.viewing;
    if (!data) {
      $("#prRound").innerHTML = `<b>Gameweek ${wk} rankings</b>`;
      el.innerHTML = `<p class="pending-note">Couldn't load results. Try refreshing.</p>`;
      return;
    }
    const voters = data.voters || state.teams.length;
    const revealAt = data.reveal_at ? new Date(data.reveal_at) : null;
    const when = (d) => d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    $("#prRound").innerHTML = `<b>Gameweek ${wk} rankings</b> · ${data.revealed ? "Revealed" : data.closed ? "Voting closed" : `<span class="pr-open">Voting open</span>`} · ${data.ballots} of ${voters} ballots in`;
    if (!data.revealed) {
      el.innerHTML = `<div class="pr-empty">
        <p class="pr-empty__big">${data.ballots} of ${voters} ballots in</p>
        ${data.closed
          ? `<p>Voting has closed and no ballots were cast this round.</p>`
          : revealAt
            ? `<p>The rankings are revealed when all ${voters} clubs have voted, or on <b>${when(revealAt)}</b> (the day before Gameweek ${wk + 1}), whichever comes first. Voting closes at the reveal.</p>`
            : `<p>The rankings are revealed once all ${voters} clubs have voted.</p>`}
      </div>`;
      return;
    }
    const prevRank = {};
    if (wk === pr.week && pr.prev && pr.prev.teams.length) pr.prev.teams.forEach((x, i) => (prevRank[x.manager] = i + 1));
    const max = state.teams.length - 1;
    const pct = (v) => ((v - 1) / (max - 1)) * 100;
    el.innerHTML = `<ol class="pr-table">${data.teams.map((x, i) => {
      const t = teamByManager(x.manager);
      if (!t) return "";
      const was = prevRank[x.manager];
      const mv = was ? was - (i + 1) : null;
      const move = mv == null ? `<span class="pr-move">–</span>` : mv > 0 ? `<span class="pr-move is-up" title="Up ${mv}">▲${mv}</span>` : mv < 0 ? `<span class="pr-move is-down" title="Down ${-mv}">▼${-mv}</span>` : `<span class="pr-move" title="No change">=</span>`;
      return `<li class="pr-row">
        <span class="pr-row__pos">${i + 1}</span>${move}
        <span class="pr-row__club">${crest(t)}<span><b>${club(t)}</b><small>${esc(t.manager)} · ${ordinal(t.pos)} in the table</small></span></span>
        <span class="pr-range" role="img" aria-label="Average ${num(x.avg, 2)}, best vote ${ordinal(x.best)}, worst vote ${ordinal(x.worst)}">
          <span class="pr-range__track"></span>
          <span class="pr-range__span" style="left:${pct(x.best)}%;width:${pct(x.worst) - pct(x.best)}%"></span>
          <span class="pr-range__avg" style="left:${pct(x.avg)}%"></span>
          <span class="pr-range__lbl pr-range__lbl--best" style="left:${pct(x.best)}%">${ordinal(x.best)}</span>
          <span class="pr-range__lbl pr-range__lbl--worst" style="left:${pct(x.worst)}%">${ordinal(x.worst)}</span>
        </span>
        <span class="pr-row__avg"><b>${num(x.avg, 2)}</b><small>avg of ${x.votes}</small></span>
        ${x.notes.length ? `<button type="button" class="pr-notes-btn" aria-expanded="false" aria-controls="prn-${x.manager}">${x.notes.length} note${x.notes.length > 1 ? "s" : ""}</button>` : `<span class="pr-notes-btn is-empty">No notes</span>`}
        ${x.notes.length ? `<ul class="pr-notes" id="prn-${x.manager}" hidden>${x.notes.map((n) => `<li>“${esc(n)}”</li>`).join("")}</ul>` : ""}
      </li>`;
    }).join("")}</ol>
    <p class="chart-note">Each club is ranked by the other ${max} (nobody votes on themselves). The bar runs from a club's best vote to its worst; the dot is the average. Notes are anonymous.</p>`;
    $$(".pr-notes-btn[aria-controls]", el).forEach((b) => b.addEventListener("click", () => {
      const list = $("#" + b.getAttribute("aria-controls"));
      const open = b.getAttribute("aria-expanded") !== "true";
      b.setAttribute("aria-expanded", String(open));
      list.hidden = !open;
    }));
  }

  async function loadPRResults() {
    try {
      const [cur, prev, rounds] = await Promise.all([
        rpc("get_results", { p_week: pr.week }),
        pr.week > 1 ? rpc("get_results", { p_week: pr.week - 1 }) : null,
        rpc("get_rounds"),
      ]);
      pr.results = cur; pr.prev = prev; pr.rounds = rounds;
      const closed = cur && cur.closed;
      $("#ballot").hidden = closed;
      $("#ballotClosed").hidden = !closed;
      if (closed) $("#ballotClosed").innerHTML = `<b>Voting for Gameweek ${pr.week} has closed.</b> The Gameweek ${pr.week + 1} ballot opens once Sleeper has scored Gameweek ${pr.week + 1}.`;
    } catch (e) {
      console.error(e);
      pr.results = null;
    }
    const sel = $("#prArchive");
    const weeks = [...new Set([pr.week, ...(pr.rounds || []).map((r) => r.week)])].sort((a, b) => b - a);
    sel.innerHTML = weeks.map((w) => `<option value="${w}"${w === pr.viewing ? " selected" : ""}>Gameweek ${w}${w === pr.week ? " (current)" : ""}</option>`).join("");
    renderPRResults();
  }

  // ---- ballot: step 1, who are you ----
  function prStep(n) {
    $$(".pr-step").forEach((s) => (s.hidden = +s.dataset.step !== n));
    const heading = $(`.pr-step[data-step="${n}"] h2, .pr-step[data-step="${n}"] h3`);
    if (heading) { heading.setAttribute("tabindex", "-1"); heading.focus({ preventScroll: true }); }
  }
  function renderWho() {
    const el = $("#prWho");
    el.innerHTML = state.teams.map((t) => `<button type="button" class="pr-who__club" role="radio" aria-checked="${pr.voter === t.manager.toLowerCase()}" data-m="${esc(t.manager.toLowerCase())}">
      ${crest(t)}<span><b>${club(t)}</b><small>${esc(t.manager)}</small></span></button>`).join("");
    $$(".pr-who__club", el).forEach((b) => b.addEventListener("click", () => {
      pr.voter = b.dataset.m;
      $$(".pr-who__club", el).forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      $("#prErr1").textContent = "";
      $("#prCode").focus();
    }));
  }
  async function startBallot() {
    const err = $("#prErr1"), btn = $("#prGo");
    const code = $("#prCode").value.trim();
    if (!pr.voter) { err.textContent = "Pick your club first."; return; }
    if (!code) { err.textContent = "Enter your club code."; $("#prCode").focus(); return; }
    btn.disabled = true; btn.textContent = "Checking…"; err.textContent = "";
    try {
      const res = await rpc("get_my_ballot", { p_week: pr.week, p_voter: pr.voter, p_code: code });
      if (!res.ok) { err.textContent = res.error; $("#prCode").focus(); return; }
      pr.code = code;
      try {
        if ($("#prRemember").checked) localStorage.setItem(PR_STORE, JSON.stringify({ voter: pr.voter, code }));
        else localStorage.removeItem(PR_STORE);
      } catch (_) {}
      const others = state.teams.filter((t) => t.manager.toLowerCase() !== pr.voter);
      const saved = res.ballot;
      pr.order = saved ? saved.rankings.map((m) => rosterOf(m)).filter(Boolean) : others.map((t) => t.rosterId);
      pr.notes = {};
      if (saved) for (const [m, n] of Object.entries(saved.notes || {})) { const id = rosterOf(m); if (id) pr.notes[id] = n; }
      renderBallot(saved);
      prStep(2);
    } catch (e) {
      console.error(e);
      err.textContent = "Couldn't reach the ballot box. Check your connection and try again.";
    } finally {
      btn.disabled = false; btn.textContent = "Start ranking";
    }
  }

  // ---- ballot: step 2, rank the other clubs ----
  function renderBallot(saved) {
    const me = teamByManager(pr.voter);
    $("#prMe").innerHTML = `${crest(me)}<span>Voting as <b>${club(me)}</b></span>`;
    $("#prSavedNote").textContent = saved ? `You already voted this round (${new Date(saved.submitted_at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}). Submitting again replaces it.` : "";
    const med = weekMedians();
    $("#prList").innerHTML = pr.order.map((id) => {
      const t = state.byRoster[id], c = prContext(t, med);
      const form = t.record.slice(-5).split("").map((r) => `<i class="${r}">${r === "T" ? "D" : r}</i>`).join("");
      const stat = (v, l, cls = "") => `<span class="pr-stat ${cls}"><b>${v}</b><small>${l}</small></span>`;
      return `<li class="pr-card" data-id="${id}">
        <span class="pr-card__rank" aria-hidden="true"></span>
        <span class="pr-card__handle" aria-hidden="true" title="Drag to reorder"><svg viewBox="0 0 16 16"><circle cx="5" cy="4" r="1.3"/><circle cx="11" cy="4" r="1.3"/><circle cx="5" cy="8" r="1.3"/><circle cx="11" cy="8" r="1.3"/><circle cx="5" cy="12" r="1.3"/><circle cx="11" cy="12" r="1.3"/></svg></span>
        <div class="pr-card__main">
          <div class="pr-card__id">${crest(t)}<span><b>${club(t)}</b><small>${esc(t.manager)} · ${ordinal(t.pos)} in the table${t.streak ? ` · ${esc(t.streak)} streak` : ""}</small></span>
            <span class="form" aria-label="Last five: ${esc(t.record.slice(-5))}">${form}</span></div>
          <div class="pr-card__stats">
            ${stat(`${t.w}-${t.d}-${t.l}`, "Record")}
            ${stat(num(t.pf), "Points for")}
            ${stat(num(c.avg), "Avg / week")}
            ${stat(c.best != null ? num(c.best) : "–", "Best week")}
            ${stat(t.allPlay ? `${t.allPlay.w}-${t.allPlay.l}` : "–", "All-Play")}
            ${stat(c.hardLuck, "Hard-luck losses", c.hardLuck ? "is-flag" : "")}
            ${stat(num(t.pa), "Points against")}
            ${miniSpark(t.games)}
          </div>
          <label class="pr-card__note"><span class="visually-hidden">Note on ${esc(t.name)} (optional)</span>
            <textarea rows="2" maxlength="280" placeholder="Hot take on ${esc(t.name)} (optional)" data-id="${id}">${esc(pr.notes[id] || "")}</textarea></label>
        </div>
        <span class="pr-card__move">
          <button type="button" class="pr-up" aria-label="Move ${esc(t.name)} up"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg></button>
          <button type="button" class="pr-down" aria-label="Move ${esc(t.name)} down"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>
        </span>
      </li>`;
    }).join("");
    numberCards();
  }
  function numberCards() {
    const cards = $$("#prList .pr-card");
    pr.order = cards.map((c) => +c.dataset.id);
    cards.forEach((c, i) => {
      $(".pr-card__rank", c).textContent = i + 1;
      $(".pr-up", c).disabled = i === 0;
      $(".pr-down", c).disabled = i === cards.length - 1;
      c.setAttribute("aria-label", `${i + 1}. ${state.byRoster[c.dataset.id].name}`);
    });
  }
  function moveCard(card, dir) {
    const sib = dir < 0 ? card.previousElementSibling : card.nextElementSibling;
    if (!sib) return;
    const before = card.getBoundingClientRect().top;
    dir < 0 ? sib.before(card) : sib.after(card);
    // slide from the old spot to the new one
    if (!reduceMotion()) {
      const delta = before - card.getBoundingClientRect().top;
      card.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(.16,1,.3,1)" });
    }
    numberCards();
    $("#prStatus").textContent = `${state.byRoster[card.dataset.id].name} moved to ${pr.order.indexOf(+card.dataset.id) + 1}.`;
  }
  function bindBallot() {
    const list = $("#prList");
    list.addEventListener("click", (e) => {
      const b = e.target.closest(".pr-up, .pr-down");
      if (!b) return;
      const card = b.closest(".pr-card");
      moveCard(card, b.classList.contains("pr-up") ? -1 : 1);
      const again = $(b.classList.contains("pr-up") ? ".pr-up" : ".pr-down", card);
      (again.disabled ? $(b.classList.contains("pr-up") ? ".pr-down" : ".pr-up", card) : again).focus();
    });
    list.addEventListener("input", (e) => {
      if (e.target.matches("textarea")) pr.notes[e.target.dataset.id] = e.target.value;
    });
    // drag to reorder: the card follows the pointer and swaps past a neighbour's midpoint
    list.addEventListener("pointerdown", (e) => {
      const handle = e.target.closest(".pr-card__handle");
      if (!handle || e.button > 0) return;
      e.preventDefault();
      const card = handle.closest(".pr-card");
      let startY = e.clientY;
      card.classList.add("is-drag");
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        let dy = ev.clientY - startY;
        const prev = card.previousElementSibling, next = card.nextElementSibling;
        if (next && dy > next.offsetHeight / 2) { next.after(card); startY += next.offsetHeight + 10; dy = ev.clientY - startY; numberCards(); }
        else if (prev && dy < -prev.offsetHeight / 2) { prev.before(card); startY -= prev.offsetHeight + 10; dy = ev.clientY - startY; numberCards(); }
        card.style.transform = `translateY(${dy}px)`;
      };
      const up = () => {
        card.classList.remove("is-drag");
        card.style.transform = "";
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        numberCards();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }
  async function submitBallot() {
    const btn = $("#prSubmit"), err = $("#prErr2");
    btn.disabled = true; btn.textContent = "Submitting…"; err.textContent = "";
    const notes = {};
    pr.order.forEach((id) => { const n = (pr.notes[id] || "").trim(); if (n) notes[state.byRoster[id].manager.toLowerCase()] = n; });
    try {
      const res = await rpc("submit_ballot", {
        p_week: pr.week, p_voter: pr.voter, p_code: pr.code,
        p_rankings: pr.order.map((id) => state.byRoster[id].manager.toLowerCase()), p_notes: notes,
      });
      if (!res.ok) { err.textContent = res.error; return; }
      $("#prDoneList").innerHTML = pr.order.map((id) => `<li>${crest(state.byRoster[id])}<b>${club(state.byRoster[id])}</b></li>`).join("");
      prStep(3);
      pr.viewing = pr.week;
      loadPRResults();
    } catch (e) {
      console.error(e);
      err.textContent = "Couldn't submit. Check your connection and try again. Your ranking is still here.";
    } finally {
      btn.disabled = false; btn.textContent = "Submit ballot";
    }
  }

  // latest round with public results (3+ ballots) decides who wears the crown and the poo
  async function loadEmblems() {
    try {
      const rounds = (await rpc("get_rounds")).slice(0, 3);
      for (const round of rounds) {
        const res = await rpc("get_results", { p_week: round.week });
        if (res.revealed && res.teams && res.teams.length >= 2)
          return { week: round.week, top: res.teams[0].manager, bottom: res.teams[res.teams.length - 1].manager };
      }
      return null;
    } catch (_) { return null; }
  }

  function initPower() {
    if (!$("#prResults")) return;
    pr.week = (state.league.settings && state.league.settings.last_scored_leg) || Math.max(1, state.week - 1);
    pr.viewing = pr.week;
    $$(".js-pr-week").forEach((e) => (e.textContent = pr.week));
    $$(".js-pr-next").forEach((e) => (e.textContent = pr.week + 1));
    try {
      const saved = JSON.parse(localStorage.getItem(PR_STORE) || "null");
      if (saved) { pr.voter = saved.voter; $("#prCode").value = saved.code; }
    } catch (_) {}
    renderWho();
    bindBallot();
    $("#prGo").addEventListener("click", startBallot);
    $("#prCode").addEventListener("keydown", (e) => { if (e.key === "Enter") startBallot(); });
    $("#prBack").addEventListener("click", () => prStep(1));
    $("#prSubmit").addEventListener("click", submitBallot);
    $("#prEdit").addEventListener("click", () => startBallot());
    $("#prArchive").addEventListener("change", async (e) => {
      pr.viewing = +e.target.value;
      if (pr.viewing !== pr.week) {
        try { pr.archive = await rpc("get_results", { p_week: pr.viewing }); } catch (_) { pr.archive = null; }
      }
      renderPRResults();
    });
    loadPRResults();
  }

  // ---------- HOME SNAPSHOT ----------
  function renderHomeSnap() {
    const table = $("#homeTable");
    if (table) {
      table.innerHTML = state.teams.map((t) => `
        <li class="mini-row${t.pos <= PLAYOFF_SPOTS ? " is-po" : ""}${t.pos === state.teams.length ? " is-spoon" : ""}">
          <a href="clubs.html#club-${t.rosterId}">
            <span class="mini-pos">${t.pos}</span>${crest(t)}<span class="mini-name">${club(t)}</span>
            <span class="mini-rec">${t.w}-${t.d}-${t.l}</span><span class="mini-pts">${num(t.pf)}</span>
          </a>
        </li>`).join("");
    }
    const feed = $("#homeFeed");
    if (feed && state.txns.length) {
      feed.innerHTML = state.txns.slice(0, 4).map((tx) => {
        const { head, main } = txnSummary(tx);
        const bid = tx.type === "waiver" && tx.settings && tx.settings.waiver_bid;
        const label = { waiver: "Waiver", free_agent: "Free agent", trade: "Trade" }[tx.type] || tx.type;
        return `<li class="mini-feed__item">${main ? crest(main) : ""}
          <span class="mini-feed__body"><span class="feed__type ${tx.type}">${label}</span><span class="mini-feed__head">${head}</span></span>
          <span class="mini-feed__side">${bid ? `<b>$${bid}</b>` : ""}<small>${when(tx.status_updated || tx.created)}</small></span></li>`;
      }).join("");
    }
  }

  // ---------- reveal + nav state ----------
  function observeReveals() {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const siblings = [...e.target.parentElement.children];
        e.target.style.transitionDelay = e.target.matches(".club-card, .derby") ? `${Math.min(siblings.indexOf(e.target), 10) * 50}ms` : "";
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    $$(".reveal:not(.is-in), .club-card:not(.is-in)").forEach((el) => io.observe(el));
  }

  // mobile menu
  const toggle = $("#navToggle"), menu = $("#mobileMenu");
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    menu.hidden = !open;
    // the home nav is see-through over the hero; go solid while the menu is open so it reads on paper
    const nav = $("#nav");
    nav.classList.toggle("is-open", open);
    nav.classList.toggle("is-solid", open || window.scrollY > 40 || nav.classList.contains("is-page"));
  });
  menu.addEventListener("click", (e) => { if (e.target.tagName === "A") toggle.click(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    hideTip();
    if (!menu.hidden) { toggle.click(); toggle.focus(); }
    else if ($("#clubProfile") && !$("#clubProfile").hidden) closeClub();
  });

  // ---------- boot ----------
  function showError(err) {
    console.error(err);
    const box = `<div class="error-box" role="alert"><strong>Couldn't reach Sleeper.</strong> Check your connection and try again.<br><button type="button" onclick="location.reload()">Retry</button></div>`;
    const target = $("main .section") || $("main");
    if (target) target.insertAdjacentHTML("afterbegin", box);
  }

  async function boot() {
    try {
      const [league, users, rosters, sportState, matchRows, cupRows, emblems, lineupRows] = await Promise.all([
        get(`/league/${LEAGUE_ID}`), get(`/league/${LEAGUE_ID}/users`), get(`/league/${LEAGUE_ID}/rosters`), get(`/state/${SPORT}`).catch(() => ({})),
        getCSV("data/matchups.csv"), getCSV("data/cup.csv"), loadEmblems(), $("#muList") ? getCSV("data/lineups.csv") : [],
      ]);
      state.lineups = lineupRows;
      state.league = league;
      state.week = sportState.display_week || sportState.week || (league.settings && league.settings.leg) || 1;
      state.teams = rank(buildTeams(users, rosters));
      state.byRoster = Object.fromEntries(state.teams.map((t) => [t.rosterId, t]));
      state.derbies = buildDerbies();
      if (emblems) {
        state.prEmblemWeek = emblems.week;
        const top = teamByManager(emblems.top), bottom = teamByManager(emblems.bottom);
        if (top) top.prTag = "top";
        if (bottom && bottom !== top) bottom.prTag = "bottom";
      }
      state.results = loadResults(matchRows);
      state.cupRows = loadCupRows(cupRows);
      state.hasResults = state.results.length > 0;
      deriveFromResults();
      state.rankHistory = buildRankHistory();
      state.cupLevels = buildCup();

      renderHero();
      renderHomeSnap();
      renderTable();
      renderClubs();
      renderH2HPicker();
      renderMatrix();
      renderDerbies();
      renderCup();
      renderVictoryRoad();
      renderWeekly();
      renderMatchups();
      initPower();
      observeReveals();

      // players, transactions and weekly stats are heavier: render the rest once they land
      const legs = Math.max(state.week, (league.settings && league.settings.leg) || 1);
      const scored = (league.settings && league.settings.last_scored_leg) || Math.max(0, state.week - 1);
      const season = league.season || sportState.season;
      const [players, statsWeeks, ...txnLegs] = await Promise.all([
        loadPlayers().catch(() => ({})),
        Promise.all(Array.from({ length: $("#clubGrid") || $("#hubGroups") ? scored : 0 }, (_, i) => get(`/stats/${SPORT}/regular/${season}/${i + 1}`).catch(() => ({})))),
        ...Array.from({ length: legs }, (_, i) => get(`/league/${LEAGUE_ID}/transactions/${i + 1}`).catch(() => [])),
      ]);
      state.players = players;
      renderMatchups();
      const { proj, season: seasonPts } = buildProjections(statsWeeks, league.scoring_settings || {});
      state.projections = proj;
      state.seasonPts = seasonPts;
      if ($("#hubGroups")) {
        state.playerTotals = buildPlayerTotals(statsWeeks, league.scoring_settings || {});
        initHub();
        renderHub();
      }
      state.txns = txnLegs.flat().filter((t) => t && t.status === "complete").sort((a, b) => (b.status_updated || b.created) - (a.status_updated || a.created));

      renderFeed();
      renderTicker();
      renderRecords();
      renderMarket();
      renderHomeSnap();
      observeReveals();

      const dh = location.hash.match(/^#derby-([\w-]+)$/);
      if (dh && $(`#derby-${dh[1]}`)) {
        const card = $(`#derby-${dh[1]}`);
        card.classList.add("is-in", "is-target");
        card.scrollIntoView({ block: "center" });
      }
      const m = location.hash.match(/^#club-(\d+)$/);
      if (m) openClub(+m[1], true);

      $("#updated").textContent = `Last updated ${new Date().toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
    } catch (err) {
      showError(err);
    }
  }
  boot();
})();
