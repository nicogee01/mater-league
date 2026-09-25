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

## What's live vs. logged

| Section            | Source |
|--------------------|--------|
| Hero contenders / relegation, League table, Win%, Eff. | Live (Sleeper rosters) |
| Clubs: XI, squad, photos, per-90 projections, record transfer | Live (rosters, weekly stats, Wikipedia) |
| Transfer window, ticker | Live (Sleeper transactions) |
| Hall of Records: Golden Boot, streaks, spending, … | Live |
| Hall of Records: blowouts, closest game, consistency, bench blunders | `data/matchups.csv` |
| All-Play, Home/Away, Std dev, Optimal record, Nemesis/Cupcake, H2H | `data/matchups.csv` |
| The McQueen Cup | `data/cup.csv` |
| Victory Road | `data/league.js` → `honours` |
| Analytics: points vs best lineup | Live |
| Analytics: standings by week | Exact with `matches`; wins-only estimate before then |

### Match data (CSV)

Sleeper's public API doesn't return soccer matchups, so match results are
kept in two CSV files. Teams are named by **Sleeper username**:
treyclif3, austinclifton, nicog01, BottomCap, nictrn, KingAbes, officialmaje, GlenM22.

`data/matchups.csv` has one row per league match:

```
week,home,away,home_pts,away_pts,home_best,away_best
6,treyclif3,austinclifton,92.5,81.25,104.0,
```

`home_best` / `away_best` (best possible lineup) are optional. When present, they
unlock the bench records and optimal-lineup stats.

`data/cup.csv` has one row per McQueen Cup leg. Leave the scores blank until it's played:

```
round,leg,week,home,away,home_pts,away_pts
Quarterfinals,1,7,nicog01,BottomCap,,
```

Past champions (Victory Road) are in `data/league.js` under `honours`.

**Check before publishing:** `node scripts/check-matchups.mjs` confirms every
result agrees with Sleeper's week-by-week W/L record for both teams, and (once
all scored weeks are in) that each club's season points for/against match Sleeper.

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
data/league.js        league lore: the four derbies and past champions
data/matchups.csv     league results, one row per match
data/cup.csv          McQueen Cup legs
scripts/check-matchups.mjs  verifies matchups.csv against Sleeper (Node 18+)
media/                hero videos + posters (originals/ is git-ignored)
```

## Tweaks

- **Remove the IN DEVELOPMENT sign:** delete the `<div class="dev-sign">` block in `index.html`.
- **Colours:** use the tokens at the top of `css/styles.css` (paper, navy ink, programme red, old gold).
- **Derbies:** edit `data/league.js`. Managers are matched by Sleeper username.
- **Playoff line:** `PLAYOFF_SPOTS` in `js/app.js`.
- **After edits:** bump the `?v=` number on the CSS/JS links in every `.html` page so browsers pick up the change.
