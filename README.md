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
| Transfer window, ticker | Live (Sleeper transactions). FAAB spent = winning bids; FAAB left = balance after trades |
| Hall of Records: Golden Boot, streaks, spending, … | Live |
| Hall of Records: blowouts, closest game, consistency, bench blunders | `data/matchups.csv` |
| All-Play, Home/Away, Std dev, Optimal record, Nemesis/Cupcake, H2H | `data/matchups.csv` |
| The McQueen Cup | `data/cup.csv` |
| Victory Road | `data/league.js` → `honours` |
| Analytics: data hub (goals, xG, key passes, tackles, saves… vs league average) | Live (Sleeper weekly player stats) |
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

`data/cup.csv` has one row per McQueen Cup leg: one "marquee" leg per gameweek,
QF from GW19, SF from GW31, the Final in GW37–38. Rows stay in tie order (first QF
row = QF1). After the draw, fill in `home` / `away`; scores fill themselves from
each club's league score that week in `matchups.csv` (type them only to override):

```
round,leg,week,home,away,home_pts,away_pts
Quarterfinals,1,19,nicog01,BottomCap,,
```

Past champions (Victory Road) are in `data/league.js` under `honours`.

**Home and away:** Sleeper doesn't track venues, so after adding a week run
`node scripts/balance-home-away.mjs`. It decides who's home (keeping every club's home/away
count as even as possible, coin-flip on ties, the same answer every run) and shuffles each
week's card order. Earlier weeks never change.

**Check before publishing:** `node scripts/check-matchups.mjs` confirms every
result agrees with Sleeper's week-by-week W/L record for both teams, and (once
all scored weeks are in) that each club's season points for/against match Sleeper.

**Lineups (Matchups tab):** `data/lineups.csv` lists each week's starting XIs,
read off Sleeper's matchup screens (Sleeper has no public soccer matchups API).
Add only the starters (`week,manager,slot,player_id,player` with slot GK/DEF/MID/FWD),
then run `node scripts/build-lineups.mjs`. It fills in points, Sleeper projections and
minutes, rebuilds each bench from the draft plus every transaction up to that
gameweek's last kickoff (so a bench only shows players on the roster at the time),
and checks each XI adds up to its score in matchups.csv.

**Automatic lineups:** `.github/workflows/snapshot-lineups.yml` runs
`scripts/snapshot-lineups.mjs` every hour. In the hours right after a gameweek's last
match it records every club's starting XI from Sleeper (roster `starters` + that week's
formation), runs build-lineups, and commits. `node scripts/snapshot-lineups.mjs --dry-run`
shows what it would record right now. Screen recordings are only needed for weeks it missed.

**The Gazette** (`gazette.html`, home page strip, Matchups headlines) is written in
`js/app.js` from the scores and lineups: headline pools per story type, rotating award
titles, and a Team of the Week. Add wordings to `G_HEADLINES` / `G_AWARDS` to keep it fresh.

## Files

```
index.html            home: hero video, ticker, table snapshot, latest transfers, page links
table.html            league table            clubs.html          club profiles
h2h.html              head-to-head            transfers.html      transfer window
records.html          Hall of Records         cup.html            The McQueen Cup
victory-road.html     champions               analytics.html      charts
matchups.html         fixtures + team sheets by gameweek
gazette.html          headlines, match reports, awards, Team of the Week
css/styles.css        "matchday programme" theme tokens at the top, then components
js/layout.js          shared nav + footer (edit PAGES here to add or rename a tab)
js/motion.js          hero video, pause button, nav ball
js/app.js             Sleeper data → whatever sections the current page has
data/league.js        league lore: derbies, favourite Premier League clubs, past champions
data/matchups.csv     league results, one row per match
data/cup.csv          McQueen Cup legs
data/lineups.csv      starting XIs + rebuilt benches per gameweek
scripts/check-matchups.mjs  verifies matchups.csv against Sleeper (Node 18+)
scripts/build-lineups.mjs   fills points/projections/benches into lineups.csv
scripts/snapshot-lineups.mjs  records starting XIs from Sleeper after each gameweek
scripts/balance-home-away.mjs  fair home/away + shuffled card order in matchups.csv
media/                hero videos + posters (originals/ is git-ignored)
```

## Tweaks

- **Remove the IN DEVELOPMENT sign:** delete the `<div class="dev-sign">` block in `index.html`.
- **Colours:** use the tokens at the top of `css/styles.css` (paper, navy ink, programme red, old gold).
- **Derbies:** edit `data/league.js`. Managers are matched by Sleeper username.
- **Playoff line:** `PLAYOFF_SPOTS` in `js/app.js`.
- **After edits:** bump the `?v=` number on the CSS/JS links in every `.html` page so browsers pick up the change.
