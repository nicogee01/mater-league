/* =========================================================
   Hero motion: running footballers, dribbled ball, turf spray,
   scroll-rolling ball in the nav. Pure SVG + CSS + one canvas.
   ========================================================= */
(function () {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const hero = document.querySelector(".hero");
  const runnersEl = document.getElementById("runners");
  const canvas = document.getElementById("turf");
  const toggle = document.getElementById("motionToggle");

  // ---------- runner SVG ----------
  // Side-on sprinter facing right. Hip at (50,92), knee at (50,120).
  // Limbs are nested groups so the CSS run cycle rotates thigh → shin naturally.
  function runnerSVG({ kit, trim, number, ball = false, rim = "#04f5ff" }) {
    const body = "#0a000d";
    const leg = (cls, shade) => `
      <g class="thigh ${cls}">
        <line x1="50" y1="92" x2="50" y2="121" stroke="${shade}" stroke-width="10.5" stroke-linecap="round"/>
        <line x1="50" y1="90" x2="50" y2="104" stroke="${trim}" stroke-width="12.5" stroke-linecap="round" opacity="${cls === "leg-a" ? 1 : 0.55}"/>
        <g class="shin">
          <line x1="50" y1="120" x2="50" y2="150" stroke="${shade}" stroke-width="8" stroke-linecap="round"/>
          <line x1="50" y1="128" x2="50" y2="146" stroke="${kit}" stroke-width="8.5" stroke-linecap="round" opacity="${cls === "leg-a" ? 0.9 : 0.45}"/>
          <path d="M45 147 h12 q6 0 6 4 v1 h-18 z" fill="${shade}"/>
        </g>
      </g>`;
    const arm = (cls, shade) => `
      <g class="arm ${cls}">
        <line x1="56" y1="52" x2="56" y2="74" stroke="${shade}" stroke-width="6.5" stroke-linecap="round"/>
        <line x1="56" y1="74" x2="68" y2="81" stroke="${shade}" stroke-width="6" stroke-linecap="round"/>
        <line x1="56" y1="50" x2="56" y2="60" stroke="${kit}" stroke-width="8.5" stroke-linecap="round" opacity="${cls === "arm-a" ? 1 : 0.5}"/>
      </g>`;
    const ballMarkup = ball
      ? `<g class="ball-rig"><svg x="74" y="139" width="16" height="16" viewBox="0 0 40 40" overflow="visible"><g class="ball-spin"><use href="#ball" width="40" height="40"/></g></svg></g>`
      : "";
    return `
      <svg viewBox="0 0 140 160" aria-hidden="true" style="filter: drop-shadow(0 0 1.5px ${rim}) drop-shadow(-10px 0 18px ${rim}55)">
        <ellipse cx="58" cy="155" rx="34" ry="4" fill="#000" opacity="0.45"/>
        <g class="rig">
          ${arm("arm-b", "#1d0522")}
          ${leg("leg-b", "#1d0522")}
          <path d="M46 43 Q58 36 68 45 L61 94 L43 94 Q41 70 46 43 Z" fill="${kit}"/>
          <text x="52" y="74" font-family="Anton, Impact, sans-serif" font-size="16" fill="${trim}" text-anchor="middle" opacity="0.9">${number}</text>
          <path d="M42 88 L62 88 L63 103 L42 103 Z" fill="${body}"/>
          ${leg("leg-a", body)}
          <rect x="56" y="31" width="7" height="12" rx="3" fill="${body}"/>
          <circle cx="61" cy="25" r="9.5" fill="${body}"/>
          ${arm("arm-a", body)}
        </g>
        ${ballMarkup}
      </svg>`;
  }

  const kits = [
    { kit: "#00ff85", trim: "#37003c", rim: "#04f5ff" },
    { kit: "#ff2882", trim: "#ffffff", rim: "#ff2882" },
    { kit: "#ffffff", trim: "#37003c", rim: "#04f5ff" },
    { kit: "#04f5ff", trim: "#14001a", rim: "#04f5ff" },
    { kit: "#ffd166", trim: "#37003c", rim: "#ffd166" },
  ];

  function place(opts) {
    const el = document.createElement("div");
    el.className = "runner " + (opts.cls || "");
    el.innerHTML = runnerSVG(opts);
    Object.assign(el.style, opts.style);
    el.style.setProperty("--stride", opts.stride + "s");
    if (opts.flip) el.firstElementChild.style.transform = "scaleX(-1)";
    runnersEl.appendChild(el);
    return el;
  }

  let heroRunner;
  function build() {
    runnersEl.innerHTML = "";
    const w = window.innerWidth;
    const mobile = w < 860;
    const still = reduceMotion.matches;

    // background players crossing the far side of the pitch
    const far = [
      { k: 2, n: 7,  h: 15, b: 36, dur: 13, delay: -2,  flip: false, blur: 1.2, o: 0.55 },
      { k: 3, n: 4,  h: 12, b: 40, dur: 17, delay: -9,  flip: true,  blur: 1.8, o: 0.4 },
      { k: 4, n: 11, h: 17, b: 32, dur: 11, delay: -6,  flip: false, blur: 0.8, o: 0.6 },
      { k: 1, n: 23, h: 11, b: 42, dur: 19, delay: -14, flip: true,  blur: 2.2, o: 0.35 },
    ];
    far.forEach((f, i) => {
      const hPx = (f.h / 100) * window.innerHeight;
      const style = {
        height: hPx + "px",
        width: hPx * (140 / 160) + "px",
        bottom: f.b + "%",
        opacity: f.o,
        filter: `blur(${f.blur}px)`,
      };
      if (still) {
        style.left = 30 + i * 16 + "%";
      } else {
        style.animationDelay = f.delay + "s";
      }
      const el = place({ ...kits[f.k], number: f.n, stride: 0.5 + f.h / 60, flip: f.flip, cls: still ? "" : "runner--cross", style });
      if (!still) {
        el.style.setProperty("--dur", f.dur + "s");
        el.style.setProperty("--from", f.flip ? "110vw" : "-15vw");
        el.style.setProperty("--to", f.flip ? "-15vw" : "110vw");
        el.style.setProperty("--s", "1");
      }
    });

    // the chaser — a defender closing in
    const chaserH = mobile ? 30 : 40;
    place({
      ...kits[1], number: 5, stride: 0.58, cls: "runner--hero",
      style: {
        height: chaserH + "vh", width: `calc(${chaserH}vh * 0.875)`,
        left: mobile ? "2%" : "46%", bottom: mobile ? "30%" : "16%",
        opacity: mobile ? 0.35 : 0.8, filter: "blur(0.6px) brightness(0.8)", animationDelay: "-3s",
      },
    });

    // the star — on the ball
    const heroH = mobile ? 38 : 54;
    heroRunner = place({
      ...kits[0], number: 10, stride: 0.62, ball: true, cls: "runner--hero",
      style: {
        height: heroH + "vh", width: `calc(${heroH}vh * 0.875)`,
        left: mobile ? "38%" : "58%", bottom: mobile ? "30%" : "12%",
        opacity: mobile ? 0.55 : 1,
      },
    });
  }

  // ---------- turf spray + floodlight dust ----------
  const ctx = canvas.getContext("2d");
  let particles = [];
  let dpr = 1, running = false, raf = 0, last = 0;

  function sizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(dt) {
    if (!heroRunner) return;
    const hr = heroRunner.getBoundingClientRect();
    const hb = hero.getBoundingClientRect();
    const footX = hr.left - hb.left + hr.width * 0.36;
    const footY = hr.top - hb.top + hr.height * 0.93;
    // kicked-up turf behind the planted foot
    const n = Math.random() < dt * 40 ? 2 : 0;
    for (let i = 0; i < n; i++) {
      particles.push({
        x: footX + (Math.random() - 0.5) * 20, y: footY,
        vx: -(120 + Math.random() * 220), vy: -(80 + Math.random() * 180),
        g: 520, life: 0.9 + Math.random() * 0.5, age: 0,
        r: 1 + Math.random() * 2.2,
        c: Math.random() < 0.7 ? "34,197,94" : "255,255,255",
      });
    }
    // slow-drifting floodlight dust
    if (Math.random() < dt * 8) {
      particles.push({
        x: Math.random() * hb.width, y: Math.random() * hb.height * 0.7,
        vx: -(10 + Math.random() * 30), vy: -(4 + Math.random() * 10),
        g: 0, life: 4 + Math.random() * 3, age: 0, r: 0.6 + Math.random() * 1.2, c: "255,255,255", dust: true,
      });
    }
  }

  function tick(t) {
    if (!running) return;
    const dt = Math.min((t - last) / 1000 || 0.016, 0.05);
    last = t;
    spawn(dt);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles = particles.filter((p) => (p.age += dt) < p.life);
    for (const p of particles) {
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const a = p.dust ? Math.sin((p.age / p.life) * Math.PI) * 0.5 : 1 - p.age / p.life;
      ctx.fillStyle = `rgba(${p.c},${a})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    raf = requestAnimationFrame(tick);
  }
  function start() {
    if (running || reduceMotion.matches || document.body.classList.contains("is-paused")) return;
    running = true; last = performance.now(); raf = requestAnimationFrame(tick);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  // pause the whole stage when the hero scrolls away
  new IntersectionObserver(([e]) => {
    hero.classList.toggle("is-offscreen", !e.isIntersecting);
    e.isIntersecting ? start() : stop();
  }).observe(hero);

  // user-facing pause (WCAG 2.2.2 — moving content needs a stop control)
  function setPaused(p) {
    document.body.classList.toggle("is-paused", p);
    toggle.setAttribute("aria-pressed", String(p));
    toggle.querySelector("span").textContent = p ? "Play motion" : "Pause motion";
    toggle.querySelector("svg").innerHTML = p
      ? '<path d="M4 3l9 5-9 5z"/>'
      : '<rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/>';
    p ? (stop(), ctx.clearRect(0, 0, canvas.width, canvas.height)) : start();
    try { localStorage.setItem("nym-motion", p ? "off" : "on"); } catch (_) {}
  }
  toggle.addEventListener("click", () => setPaused(!document.body.classList.contains("is-paused")));

  // ---------- nav: solid on scroll + rolling ball progress ----------
  const nav = document.getElementById("nav");
  const roller = document.getElementById("roller");
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      nav.classList.toggle("is-solid", y > 40);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? y / max : 0;
      const x = p * (window.innerWidth - 12);
      roller.style.transform = `translateX(${x}px) rotate(${(x / 6) * (180 / Math.PI)}deg)`;
      ticking = false;
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });

  // ---------- init ----------
  let resizeT;
  window.addEventListener("resize", () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { build(); sizeCanvas(); }, 150);
  });
  reduceMotion.addEventListener?.("change", () => { build(); reduceMotion.matches ? stop() : start(); });

  build();
  sizeCanvas();
  onScroll();
  let saved = null;
  try { saved = localStorage.getItem("nym-motion"); } catch (_) {}
  if (reduceMotion.matches) {
    toggle.hidden = true;
  } else {
    setPaused(saved === "off");
  }
})();
