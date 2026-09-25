/* =========================================================
   Shared page chrome: nav, mobile menu, footer, tooltip and
   SVG symbols. Edit the PAGES list to add or rename a tab.
   Each page sets <body data-page="..."> to mark its tab active.
   ========================================================= */
(function () {
  const PAGES = [
    { id: "table", href: "table.html", label: "Table", long: "League table" },
    { id: "clubs", href: "clubs.html", label: "Clubs" },
    { id: "h2h", href: "h2h.html", label: "H2H", long: "Head-to-Head" },
    { id: "transfers", href: "transfers.html", label: "Transfers" },
    { id: "records", href: "records.html", label: "Records", long: "Hall of Records" },
    { id: "power", href: "power.html", label: "Power Rankings" },
    { id: "cup", href: "cup.html", label: "McQueen Cup", long: "The McQueen Cup" },
    { id: "victory-road", href: "victory-road.html", label: "Victory Road" },
    { id: "analytics", href: "analytics.html", label: "Analytics" },
  ];
  const current = document.body.dataset.page || "home";
  const link = (p, long) => `<a href="${p.href}"${p.id === current ? ' class="is-active" aria-current="page"' : ""}>${long ? p.long || p.label : p.label}</a>`;
  const arrow = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 11L11 5M6 5h5v5" /></svg>`;

  const header = `
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="nav${current === "home" ? "" : " is-solid is-page"}" id="nav">
    <div class="nav__inner">
      <a class="brand" href="index.html" aria-label="The Mater League home"${current === "home" ? ' aria-current="page"' : ""}>
        <svg class="brand__ball" viewBox="0 0 40 40" aria-hidden="true"><use href="#ball" /></svg>
        <span class="brand__word">MATER<em>LEAGUE</em></span>
      </a>
      <nav class="nav__links" aria-label="Primary">${PAGES.map((p) => link(p)).join("")}</nav>
      <a class="nav__cta" href="https://sleeper.com/leagues/1390750210698780672" target="_blank" rel="noopener">Sleeper ${arrow}</a>
      <button class="nav__toggle" id="navToggle" aria-label="Open menu" aria-expanded="false" aria-controls="mobileMenu">
        <span></span><span></span>
      </button>
    </div>
    <div class="nav__progress" aria-hidden="true">
      <div class="nav__track"></div>
      <svg class="nav__roller" id="roller" viewBox="0 0 40 40"><use href="#ball" /></svg>
    </div>
    <nav class="mobile-menu" id="mobileMenu" aria-label="Mobile" hidden>
      <a href="index.html"${current === "home" ? ' aria-current="page"' : ""}>Home</a>
      ${PAGES.map((p) => link(p, true)).join("")}
    </nav>
  </header>`;

  const footer = `
  <footer class="footer">
    <div class="footer__inner">
      <span class="brand__word">MATER<em>LEAGUE</em></span>
      <nav class="footer__links" aria-label="Footer"><a href="index.html">Home</a>${PAGES.map((p) => `<a href="${p.href}">${p.long || p.label}</a>`).join("")}</nav>
      <p>Mater League, running since 2026. Created by Pep Guardiola's successor, Nico.</p>
      <p>Live data from the Sleeper API. Not affiliated with the Premier League or Sleeper.</p>
      <p class="footer__updated" id="updated" aria-live="polite"></p>
    </div>
  </footer>
  <div class="tooltip" id="tooltip" role="tooltip" hidden></div>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <defs>
      <symbol id="ball" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="18.5" fill="#fff" stroke="#15001a" stroke-width="1.5" />
        <path d="M20 12.5l7 5.1-2.7 8.3h-8.6L13 17.6z" fill="#15001a" />
        <path d="M20 12.5V4.2M27 17.6l7.6-2.6M24.3 25.9l4.6 6.6M15.7 25.9l-4.6 6.6M13 17.6l-7.6-2.6" stroke="#15001a" stroke-width="1.4" fill="none" />
        <path d="M16.5 2.2l3.5 2 3.5-2A18.5 18.5 0 0 0 16.5 2.2zM37.6 13.4l-3 1.6.7 4.8 2.9 1.2a18.5 18.5 0 0 0-.6-7.6zM31.9 34.2l-3-1.7-4.2 2.6.1 3.6a18.5 18.5 0 0 0 7.1-4.5zM8.1 34.2l3-1.7 4.2 2.6-.1 3.6a18.5 18.5 0 0 1-7.1-4.5zM2.4 13.4l3 1.6-.7 4.8-2.9 1.2a18.5 18.5 0 0 1 .6-7.6z" fill="#15001a" />
      </symbol>
    </defs>
  </svg>`;

  document.body.insertAdjacentHTML("afterbegin", header);
  document.body.insertAdjacentHTML("beforeend", footer);
  window.MATER_PAGES = PAGES;
})();
