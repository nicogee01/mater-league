/*
  Match data for the Mater League. The site reads this file on load.
  Keep it valid JSON inside `window.NYM_RESULTS = { ... };`

  matches  - league results. "home"/"away" are Sleeper roster IDs (see "teams").
             homeBest/awayBest (optional) = best possible lineup score that week;
             they power the bench records and optimal-lineup stats.
             { "week": 1, "home": 3, "away": 7, "homePts": 112.5, "awayPts": 98.25, "homeBest": 130.0, "awayBest": 101.5 }

  cup      - McQueen Cup legs. Round names: "Quarterfinals", "Semifinals", "Final".
             Leave a/b off (or null) to schedule a leg before the draw.
             { "round": "Quarterfinals", "leg": 1, "a": 2, "b": 5, "aPts": 88.5, "bPts": 91.0, "week": 7 }

  honours  - Victory Road. One entry per season; use null for TBD.
             { "year": 2026, "champion": null, "runnerUp": null }

  scripts/snapshot.mjs adds league matches automatically; everything else is by hand.
*/
window.NYM_RESULTS = {
  "matches": [],
  "cup": [],
  "honours": {
    "league": [
      {
        "year": 2026,
        "champion": null,
        "runnerUp": null
      }
    ],
    "cup": [
      {
        "year": 2026,
        "champion": null,
        "runnerUp": null
      }
    ]
  },
  "teams": {
    "1": "Wonkeeland’s Finest",
    "2": "Elliot Anderson FC",
    "3": "Pep’s Retirement Fund",
    "4": "GlenM22 FC",
    "5": "Up the Guppys",
    "6": "nictrn FC",
    "7": "BottomCap FC",
    "8": "King Abes"
  }
};
