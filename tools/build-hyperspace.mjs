#!/usr/bin/env node
// Hyperspace: streaks in the painted streaks' colors, rushing out of the vanishing point.
//
// hyperspace-open.jpg is the raw painting with the cockpit removed and the
// hyperspace filling the frame; hyperspace-backdrop.jpg is that edit with
// the streaks removed, leaving the nebula. The backdrop, darkened, is the
// fixed background; open minus backdrop gives each ray the color of its
// painted streaks, which then fly along it as short streaks with dark gaps.
//
// Streaks fly out along rays. A ray's phase runs with log radius, so each
// streak moves outward at a speed, and with a length, proportional to its
// distance from the center: dots creep out of the middle and become long
// streaks whipping past the edges. (True perspective, -1/r, stretches them
// across the whole screen.) Every thin wedge of angle is one ray with its own
// spacing and offset, so no rings form. Streak pixels are clustered by
// color; the nebula between streaks stays fixed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/png-node.mjs';
import { decodePlate } from './decode-plate.mjs';
import { cover, kmeans, nearestIndex, indexImage, consoleColor } from '../src/palette-tools.mjs';
import { packThemeImage, parseThemeImage } from '../src/theme.mjs';
import { renderTheme } from '../src/renderer.mjs';
import { interfaceColors } from './build-panoramas.mjs';
import { writeSdTheme } from './theme-output.mjs';
import { kmeansVectors } from './build-aurora.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'assets/cycling-sources');
const W = 640, H = 480, BLEND = 2;
// The vanishing point (fitted to the streak directions), the rays' angular
// width in turns, where their timing starts, and how many streaks a ray holds
// per e-fold of radius (more is slower and shorter), and the share of rays
// that carry streaks at all.
const CENTER = [317.4, 238.9], RAY_WEDGE = 1 / 900, RAY_START = 4, RAY_CYCLES = [1.1, 1.8], RAY_SHARE = 0.42;
// Only rays whose streak light is brighter than BLOB_MIN carry streaks;
// pixels whose streak light is below LIGHT_MIN stay fixed.
const LIGHT_MIN = 14, BLOB_MIN = 30, CLUSTERS = 13, ENTRIES = 16, TICKS = 3;
// A streak: glow between streaks (none), head brightness, and trail in entries.
const STEADY = 0, HEAD = 1.8, TAIL = 2.3;
// The nebula backdrop is darkened to this fraction.
const BACKDROP = 0.32;
// Charm: ray wobble (turns), pulse speckle depth, and pulse edge jitter (entries).
const WOBBLE = 0.0005, SPARKLE = 0.55, JITTER = 0.9;

const frac = v => v - Math.floor(v);
const hash = (a, b = 0) => frac(Math.sin(a * 12.9898 + b * 78.233 + 4.1) * 43758.5453);
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const surge = j => { const back = ENTRIES - 1 - j; return STEADY + (HEAD - STEADY) * Math.exp(-back / TAIL); };

