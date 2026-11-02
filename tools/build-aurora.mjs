#!/usr/bin/env node
// Aurora Tundra: the aurora's own light, animated by palette cycling.
//
// aurora-tundra-plate.jpg is the painting with the aurora removed, generated
// as an edit of the raw source, so painting minus plate is the light the
// aurora adds. Each aurora pixel is drawn as plate + light * brightness, and
// brightness rolls along the curtains (left to right, with a little per-ray
// jitter so rays shimmer as a wave passes). The sky behind never changes.
// Pixels are clustered by (plate, light) into the 16 cycling ranges, sky and
// reflection separately, and dithered so the still image matches the
// painting.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'assets/cycling-sources');
const W = 640, H = 480, HORIZON = Math.round(0.585 * H);
const ENTRIES = 8, STEP_TICKS = 28, BLEND = 2;
// Brightness of the light through one cycle: a crest at the middle, never dark.
const LOW = 0.55, HIGH = 1.35;
const brightness = u => LOW + (HIGH - LOW) * Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * u), 1.4);
const MEAN = Array.from({ length: ENTRIES }, (_, j) => brightness(j / ENTRIES)).reduce((a, b) => a + b) / ENTRIES;
const frac = v => v - Math.floor(v);
const hash = n => frac(Math.sin(n * 12.9898 + 4.1) * 43758.5453);
/** Cycles along the curtains; a wave crest travels toward increasing phase. */
const phaseAt = (x, y) => x / 230 + 0.12 * hash(Math.floor(x / 2)) + 0.08 * Math.sin(y / 23);

/** Deterministic k-means++ over equal-length vectors. */
export function kmeansVectors(points, k, iterations = 15) {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const d2 = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += (a[i] - b[i]) ** 2; return d; };
  const centers = [points[Math.floor(rand() * points.length)].slice()];
  const nearest = points.map(p => d2(p, centers[0]));
  while (centers.length < k) {
    let r = rand() * nearest.reduce((a, b) => a + b), pick = 0;
    for (; pick < points.length - 1; pick++) { r -= nearest[pick]; if (r <= 0) break; }
    centers.push(points[pick].slice());
    points.forEach((p, i) => { nearest[i] = Math.min(nearest[i], d2(p, centers.at(-1))); });
  }
  for (let it = 0; it < iterations; it++) {
    const sums = centers.map(c => new Float64Array(c.length + 1));
    for (const p of points) {
      let best = 0, bd = Infinity;
      centers.forEach((c, j) => { const d = d2(p, c); if (d < bd) { bd = d; best = j; } });
      p.forEach((v, i) => { sums[best][i] += v; }); sums[best][p.length]++;
    }
    sums.forEach((s, j) => { const n = s[s.length - 1]; if (n) centers[j] = Array.from(s.subarray(0, -1), v => v / n); });
  }
  return centers;
}

export async function buildAurora() {
  const read = async name => cover(decodePlate(new Uint8Array(await fs.readFile(path.join(sources, name)))), W, H);
  const [image, plate] = await Promise.all([read('aurora-tundra-raw.jpg'), read('aurora-tundra-plate.jpg')]);
  const at = (img, p) => [img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]];
  const light = p => { const a = at(image, p), b = at(plate, p); return a.map((v, i) => v - b[i]); };
  // Aurora light is green or violet; star and snow differences between the
  // painting and the plate are neither, and stay fixed.
  const isAurora = p => {
    const [r, g, b] = light(p).map(v => Math.max(0, v));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 14 && (g - 0.6 * Math.max(r, b) > 8 || Math.min(r, b) - 0.7 * g > 8);
  };
  const colors = [], ranges = [], index = new Int16Array(W * H).fill(-1);
  // Light is weighted up in clustering so curtain detail wins over sky gradient.
  const feature = p => [...at(plate, p), ...light(p).map(v => v * 1.5)];
  for (const [inRegion, count] of [[p => p < HORIZON * W, 11], [p => p >= HORIZON * W, 5]]) {
    const pixels = [];
    for (let p = 0; p < W * H; p++) if (inRegion(p) && isAurora(p)) pixels.push(p);
    const centers = kmeansVectors(pixels.filter((_, i) => i % 5 === 0).map(feature), count)
      .map(c => [c.slice(0, 3), c.slice(3).map(v => v / 1.5)]);
    const starts = centers.map(([base, glow]) => {
      const start = colors.length;
      for (let j = 0; j < ENTRIES; j++) colors.push(consoleColor(base.map((v, i) => v + glow[i] * brightness(j / ENTRIES))));
      ranges.push({ start, length: ENTRIES, stepTicks: STEP_TICKS, flags: BLEND });
      return start;
    });
    // Floyd-Steinberg over the region, choosing the cluster whose average
    // color is nearest; error does not leak into fixed pixels.
    const still = centers.map(([base, glow]) => base.map((v, i) => v + glow[i] * MEAN));
    const inSet = new Uint8Array(W * H), error = new Float32Array(W * H * 3);
    for (const p of pixels) inSet[p] = 1;
    for (const p of pixels) {
      const x = p % W, y = (p / W) | 0, want = at(image, p).map((v, i) => v + error[p * 3 + i]);
      let best = 0, bd = Infinity;
      still.forEach((c, j) => { const d = (c[0] - want[0]) ** 2 + (c[1] - want[1]) ** 2 + (c[2] - want[2]) ** 2; if (d < bd) { bd = d; best = j; } });
      for (const [dx, dy, w] of [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]) {
        const nx = x + dx, ny = y + dy, q = ny * W + nx;
        if (nx < 0 || nx >= W || ny >= H || !inSet[q]) continue;
        for (let i = 0; i < 3; i++) error[q * 3 + i] += (want[i] - still[best][i]) * w * 0.8;
      }
      index[p] = starts[best] + Math.floor(frac(phaseAt(x, y)) * ENTRIES) % ENTRIES;
    }
  }
  const fixedStart = colors.length, fixed = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0) fixed.push(at(image, p));
  for (const c of kmeans(fixed, 256 - fixedStart)) colors.push(consoleColor(c));
  const indices = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++)
    indices[p] = index[p] >= 0 ? index[p] : nearestIndex(colors, fixedStart, colors.length - fixedStart, at(image, p));
  const theme = {
    name: 'Aurora Tundra', family: 'Cycling', colors: interfaceColors(image),
    background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges },
    border: { source: 'internal', id: 8 },
  };
  const packed = packThemeImage(theme, { staticBackground: indexImage(W, H, indices), staticPalette: colors });
  await writeSdTheme('aurora-tundra.png', packed.image);
  const parsed = parseThemeImage(packed.image), preview = path.join(root, 'out/previews/cycling');
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(path.join(preview, 'aurora-tundra.png'), encodePng(renderTheme(parsed, { time: 0 })));
  console.log(`Aurora Tundra: ${ranges.length} ranges, ${colors.length - fixedStart} fixed colors; ${index.filter(i => i >= 0).length}px aurora`);
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildAurora();
