#!/usr/bin/env node
// Waterfall Grotto: water pouring down the falls and ripples rolling out
// across the pool, by palette cycling.
//
// Sources (see the .prompt files):
//   waterfall-grotto-raw.jpg   the painting; the base.
//   waterfall-grotto-mask.png  a segmentation of it: the falling water red,
//                              the pool's surface blue, the mist green.
//
// The falls: the painting is smeared down each column into a plate that
// keeps the curtain's sheets and gaps but none of its streaks; clumps of
// water then fall over it along each column, picking up speed as they drop
// (phase runs with the square root of the fall), so they stretch into
// streaks lower down. Neighboring columns are offset by smooth noise plus a
// little hash, so the clumps form ragged chevrons, and the water churns where
// it plunges into the pool.
//
// The pool: rings spread out from the foot of the falls, laid out in ground
// coordinates so they crowd together into the distance, and brighten and
// darken the painted water as they pass; noise wobbles them and breaks them
// into glinting dashes. Mist drifts out from the plunge.
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
// Falls: clusters, loop length and speed; the plate's smear radius; clumps
// per square root pixel of fall; the lip's head start (px) so the water
// already moves there; the clumps' strength at the lip and once they break
// up; and the churn of the plunge (its height and jitter in entries).
const FALL_CLUSTERS = 6, FALL_ENTRIES = 12, FALL_TICKS = 2, FALL_SMEAR = 14;
const FALL_RATE = 0.42, FALL_HEAD = 20, FALL_LIP = 0.25, FALL_GAIN = 0.55, FALL_BREAKUP = 40;
const PLUNGE = 28, PLUNGE_JITTER = 5;
// How far past the local shadow the darkest entries reach (the profile's
// minimum is -0.7).
const FALL_SHADOW = 1.35;
// The clumps' profile along the fall, one loop: a bright head with a fading
// trail above it, a smaller clump, and a dark gap.
const FALL_PROFILE = [1, 0.62, 0.3, 0.05, -0.2, 0.5, 0.25, -0.1, -0.45, -0.7, -0.55, -0.1];
// Pool: the horizon and focal length (px) that set the ground plane, the
// rings' wavelength there (ground units), and their strength near the falls
// and far out.
const HORIZON = 300, FOCAL = 600, RING = 0.75, RING_NEAR = 0.45, RING_FAR = 0.2, RING_FADE = 8;
const POOL_CLUSTERS = 5, POOL_ENTRIES = 10, POOL_TICKS = 5;
// Mist: drifts outward from the plunge.
const MIST_CLUSTERS = 5, MIST_ENTRIES = 6, MIST_TICKS = 9, MIST_GAIN = 26;

const frac = v => v - Math.floor(v);
const hash = (a, b = 0) => frac(Math.sin(a * 12.9898 + b * 78.233 + 4.1) * 43758.5453);
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Smooth value noise. */
function noise(x, y = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, s = t => t * t * (3 - 2 * t);
  const v = (a, b) => hash(a * 0.913 + 17.1, b * 1.271 - 3.3);
  const top = v(xi, yi) + (v(xi + 1, yi) - v(xi, yi)) * s(fx), bottom = v(xi, yi + 1) + (v(xi + 1, yi + 1) - v(xi, yi + 1)) * s(fx);
  return top + (bottom - top) * s(fy);
}