export async function buildHyperspace() {
  const read = async name => cover(decodePlate(new Uint8Array(await fs.readFile(path.join(sources, name)))), W, H);
  const [image, backdrop] = await Promise.all([read('hyperspace-open.jpg'), read('hyperspace-backdrop.jpg')]);
  const at = (img, p) => [img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]];
  const painted = p => { const a = at(image, p), b = at(backdrop, p); return a.map((v, i) => v - b[i]); };
  const radius = p => Math.max(RAY_START, Math.hypot(p % W - CENTER[0], ((p / W) | 0) - CENTER[1]));
  // A pixel's ray, from its angle wobbled a little with distance, so the
  // paths meander rather than run ruler-straight.
  const rayOf = p => {
    const x = p % W, y = (p / W) | 0, turn = frac(Math.atan2(y - CENTER[1], x - CENTER[0]) / (2 * Math.PI)), r = Math.hypot(x - CENTER[0], y - CENTER[1]);
    const wobble = WOBBLE * Math.sin(r / 31 + 40 * turn) * Math.min(1, r / 120);
    return Math.floor(frac(turn + wobble) / RAY_WEDGE);
  };
  // Per-pixel speckle on the pulses, so they read as dithered sparks.
  const sparkle = p => 1 - SPARKLE * hash(p % W * 0.917, ((p / W) | 0) * 1.31);
  // Each ray carries its brightest painted streak's light (from where the
  // streaks are clear of the center) as the color of the streaks flying along it.
  const blobs = new Map();
  for (let p = 0; p < W * H; p++) {
    if (radius(p) < 40) continue;
    const l = painted(p), ray = rayOf(p), best = blobs.get(ray);
    if (!best || luma(l) > luma(best)) blobs.set(ray, l);
  }
  const base = p => at(backdrop, p).map(v => v * BACKDROP);
  const strong = l => l && luma(l) > BLOB_MIN ? l : [0, 0, 0];
  // Only a share of the rays carry streaks, so dark space separates them.
  const glow = p => (hash(rayOf(p), 3) < RAY_SHARE ? strong(blobs.get(rayOf(p))) : [0, 0, 0]).map(v => v * sparkle(p) * (0.35 + 0.65 * Math.min(1, radius(p) / 240)));
  const colors = [], ranges = [], index = new Int16Array(W * H).fill(-1);

  const streaks = [];
  for (let p = 0; p < W * H; p++) if (luma(glow(p)) > LIGHT_MIN) streaks.push(p);
  const mean = Array.from({ length: ENTRIES }, (_, j) => surge(j)).reduce((a, b) => a + b) / ENTRIES;
  // Clusters of (field color, pulse light); the field is dithered to the painting.
  const centers = kmeansVectors(streaks.filter((_, i) => i % 3 === 0).map(p => [...base(p), ...glow(p)]), CLUSTERS)
    .map(c => [c.slice(0, 3), c.slice(3)]);
  const starts = centers.map(([b, g]) => {
    const start = colors.length;
    for (let j = 0; j < ENTRIES; j++) colors.push(consoleColor(b.map((v, i) => v + g[i] * surge(j))));
    ranges.push({ start, length: ENTRIES, stepTicks: TICKS, flags: BLEND });
    return start;
  });
  const inSet = new Uint8Array(W * H), error = new Float32Array(W * H * 3);
  for (const p of streaks) inSet[p] = 1;
  for (const p of streaks) {
    const x = p % W, y = (p / W) | 0, want = base(p).map((v, i) => v + error[p * 3 + i]), g = glow(p);
    let k = 0, best = Infinity;
    centers.forEach(([cb, cg], j) => { const d = d2(cb, want) + d2(cg, g); if (d < best) { best = d; k = j; } });
    for (const [dx, dy, w] of [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]) {
      const q = (y + dy) * W + x + dx;
      if (x + dx < 0 || x + dx >= W || y + dy >= H || !inSet[q]) continue;
      for (let i = 0; i < 3; i++) error[q * 3 + i] += (want[i] - centers[k][0][i]) * w * 0.8;
    }
    // This pixel's ray: its wedge of angle sets its depth and offset.
    const ray = rayOf(p), cycles = RAY_CYCLES[0] + hash(ray, 1) * (RAY_CYCLES[1] - RAY_CYCLES[0]);
    const phase = cycles * Math.log(radius(p) / RAY_START) + hash(ray, 2);
    // Jitter of up to an entry roughens each pulse's front and tail.
    index[p] = starts[k] + Math.floor(frac(phase) * ENTRIES + JITTER * hash(x * 1.7, y * 0.53)) % ENTRIES;
  }

  const fixedStart = colors.length, fixed = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0) fixed.push(base(p));
  for (const c of kmeans(fixed, 256 - fixedStart)) colors.push(consoleColor(c));
  const indices = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++)
    indices[p] = index[p] >= 0 ? index[p] : nearestIndex(colors, fixedStart, colors.length - fixedStart, base(p));
  const theme = {
    name: 'Hyperspace', family: 'Cycling', colors: interfaceColors(image),
    background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges },
    border: { source: 'internal', id: 8 },
  };
  const packed = packThemeImage(theme, { staticBackground: indexImage(W, H, indices), staticPalette: colors });
  await writeSdTheme('hyperspace.png', packed.image);
  const parsed = parseThemeImage(packed.image), preview = path.join(root, 'out/previews/cycling');
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(path.join(preview, 'hyperspace.png'), encodePng(renderTheme(parsed, { time: 0 })));
  console.log(`Hyperspace: ${ranges.length} ranges, ${colors.length - fixedStart} fixed colors; ${streaks.length}px of streaks`);
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildHyperspace();
