/* =========================================================
   Shared page chrome: nav, mobile menu, footer, tooltip and
   SVG symbols. Edit the PAGES list to add or rename a tab.
   Each page sets <body data-page="..."> to mark its tab active.
   ========================================================= */
(function () {
  // grouped: the nav puts a thin divider between groups, the phone menu gives each group a heading
  const PAGES = [
    { id: "matchups", href: "matchups.html", label: "Matchups", group: "This week" },
    { id: "table", href: "table.html", label: "Table", long: "League table", group: "This week" },
    { id: "gazette", href: "gazette.html", label: "Gazette", long: "The Gazette", group: "This week" },
    { id: "awards", href: "awards.html", label: "Awards", long: "Weekly Awards", group: "This week" },
    { id: "power", href: "power.html", label: "Power Rankings", group: "This week" },
    { id: "cup", href: "cup.html", label: "McQueen Cup", long: "The McQueen Cup", group: "Competitions" },
    { id: "victory-road", href: "victory-road.html", label: "Victory Road", group: "Competitions" },
    { id: "clubs", href: "clubs.html", label: "Clubs", group: "Clubs & players" },
    { id: "h2h", href: "h2h.html", label: "H2H", long: "Head-to-Head", group: "Clubs & players" },
    { id: "transfers", href: "transfers.html", label: "Transfers", group: "Clubs & players" },
    { id: "draft", href: "draft.html", label: "Draft", long: "Draft board", group: "Clubs & players" },
    { id: "trade", href: "trade.html", label: "Trade Calculator (WIP)", group: "Stats" },
    { id: "players", href: "players.html", label: "Player stats", group: "Stats" },
    { id: "analytics", href: "analytics.html", label: "Analytics", group: "Stats" },
    { id: "records", href: "records.html", label: "Records", long: "Hall of Records", group: "Stats" },
  ];
  const current = document.body.dataset.page || "home";
  const link = (p, long) => `<a href="${p.href}"${p.id === current ? ' class="is-active" aria-current="page"' : ""}>${long ? p.long || p.label : p.label}</a>`;
  const arrow = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 11L11 5M6 5h5v5" /></svg>`;
  // Desktop: the first group ("This week") sits in the bar, every other group is a dropdown.
  // Phone menu: each group is collapsible; only "This week" is open whenever the menu opens.
  const GROUPS = [...new Set(PAGES.map((p) => p.group))].map((g) => ({ name: g, pages: PAGES.filter((p) => p.group === g) }));
  const holdsCurrent = (g) => g.pages.some((p) => p.id === current);
  const chev = `<svg class="nav__chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" /></svg>`;
  const desktopNav = GROUPS.map((g, i) => (i === 0
    ? g.pages.map((p) => link(p)).join("")
    : `<div class="nav__group">
        <button type="button" class="nav__drop${holdsCurrent(g) ? " is-active" : ""}" aria-expanded="false" aria-controls="navMenu${i}">${g.name}${chev}</button>
        <div class="nav__menu" id="navMenu${i}">${g.pages.map((p) => link(p, true)).join("")}</div>
      </div>`)).join("");
  const mobileNav = GROUPS.map((g, i) => `<details class="mm-group"${i === 0 ? " open" : ""}>
        <summary>${g.name}${chev}</summary>
        ${g.pages.map((p) => link(p, true)).join("")}
      </details>`).join("");

  const header = `
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="nav${current === "home" ? "" : " is-solid is-page"}" id="nav">
    <div class="nav__inner">
      <a class="brand" href="index.html" aria-label="The Mater League home"${current === "home" ? ' aria-current="page"' : ""}>
        <svg class="brand__ball" viewBox="0 0 40 40" aria-hidden="true"><use href="#ball" /></svg>
        <span class="brand__word">MATER<em>LEAGUE</em></span>
      </a>
      <nav class="nav__links" aria-label="Primary">${desktopNav}</nav>
      <a class="nav__cta" href="https://sleeper.com/leagues/1390750210698780672" target="_blank" rel="noopener">Sleeper ${arrow}</a>
      <button type="button" class="nav__theme" id="navTheme" aria-label="Switch to dark mode" aria-pressed="false">
        <svg class="i-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
        <svg class="i-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
      </button>
      <button type="button" class="nav__refresh" id="navRefresh" aria-label="Refresh">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" /></svg>
      </button>
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
      ${mobileNav}
      <a href="#" class="mobile-menu__install" data-install-link hidden>Add to home screen</a>
    </nav>
  </header>`;

  const footer = `
  <footer class="footer">
    <div class="footer__inner">
      <span class="brand__word">MATER<em>LEAGUE</em></span>
      <nav class="footer__links" aria-label="Footer"><a href="index.html">Home</a>${PAGES.map((p) => `<a href="${p.href}">${p.long || p.label}</a>`).join("")}<a href="#" data-install-link hidden>Get the app</a></nav>
      <p>Mater League, running since 2026. Created by Pep Guardiola's successor, Nico.</p>
      <p>Live data from the Sleeper API. Not affiliated with the Premier League or Sleeper.</p>
      <p class="footer__updated" id="updated" aria-live="polite"></p>
    </div>
  </footer>
  <div class="tooltip" id="tooltip" role="tooltip" hidden></div>
  <dialog class="pd" id="playerDlg" aria-labelledby="playerDlgTitle">
    <button type="button" class="pd__close" aria-label="Close">×</button>
    <div id="playerDlgBody"></div>
  </dialog>
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

  // installed home-screen app: no address bar, so the nav gets its own refresh button
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  document.documentElement.classList.toggle("is-standalone", standalone);
  document.body.insertAdjacentHTML("afterbegin", header);
  // dropdowns: hover opens them on a mouse (CSS); a click/tap or keyboard toggles them, and a click
  // anywhere else or Escape closes them
  const drops = [...document.querySelectorAll(".nav__group")];
  const setOpen = (grp, open) => { grp.classList.toggle("is-open", open); grp.querySelector(".nav__drop").setAttribute("aria-expanded", String(open)); };
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".nav__drop");
    drops.forEach((g) => setOpen(g, btn ? g === btn.parentElement && !g.classList.contains("is-open") : false));
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") drops.forEach((g) => setOpen(g, false)); });
  drops.forEach((g) => g.addEventListener("focusout", (e) => { if (!g.contains(e.relatedTarget)) setOpen(g, false); }));
  document.getElementById("navToggle").addEventListener("click", () => {
    document.querySelectorAll(".mm-group").forEach((d, i) => (d.open = i === 0));
  });
  // light / dark: <head> applies the saved choice before first paint; this button flips and saves it
  const themeBtn = document.getElementById("navTheme");
  const paintTheme = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    themeBtn.setAttribute("aria-pressed", String(dark));
    themeBtn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#08111f" : "#1b0020");
  };
  themeBtn.addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    if (dark) document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem("mater-theme", dark ? "dark" : "light"); } catch (_) {}
    paintTheme();
    window.dispatchEvent(new Event("mater-theme"));
  });
  paintTheme();
  document.getElementById("navRefresh").addEventListener("click", (e) => {
    e.currentTarget.classList.add("is-spinning");
    location.reload();
  });
  document.body.insertAdjacentHTML("beforeend", footer);
  window.MATER_PAGES = PAGES;
})();

// ---------- "Get the app": add the site to the home screen ----------
// Android / desktop Chrome & Edge: one tap opens the browser's own install dialog (beforeinstallprompt).
// iPhone / iPad: Apple doesn't let a page do that, so the button opens a 3-step picture guide instead.
// Phones and tablets only, never on desktop. Hidden inside the installed app (standalone),
// and the bar stays away for 14 days after someone closes it.
(() => {
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isPhone = isIOS || /Android|Mobile/.test(ua);   // phones and tablets only: never on a desktop or laptop
  const installed = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const KEY = "mater-install-dismissed";
  const dismissedRecently = () => { try { return Date.now() - (+localStorage.getItem(KEY) || 0) < 14 * 864e5; } catch (_) { return false; } };
  let deferred = null;

  const share = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4" /><path d="M6 11H5v10h14V11h-1" /></svg>`;
  const plus = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 8v8M8 12h8" /></svg>`;
  const dots = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>`;
  const kebab = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" /></svg>`;

  document.body.insertAdjacentHTML("beforeend", `
  <div class="install-bar" id="installBar" role="region" aria-label="Get the app" hidden>
    <img src="icons/apple-touch-icon.png" alt="" width="44" height="44">
    <p><b>Get the Mater League app</b><small>Free · one tap to your home screen</small></p>
    <button type="button" class="install-bar__add" data-install>Add</button>
    <button type="button" class="install-bar__x" aria-label="Not now">×</button>
  </div>
  <dialog class="install-sheet" id="installSheet" aria-labelledby="installTitle">
    <button type="button" class="install-sheet__x" aria-label="Close">×</button>
    <img src="icons/apple-touch-icon.png" alt="" width="64" height="64">
    <h2 id="installTitle">Add it to your home screen</h2>
    <ol class="install-steps">${isIOS ? `
      <li><span class="install-steps__n">1</span><span>Tap the <b>Share</b> button <i class="install-ico">${share}</i><small>At the bottom of Safari. On newer iPhones, tap <i class="install-ico">${dots}</i> first, then Share.</small></span></li>
      <li><span class="install-steps__n">2</span><span>Scroll down and tap <b>Add to Home Screen</b> <i class="install-ico">${plus}</i><small>Don't see it? Tap <b>More</b> or <b>Edit Actions</b> at the bottom of the list.</small></span></li>
      <li><span class="install-steps__n">3</span><span>Tap <b>Add</b> in the top corner.<small>Mater shows up on your home screen. Done!</small></span></li>` : `
      <li><span class="install-steps__n">1</span><span>Tap your browser's menu <i class="install-ico">${kebab}</i><small>Usually top right, next to the address bar.</small></span></li>
      <li><span class="install-steps__n">2</span><span>Tap <b>Install app</b> or <b>Add to Home screen</b></span></li>
      <li><span class="install-steps__n">3</span><span>Tap <b>Install</b> / <b>Add</b> to confirm.<small>Mater shows up on your home screen. Done!</small></span></li>`}
    </ol>
    <button type="button" class="install-sheet__ok">Got it</button>
  </dialog>`);

  const bar = document.getElementById("installBar"), sheet = document.getElementById("installSheet");
  const links = () => document.querySelectorAll("[data-install-link]");
  function refresh() {
    const on = !installed();
    links().forEach((a) => (a.hidden = !(on && isPhone)));
    bar.hidden = !(on && isPhone && !dismissedRecently());
    document.documentElement.classList.toggle("has-install-bar", !bar.hidden);
  }
  async function install() {
    if (deferred) {
      const d = deferred; deferred = null;
      d.prompt();
      try { if ((await d.userChoice).outcome === "accepted") bar.hidden = true; } catch (_) {}
      refresh();
      return;
    }
    if (typeof sheet.showModal === "function") sheet.showModal(); else sheet.setAttribute("open", "");
  }
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; refresh(); });
  window.addEventListener("appinstalled", () => { deferred = null; refresh(); });
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-install], [data-install-link]")) { e.preventDefault(); install(); return; }
    if (e.target.closest(".install-bar__x")) { try { localStorage.setItem(KEY, String(Date.now())); } catch (_) {} refresh(); return; }
    if (e.target === sheet || e.target.closest(".install-sheet__x, .install-sheet__ok")) sheet.close ? sheet.close() : sheet.removeAttribute("open");
  });
  refresh();
})();
