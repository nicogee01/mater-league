# The Mater League

Website for our Sleeper fantasy Premier League (league `1390750210698780672`).
**Status: in development.**

The browser pulls live data straight from the Sleeper API, so the table, clubs,
transfers and most records stay current without a rebuild.

## Run it locally

```bash
python -m http.server 5173
```

Then open http://localhost:5173.

## Publish on GitHub Pages

1. Push this folder to the `Mater-League` repo, with `index.html` at the root.
2. Go to repo **Settings → Pages**, then deploy from branch `main`, folder `/ (root)`.
3. The site goes live at `https://<your-username>.github.io/Mater-League/`.

`.github/workflows/snapshot.yml` runs daily and logs new league results into
`data/results.js` (enable Actions on the repo). You can also run it by hand from the Actions tab.

## What's live vs. logged

| Section            | Source |
|--------------------|--------|
| Hero contenders / relegation, League table, Win%, Eff. | Live (Sleeper rosters) |
| Clubs: XI, squad, photos, per-90 projections, record transfer | Live (rosters, weekly stats, Wikipedia) |
| Transfer window, ticker | Live (Sleeper transactions) |
| Hall of Records: Golden Boot, streaks, spending, … | Live |
| Hall of Records: blowouts, closest game, consistency, bench blunders | `data/results.js` → `matches` |
| All-Play, Home/Away, Std dev, Optimal record, Nemesis/Cupcake, H2H | `data/results.js` → `matches` |
| The McQueen Cup | `data/results.js` → `cup` |
| Victory Road | `data/results.js` → `honours` |
| Analytics: points vs best lineup | Live |
| Analytics: standings by week | Exact with `matches`; wins-only estimate before then |

### data/results.js

Sleeper's public API doesn't return soccer matchups, so match-level data lives
here. The comment at the top of the file shows the format for each field:

- **matches**: `{ week, home, away, homePts, awayPts, homeBest?, awayBest? }`. `home`/`away` are roster IDs (listed under `teams`).
  `homeBest`/`awayBest` are optional best-lineup scores and unlock the bench records.
- **cup**: `{ round: "Quarterfinals" | "Semifinals" | "Final", leg, a, b, aPts, bPts, week }`.
  Leave `a`/`b` off to schedule a leg before the draw.
- **honours**: `{ league: [{ year, champion, runnerUp }], cup: [...] }`, using roster IDs or `null` for TBD.

`scripts/snapshot.mjs` fills `matches` automatically from GW6 on by diffing each
club's points-for/against week to week (`node scripts/snapshot.mjs`).

## Files

```
index.html            home: hero video, ticker, table snapshot, latest transfers, page links
table.html            league table            clubs.html          club profiles
h2h.html              head-to-head            transfers.html      transfer window
records.html          Hall of Records         cup.html            The McQueen Cup
victory-road.html     champions               analytics.html      charts
css/styles.css        "matchday programme" theme tokens at the top, then components
js/layout.js          shared nav + footer (edit PAGES here to add or rename a tab)
js/motion.js          hero video, pause button, nav ball
js/app.js             Sleeper data → whatever sections the current page has
data/results.js       logged matchups, cup, honours
scripts/snapshot.mjs  weekly result logger (Node 18+)
media/                hero videos + posters (originals/ is git-ignored)
```

## Tweaks

- **Remove the IN DEVELOPMENT sign:** delete the `<div class="dev-sign">` block in `index.html`.
- **Colours:** use the tokens at the top of `css/styles.css` (paper, navy ink, programme red, old gold).
- **Playoff line:** `PLAYOFF_SPOTS` in `js/app.js`.
- **After edits:** bump the `?v=` number on the CSS/JS links in every `.html` page so browsers pick up the change.
