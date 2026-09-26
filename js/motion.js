/* =========================================================
   Hero motion: background video (landscape match on wide
   screens, portrait celebration on phones) + nav scroll ball.
   ========================================================= */
(function () {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const portrait = window.matchMedia("(max-aspect-ratio: 4/5), (max-width: 640px)");
  const hero = document.querySelector(".hero");
  const video = document.getElementById("heroVideo");
  const toggle = document.getElementById("motionToggle");

  // the hero video only exists on the home page
  if (hero && video && toggle) {
    // Clips rotate with a crossfade. Wide screens and phones each get their own order; landscape
    // clips are centre-cropped on phones (pos sets the focal point). Add a clip = add a line here.
    const PLAYLIST = {
      wide: [
        { src: "media/hero-match.mp4", poster: "media/hero-match.jpg" },
        { src: "media/hero-stadium.mp4", poster: "media/hero-stadium.jpg" },
      ],
      tall: [
        { src: "media/hero-aerial.mp4", poster: "media/hero-aerial.jpg" },
        { src: "media/hero-celebration.mp4", poster: "media/hero-celebration.jpg" },
        { src: "media/hero-stadium.mp4", pos: "72% 50%" },
      ],
    };
    const MIN_SHOW = 7;   // seconds each clip stays up (short clips loop until then)
    const FADE = 1;       // crossfade, seconds

    // a second player sits behind the first so the next clip is ready before we fade to it
    const back = video.cloneNode(false);
    back.removeAttribute("id");
    back.removeAttribute("poster");
    back.classList.add("is-hidden");
    video.after(back);
    const players = [video, back];
    let cur = 0, list = [], idx = 0, shown = 0, lastT = 0, fading = false;
    const played = new Set();
    const active = () => players[cur], standby = () => players[1 - cur];

    let onScreen = true;
    const paused = () => document.body.classList.contains("is-paused");

    function load(el, clip) {
      if (el.dataset.src === clip.src) return;
      el.dataset.src = clip.src;
      el.style.objectPosition = clip.pos || "";
      el.src = clip.src;
      el.load();
    }
    function start() {
      const el = active(), clip = list[idx];
      el.loop = list.length === 1 || (Number.isFinite(el.duration) && el.duration < MIN_SHOW);
      shown = 0; lastT = 0;
      if (list.length > 1) load(standby(), list[(idx + 1) % list.length]);
      sync();
    }
    function advance() {
      if (fading || list.length < 2) return;
      fading = true;
      const from = active(), to = standby();
      idx = (idx + 1) % list.length;
      load(to, list[idx]);
      to.currentTime = 0;
      to.play().catch(() => {});
      to.classList.remove("is-hidden");
      from.classList.add("is-hidden");
      setTimeout(() => { from.pause(); cur = 1 - cur; fading = false; start(); }, FADE * 1000);
    }
    players.forEach((el) => {
      el.addEventListener("loadedmetadata", () => { if (el === active()) el.loop = list.length === 1 || (Number.isFinite(el.duration) && el.duration < MIN_SHOW); });
      el.addEventListener("timeupdate", () => {
        if (el !== active() || fading) return;
        const t = el.currentTime, d = Number.isFinite(el.duration) ? el.duration : Infinity;
        shown += t >= lastT ? t - lastT : t;
        lastT = t;
        const longClip = d >= MIN_SHOW;
        if (list.length > 1 && ((longClip && t >= d - FADE - 0.15) || (!longClip && shown >= MIN_SHOW))) advance();
      });
      // browser-recorded clips don't always report their length up front, so also move on the
      // moment a clip ends (a clip that must keep looping has loop set and never fires this)
      el.addEventListener("ended", () => {
        if (el !== active() || fading) return;
        if (list.length > 1) advance(); else { el.currentTime = 0; el.play().catch(() => {}); }
      });
      el.addEventListener("loadeddata", () => { if (el.dataset.src) played.add(el.dataset.src); });
      // a clip that has never loaded is dropped; one that hiccups mid-download just skips ahead
      el.addEventListener("error", () => {
        const bad = el.dataset.src;
        if (!bad) return;
        if (played.has(bad) && list.length > 1) {
          el.dataset.src = "";
          if (el === active()) advance();
          return;
        }
        list = list.filter((c) => c.src !== bad);
        el.dataset.src = "";
        if (!list.length) return;
        idx = idx % list.length;
        if (el === active()) { load(el, list[idx]); start(); }
      });
    });

    // pick the playlist that fits the screen shape; only restart when it actually changes
    function chooseClip() {
      const key = portrait.matches ? "tall" : "wide";
      if (video.dataset.set === key && !reduceMotion.matches) return;
      video.dataset.set = key;
      list = PLAYLIST[key].slice();
      idx = 0;
      video.poster = list[0].poster || "";
      if (reduceMotion.matches) {
        players.forEach((el) => { el.pause(); el.removeAttribute("src"); el.dataset.src = ""; el.load(); });
        return;
      }
      if (cur !== 0) { players[1].classList.add("is-hidden"); players[0].classList.remove("is-hidden"); cur = 0; }
      load(active(), list[0]);
      start();
    }

    // play only when motion is allowed, not paused by the user, and the hero is visible
    function sync() {
      const el = active();
      if (!el.getAttribute("src")) return;
      if (!reduceMotion.matches && !paused() && onScreen) el.play().catch(() => {});
      else players.forEach((p) => p.pause());
    }

    new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      hero.classList.toggle("is-offscreen", !onScreen);
      sync();
    }).observe(hero);

    // user-facing pause (WCAG 2.2.2 — moving content needs a stop control)
    function setPaused(p) {
      document.body.classList.toggle("is-paused", p);
      toggle.setAttribute("aria-pressed", String(p));
      toggle.querySelector("span").textContent = p ? "Play video" : "Pause video";
      toggle.querySelector("svg").innerHTML = p
        ? '<path d="M4 3l9 5-9 5z"/>'
        : '<rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/>';
      sync();
      try { localStorage.setItem("nym-motion", p ? "off" : "on"); } catch (_) {}
    }
    toggle.addEventListener("click", () => setPaused(!paused()));

    portrait.addEventListener("change", chooseClip);
    reduceMotion.addEventListener("change", () => {
      video.dataset.set = "";
      toggle.hidden = reduceMotion.matches;
      chooseClip();
    });

    let saved = null;
    try { saved = localStorage.getItem("nym-motion"); } catch (_) {}
    toggle.hidden = reduceMotion.matches;
    if (saved === "off" && !reduceMotion.matches) setPaused(true);
    chooseClip();
  }

  // ---------- nav: solid on scroll + rolling ball progress ----------
  const nav = document.getElementById("nav");
  const roller = document.getElementById("roller");
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      nav.classList.toggle("is-solid", y > 40 || nav.classList.contains("is-page") || nav.classList.contains("is-open"));
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? y / max : 0;
      const x = p * (window.innerWidth - 12);
      roller.style.transform = `translateX(${x}px) rotate(${(x / 6) * (180 / Math.PI)}deg)`;
      ticking = false;
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });

  onScroll();
})();
