/*
  League lore for the Mater League. Edit freely.

  derbies  - rivalries between two managers, matched by their Sleeper username
             (case doesn't matter). "slug" is used in links like h2h.html#derby-clifton.
  favourites - the Premier League club each manager supports (shown on club profiles).
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
      "name": "El Clásico de Sutphin",
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
      "name": "El Clásico de las Américas",
      "tag": "Honduras vs Ecuador",
      "managers": ["officialmaje", "GlenM22"],
      "story": "La Tri against La H, South America against Central America. An Ecuadorian in New York and a Honduran in Maryland, online friends who've never let a few hundred miles of I-95 get in the way of a rivalry."
    }
  ],
  "favourites": {
    "nicog01": "Manchester City",
    "officialmaje": "Arsenal",
    "glenm22": "West Ham",
    "austinclifton": "Spurs",
    "kingabes": "Brighton",
    "bottomcap": "Chelsea",
    "treyclif3": "Chelsea",
    "nictrn": "Arsenal"
  },
  "honours": {
    "league": [{ "year": 2026, "champion": null, "runnerUp": null }],
    "cup": [{ "year": 2026, "champion": null, "runnerUp": null }]
  }
};