export async function buildWaterfall() {
  const read = async name => cover(decodePlate(new Uint8Array(await fs.readFile(path.join(sources, name)))), W, H);
  const [image, mask] = await Promise.all([read('waterfall-grotto-raw.jpg'), read('waterfall-grotto-mask.png')]);
  const at = (img, p) => [img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]];
  const label = p => { const [r, g, b] = at(mask, p); return r > 128 && g < 100 && b < 100 ? 'fall' : b > 128 && r < 100 && g < 100 ? 'pool' : g > 128 && r < 100 && b < 100 ? 'mist' : null; };
  const labels = Array.from({ length: W * H }, (_, p) => label(p));
  const colors = [], ranges = [], index = new Int16Array(W * H).fill(-1);

  /**
   * Compile `pixels` into ranges of `entries` colors, each a cluster of
   * (base, light, shade) showing base + light * curve(j), or base faded toward
   * shade by -curve(j) where the curve dips below zero (by default the base
   * darkened in proportion to its light, keeping its hue); pixels choose a cluster
   * dithered toward their base and enter it at `phase(p)` (in loops).
   */
  function compile(pixels, base, light, clusters, entries, ticks, curve, phase,
    shade = p => { const b = base(p), depth = Math.min(0.85, luma(light(p)) / Math.max(1, luma(b))); return b.map(v => v * (1 - depth)); }) {
    const centers = kmeansVectors(pixels.filter((_, i) => i % 3 === 0).map(p => [...base(p), ...light(p), ...shade(p)]), clusters)
      .map(c => [c.slice(0, 3), c.slice(3, 6), c.slice(6)]);
    const starts = centers.map(([b, l, s]) => {
      const start = colors.length;
      for (let j = 0; j < entries; j++) {
        const c = curve(j);
        colors.push(consoleColor(b.map((v, i) => c >= 0 ? v + l[i] * c : v + (s[i] - v) * -c)));
      }
      ranges.push({ start, length: entries, stepTicks: ticks, flags: BLEND });
      return start;
    });
    const inSet = new Uint8Array(W * H), error = new Float32Array(W * H * 3);
    for (const p of pixels) inSet[p] = 1;
    for (const p of pixels.sort((a, b) => a - b)) {
      const x = p % W, y = (p / W) | 0, want = base(p).map((v, i) => v + error[p * 3 + i]), l = light(p);
      let k = 0, best = Infinity;
      centers.forEach(([cb, cl], j) => { const d = d2(cb, want) + d2(cl, l); if (d < best) { best = d; k = j; } });
      for (const [dx, dy, w] of [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]) {
        const q = (y + dy) * W + x + dx;
        if (x + dx < 0 || x + dx >= W || y + dy >= H || !inSet[q]) continue;
        for (let i = 0; i < 3; i++) error[q * 3 + i] += (want[i] - centers[k][0][i]) * w * 0.8;
      }
      index[p] = starts[k] + ((Math.floor(phase(p) * entries) % entries) + entries) % entries;
    }
  }

  // ---- the falls ----
  const fall = [], lip = new Int16Array(W).fill(-1), foot = new Int16Array(W).fill(-1);
  for (let p = 0; p < W * H; p++) if (labels[p] === 'fall') {
    fall.push(p);
    const x = p % W, y = (p / W) | 0;
    if (lip[x] < 0) lip[x] = y;
    foot[x] = y;
  }
  // The plate: each column smeared vertically within the falls. Its shadow
  // is the darkest third of the painted water there, so the gaps between
  // clumps take the painting's own slate rather than a dimmed plate.
  const plate = new Map(), shadow = new Map();
  const mean = list => [0, 1, 2].map(i => list.reduce((a, c) => a + c[i], 0) / list.length);
  for (const p of fall) {
    const x = p % W, y = (p / W) | 0, window = [];
    for (let dy = -FALL_SMEAR; dy <= FALL_SMEAR; dy++) {
      const q = (y + dy) * W + x;
      if (y + dy >= 0 && y + dy < H && labels[q] === 'fall') window.push(at(image, q));
    }
    window.sort((a, b) => luma(a) - luma(b));
    const m = mean(window), dark = mean(window.slice(0, Math.max(1, Math.ceil(window.length / 3))));
    plate.set(p, m);
    shadow.set(p, m.map((v, i) => v + FALL_SHADOW * (dark[i] - v)));
  }
  const fallGain = p => {
    const x = p % W, y = (p / W) | 0;
    return FALL_LIP + (FALL_GAIN - FALL_LIP) * smooth(0, FALL_BREAKUP, y - lip[x]);
  };
  // Light toward white, so clumps read as foam rather than a brighter blue.
  const fallLight = p => { const c = plate.get(p), g = fallGain(p); return c.map(v => g * (0.55 * v + 0.45 * 235)); };
  const column = x => 1.3 * noise(x / 9, 3) + 0.45 * hash(x, 7);
  compile(fall, p => plate.get(p), fallLight, FALL_CLUSTERS, FALL_ENTRIES, FALL_TICKS,
    j => FALL_PROFILE[j], p => {
      const x = p % W, y = (p / W) | 0, drop = y - lip[x];
      const churn = smooth(foot[x] - PLUNGE, foot[x], y) * PLUNGE_JITTER;
      return FALL_RATE * Math.sqrt(drop + FALL_HEAD) + column(x) + ((0.6 + churn) * hash(x * 1.7, y * 0.53)) / FALL_ENTRIES;
    }, p => shadow.get(p));

  // ---- the pool ----
  const pool = [];
  for (let p = 0; p < W * H; p++) if (labels[p] === 'pool') pool.push(p);
  // The foot of the falls on the ground, and each pixel's distance from it.
  let footY = 0, footX0 = W, footX1 = 0;
  for (let x = 0; x < W; x++) if (foot[x] >= 0) { footY = Math.max(footY, foot[x]); footX0 = Math.min(footX0, x); footX1 = Math.max(footX1, x); }
  const ground = (x, y) => { const s = Math.max(4, y - HORIZON); return [(x - W / 2) / s, FOCAL / s]; };
  const [fx0] = ground(footX0, footY), [fx1, fz] = ground(footX1, footY);
  const reach = p => {
    const [gx, gz] = ground(p % W, (p / W) | 0);
    return Math.hypot(gx - Math.max(fx0, Math.min(fx1, gx)), Math.max(0, fz - gz));
  };
  const poolGain = p => {
    const [gx, gz] = ground(p % W, (p / W) | 0), r = reach(p);
    const dashes = smooth(0.3, 0.75, noise(gx * 2.2, gz * 1.4));
    return (RING_FAR + (RING_NEAR - RING_FAR) * Math.exp(-r / RING_FADE)) * (0.35 + 0.65 * dashes);
  };
  // A ring: a narrow bright crest and a broad shallow trough.
  const ringCurve = j => { const u = j / POOL_ENTRIES; const c = ((u + 0.5) % 1) - 0.5; return 1.6 * Math.exp(-(c * c) / 0.018) - 0.45; };
  compile(pool, p => at(image, p), p => at(image, p).map(v => v * poolGain(p)), POOL_CLUSTERS, POOL_ENTRIES, POOL_TICKS,
    ringCurve, p => {
      const [gx, gz] = ground(p % W, (p / W) | 0);
      return (reach(p) / RING + 0.8 * noise(gx * 1.3 + 5, gz * 0.9));
    });

  // ---- the mist ----
  const mist = [];
  for (let p = 0; p < W * H; p++) if (labels[p] === 'mist') mist.push(p);
  const mistCurve = j => Math.sin(2 * Math.PI * j / MIST_ENTRIES);
  compile(mist, p => at(image, p), p => { const y = (p / W) | 0; return [MIST_GAIN, MIST_GAIN * 1.05, MIST_GAIN * 1.12].map(v => v * (0.4 + 0.6 * noise(p % W / 23, y / 11))); },
    MIST_CLUSTERS, MIST_ENTRIES, MIST_TICKS, mistCurve, p => {
      const x = p % W, y = (p / W) | 0;
      return (Math.abs(x - W / 2) / 70 + y / 90 + 0.7 * noise(x / 31, y / 17));
    });

  // ---- everything else ----
  const fixedStart = colors.length, fixed = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0) fixed.push(at(image, p));
  for (const c of kmeans(fixed, 256 - fixedStart)) colors.push(consoleColor(c));
  const indices = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++)
    indices[p] = index[p] >= 0 ? index[p] : nearestIndex(colors, fixedStart, colors.length - fixedStart, at(image, p));
  const theme = {
    name: 'Waterfall Grotto', family: 'Cycling', colors: interfaceColors(image),
    background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges },
    border: { source: 'internal', id: 8 },
  };
  const packed = packThemeImage(theme, { staticBackground: indexImage(W, H, indices), staticPalette: colors });
  await writeSdTheme('waterfall-grotto.png', packed.image);
  const parsed = parseThemeImage(packed.image), preview = path.join(root, 'out/previews/cycling');
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(path.join(preview, 'waterfall-grotto.png'), encodePng(renderTheme(parsed, { time: 0 })));
  console.log(`Waterfall Grotto: ${ranges.length} ranges, ${colors.length - fixedStart} fixed colors; `
    + `${fall.length}px falls, ${pool.length}px pool, ${mist.length}px mist`);
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildWaterfall();
