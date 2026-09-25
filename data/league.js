/*
  League lore for the Mater League. Edit freely.

  derbies  - rivalries between two managers, matched by their Sleeper username
             (case doesn't matter). "slug" is used in links like h2h.html#derby-clifton.
  honours  - Victory Road. One entry per season; champion / runnerUp are Sleeper
             usernames, or null while the season is still being played.

  Match results live in data/matchups.csv and data/cup.csv.
*/
window.MATER_LEAGUE = {
  "derbies": [
    {
      "slug": "clifton",
      "name": "The Clifton Derby",
      "tag": "Family feud",
      "managers": ["treyclif3", "austinclifton"],
      "story": "Same surname, same family group chat. Two Cliftons, one set of bragging rights, and nobody gets to forget who won."
    },
    {
      "slug": "brothers",
      "name": "The Bloodline Clásico",
      "tag": "Same blood, no mercy",
      "managers": ["nicog01", "BottomCap"],
      "story": "Brothers by blood, rivals by choice. Raised in the same house, now fighting over the same bragging rights, and the loser hears about it at every family dinner."
    },
    {
      "slug": "upstate",
      "name": "The Snow Belt Derby",
      "tag": "Upstate New York",
      "managers": ["nictrn", "KingAbes"],
      "story": "Old friends from upstate New York, where the lake-effect snow never stops and neither does the trash talk. Hometown pride on the line, and no hiding from it back home."
    },
    {
      "slug": "i95",
      "name": "The I-95 Derby",
      "tag": "Maryland vs New York",
      "managers": ["officialmaje", "GlenM22"],
      "story": "Online friends split by the I-95, one in Maryland and one in New York. The league's long-distance rivalry."
    }
  ],
  "honours": {
    "league": [{ "year": 2026, "champion": null, "runnerUp": null }],
    "cup": [{ "year": 2026, "champion": null, "runnerUp": null }]
  }
};
