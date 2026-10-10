#!/usr/bin/env node
/*
  Draws the app icon (a football on the league's purple) as icons/icon.svg, then renders the
  PNG sizes phones ask for with headless Chrome:

    node scripts/make-icons.mjs

  icon-512 / icon-192: Android + desktop Chrome ("Install app"), from manifest.webmanifest
  apple-touch-icon (180): iPhone/iPad Safari "Add to Home Screen"
  The ball sits inside the middle 80%, so Android's round/squircle masks never clip it.
*/
import { writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "icons");
await mkdir(out, { recursive: true });

// --- the ball: a truncated icosahedron seen face-on (one pentagon in the middle, five round the edge)
const C = 256, R = 168;                               // centre and radius in a 512 box
const pt = (a, d, cx = C, cy = C) => [cx + d * Math.cos((a * Math.PI) / 180), cy + d * Math.sin((a * Math.PI) / 180)];
const poly = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("") + "Z";
const pent = (cx, cy, r, rot) => Array.from({ length: 5 }, (_, i) => pt(rot + i * 72, r, cx, cy));

const inner = pent(C, C, R * 0.33, -90);
const outer = Array.from({ length: 5 }, (_, k) => {
  const a = -90 + k * 72;
  const [cx, cy] = pt(a, R * 0.93);
  return { a, pts: pent(cx, cy, R * 0.3, a + 180) };   // one corner points back at the centre
});
const seams = [];
outer.forEach((o, k) => {
  seams.push([inner[k], o.pts[0]]);                       // centre pentagon corner → outer pentagon
  const next = outer[(k + 1) % 5];
  seams.push([o.pts[4], next.pts[1]]);                    // hexagon edge between neighbouring outer pentagons
});
const line = ([a, b]) => `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a0052"/><stop offset="1" stop-color="#1b0020"/></linearGradient>
    <radialGradient id="shade" cx="0.38" cy="0.34" r="0.75"><stop offset="0" stop-color="#ffffff"/><stop offset="0.7" stop-color="#eeeef2"/><stop offset="1" stop-color="#c9c6d3"/></radialGradient>
    <clipPath id="ball"><circle cx="${C}" cy="${C}" r="${R}"/></clipPath>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="${C}" cy="${C + 10}" r="${R + 6}" fill="#000" opacity=".28"/>
  <circle cx="${C}" cy="${C}" r="${R + 10}" fill="#00ff85"/>
  <circle cx="${C}" cy="${C}" r="${R}" fill="url(#shade)"/>
  <g clip-path="url(#ball)">
    <path d="${seams.map(line).join("")}" stroke="#2a0030" stroke-width="7" stroke-linecap="round" fill="none"/>
    <path d="${[inner, ...outer.map((o) => o.pts)].map(poly).join("")}" fill="#2a0030" stroke="#2a0030" stroke-width="6" stroke-linejoin="round"/>
  </g>
  <circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="#2a0030" stroke-width="6"/>
</svg>
`;
await writeFile(join(out, "icon.svg"), svg);

// --- PNGs via headless Chrome (or Edge)
const browsers = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
];
const exe = browsers.find((b) => existsSync(b));
if (!exe) { console.log("icons/icon.svg written; no Chrome found to render PNGs."); process.exit(0); }
const tmp = join(tmpdir(), `mater-icons-${process.pid}`);
await mkdir(tmp, { recursive: true });
for (const [name, size] of [["icon-512.png", 512], ["icon-192.png", 192], ["apple-touch-icon.png", 180]]) {
  const page = join(tmp, `${size}.html`);
  await writeFile(page, `<!doctype html><html><body style="margin:0;background:#1b0020">${svg.replace("<svg ", `<svg width="${size}" height="${size}" style="display:block" `)}</body></html>`);
  execFileSync(exe, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    `--window-size=${size},${size}`, `--screenshot=${join(out, name)}`, pathToFileURL(page).href], { stdio: "ignore" });
  console.log(`icons/${name}`);
}
await rm(tmp, { recursive: true, force: true });
