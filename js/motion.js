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
    const CLIPS = {
      wide: { src: "media/hero-match.mp4", poster: "media/hero-match.jpg" },
      tall: { src: "media/hero-celebration.mp4", poster: "media/hero-celebration.jpg" },
    };

    let onScreen = true;
    const paused = () => document.body.classList.contains("is-paused");

    // pick the clip that fits the screen shape; only swap when it actually changes
    function chooseClip() {
      const clip = portrait.matches ? CLIPS.tall : CLIPS.wide;
      if (video.dataset.clip === clip.src) return;
      video.dataset.clip = clip.src;
      video.poster = clip.poster;
      if (reduceMotion.matches) { video.removeAttribute("src"); video.load(); return; }
      video.src = clip.src;
      sync();
    }

    // play only when motion is allowed, not paused by the user, and the hero is visible
    function sync() {
      if (!video.getAttribute("src")) return;
      if (!reduceMotion.matches && !paused() && onScreen) video.play().catch(() => {});
      else video.pause();
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
      video.dataset.clip = "";
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
