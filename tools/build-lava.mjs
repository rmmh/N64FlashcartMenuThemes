#!/usr/bin/env node
// Lava Forge: lava falls, flowing lava, braziers and the light they all cast,
// by palette cycling.
//
// Sources (edits of an original painting, see the .prompt files):
//   lava-forge-straight.jpg  the painting with its banners straightened; the base.
//   lava-forge-cold.jpg      the forge gone cold: no lava glow, no flames. The
//                            base minus this is the light on the stone.
//   lava-forge-notorch.jpg   the base with the brazier and candle flames removed.
// The braziers burn the generated flame animation from Campfire Woods
// (campfire-woods-flame-sheet.jpg), scaled down and started at different
// points of its loop, compiled as for the campfire.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/png-node.mjs';
import { decodePlate } from './decode-plate.mjs';
import { cropImage } from '../src/utils.mjs';
import { resizeImage } from '../src/tile-tools.mjs';
import { cover, kmeans, nearestIndex, indexImage, consoleColor } from '../src/palette-tools.mjs';
import { packThemeImage, parseThemeImage } from '../src/theme.mjs';
import { renderTheme } from '../src/renderer.mjs';
import { interfaceColors } from './build-panoramas.mjs';
import { writeSdTheme } from './theme-output.mjs';
import { kmeansVectors } from './build-aurora.mjs';
import { shiftKmeans } from './build-campfire.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'assets/cycling-sources');
const W = 640, H = 480, REVERSE = 1, BLEND = 2;
// Braziers: flame base (bottom center) and height in pixels, and the frame
// of the 8-frame loop each starts on.
const BRAZIERS = [[50, 208, 25, 0], [595, 206, 25, 3], [200, 227, 17, 5], [440, 227, 17, 6]];
const TORCH_CLUSTERS = 3, TORCH_TICKS = 6;
// Small candles along the balconies: an irregular flicker, each its own phase.
const CANDLE_TICKS = 5, CANDLE_FLICKER = [1, 0.7, 0.9, 0.55, 1.05, 0.8, 0.95, 0.65];
// Lava falls: the two falls' boxes, and streaks running down them.
const FALLS = [[252, 206, 282, 268], [362, 206, 392, 268]];
const FALL_CLUSTERS = 2, FALL_ENTRIES = 12, FALL_TICKS = 3, FALL_WAVELENGTH = 18;
// Floor lava: the floor's vanishing row, glow drifting toward the viewer.
const FLOOR_HORIZON = 245, FLOW_DEPTH = 48, LAVA_CLUSTERS = 6, LAVA_ENTRIES = 8, LAVA_TICKS = 14;
// Lava light on the stone.
const GLOW_CLUSTERS = 4, GLOW_TICKS = 12, GLOW_FLICKER = [1, 0.8, 0.94, 0.74, 1.1, 0.84, 0.98, 1.04];

const frac = v => v - Math.floor(v);
const hash = (a, b = 0) => frac(Math.sin(a * 12.9898 + b * 78.233 + 4.1) * 43758.5453);
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const nearest = (list, c) => { let best = 0, bd = Infinity; list.forEach((v, j) => { const d = d2(v, c); if (d < bd) { bd = d; best = j; } }); return best; };
function hsv([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max ? d / max : 0, max];
}
const dither = (x, y) => hash(x * 0.731 + y * 1.37, y * 0.29 - x * 0.11);
/** Smooth value noise, for turbulence in the lava's flow. */
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, s = t => t * t * (3 - 2 * t);
  const v = (a, b) => hash(a * 0.913 + 17.1, b * 1.271 - 3.3);
  const top = v(xi, yi) + (v(xi + 1, yi) - v(xi, yi)) * s(fx), bottom = v(xi, yi + 1) + (v(xi + 1, yi + 1) - v(xi, yi + 1)) * s(fx);
  return top + (bottom - top) * s(fy);
}

/**
 * Assign `pixels` to the nearest of `still` (the color each range shows on
 * average), diffusing the error to the rest of the set so the region keeps
 * the painting's texture. Returns the chosen cluster per pixel.
 */
export function ditherTo(pixels, still, colorOf) {
  const inSet = new Set(pixels), error = new Map(), chosen = new Map();
  for (const p of pixels) {
    const e = error.get(p) ?? [0, 0, 0], want = colorOf(p).map((v, i) => v + e[i]), k = nearest(still, want);
    chosen.set(p, k);
    for (const [dp, w] of [[1, 7 / 16], [W - 1, 3 / 16], [W, 5 / 16], [W + 1, 1 / 16]]) {
      if (!inSet.has(p + dp)) continue;
      const n = error.get(p + dp) ?? [0, 0, 0];
      error.set(p + dp, n.map((v, i) => v + (want[i] - still[k][i]) * w * 0.8));
    }
  }
  return chosen;
}

export async function buildLava() {
  const read = async name => cover(decodePlate(new Uint8Array(await fs.readFile(path.join(sources, name)))), W, H);
  const [image, cold, notorch] = await Promise.all(['lava-forge-straight.jpg', 'lava-forge-cold.jpg', 'lava-forge-notorch.jpg'].map(read));
  const sheet = decodePlate(new Uint8Array(await fs.readFile(path.join(sources, 'campfire-woods-flame-sheet.jpg'))));
  const at = (img, p) => [img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]];
  const colors = [], ranges = [], index = new Int16Array(W * H).fill(-1);
  const addRange = (entries, stepTicks, flags = BLEND) => {
    const start = colors.length;
    for (const c of entries) colors.push(consoleColor(c));
    ranges.push({ start, length: entries.length, stepTicks, flags });
    return start;
  };

  // ---- braziers ----
  // Inside each brazier's box the scene is the flame-free edit, and the
  // flame frames are screen-blended over it.
  const cell = sheet.width / 4, cells = [0, 2, 4, 6, 8, 10, 12, 14].map(i =>
    cropImage(sheet, [Math.round((i % 4) * cell), Math.round(Math.floor(i / 4) * cell), Math.round(cell), Math.round(cell)]));
  let top = cell, bottom = 0, left = cell, right = 0;
  for (const c of cells) for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++)
    if (Math.max(...at(c, y * c.width + x)) > 40) { top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x); }
  const boxes = BRAZIERS.map(([x, y, h]) => [x - h, y - Math.round(h * 1.5), x + h, y + 3]);
  for (const [x0, y0, x1, y1] of boxes) for (let y = y0; y < y1; y++)
    image.data.set(notorch.data.subarray((y * W + x0) * 4, (y * W + x1) * 4), (y * W + x0) * 4);
  const n = cells.length;
  const frames = Array.from({ length: n }, (_, t) => {
    const f = { width: W, height: H, data: new Uint8ClampedArray(image.data) };
    BRAZIERS.forEach(([bx, by, h, offset]) => {
      const scale = h / (bottom - top), size = Math.max(4, Math.round(cell * scale));
      const sprite = resizeImage(cells[(t + offset) % n], size, size);
      const ox = bx - Math.round((left + right) / 2 * scale), oy = by - Math.round(bottom * scale);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const X = x + ox, Y = y + oy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const p = (Y * W + X) * 4, q = (y * size + x) * 4;
        for (let i = 0; i < 3; i++) f.data[p + i] = 255 - (255 - f.data[p + i]) * (255 - sprite.data[q + i]) / 255;
      }
    });
    return f;
  });
  const flame = [];
  for (const [x0, y0, x1, y1] of boxes) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = y * W + x, ls = frames.map(f => luma(at(f, p)));
    if (Math.max(...ls) - Math.min(...ls) > 12) flame.push(p);
  }
  const fit = shiftKmeans(flame.map(p => frames.flatMap(f => at(f, p))), TORCH_CLUSTERS, n);
  // A reversed range shows index i the entry i + step: start + shift plays prototype[(t + shift) % n].
  const torchStarts = fit.protos.map(proto => addRange(Array.from({ length: n }, (_, t) => proto.slice(t * 3, t * 3 + 3)), TORCH_TICKS, REVERSE | BLEND));
  flame.forEach((p, i) => { index[p] = torchStarts[fit.assigned[i].cluster] + fit.assigned[i].shift; });

  // ---- candles ----
  // The small flames the flame-free edit removed, outside the braziers.
  const candleTone = [255, 196, 96];
  const candleStart = addRange(CANDLE_FLICKER.map(f => candleTone.map(v => v * f)), CANDLE_TICKS);
  for (let y = 120; y < 215; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (index[p] >= 0 || boxes.some(([x0, y0, x1, y1]) => x >= x0 - 2 && x < x1 + 2 && y >= y0 - 2 && y < y1 + 2)) continue;
    const c = at(image, p);
    if (luma(c) - luma(at(notorch, p)) > 45 && luma(c) > 150) index[p] = candleStart + Math.floor(hash(Math.floor(x / 6), Math.floor(y / 6)) * CANDLE_FLICKER.length);
  }

  // ---- lava falls ----
  const fallPixels = [];
  for (const [x0, y0, x1, y1] of FALLS) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = y * W + x, c = at(image, p), [h, s] = hsv(c);
    if (index[p] < 0 && luma(c) > 95 && s > 0.45 && h < 55) fallPixels.push(p);
  }
  const fallTones = kmeans(fallPixels.map(p => at(image, p)), FALL_CLUSTERS);
  // A bright head with a fading tail running down each column, toward pale yellow.
  const fallStarts = fallTones.map(tone => addRange(Array.from({ length: FALL_ENTRIES }, (_, j) => {
    const w = Math.exp(-(FALL_ENTRIES - 1 - j) / 2.5);
    return tone.map((v, i) => v * 0.82 + ([255, 236, 150][i] - v * 0.82) * w * 0.75);
  }), FALL_TICKS));
  for (const p of fallPixels) {
    const x = p % W, y = (p / W) | 0;
    index[p] = fallStarts[nearest(fallTones, at(image, p))] + Math.floor(frac(y / FALL_WAVELENGTH + 0.7 * hash(Math.floor(x / 2), 5)) * FALL_ENTRIES);
  }

  // ---- floor lava ----
  // Bright, saturated lava on the floor; the glow drifts down the channels
  // toward the viewer, its fronts broken up by turbulence in floor space.
  const lavaPixels = [];
  for (let y = FLOOR_HORIZON + 8; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, c = at(image, p), [h, s] = hsv(c);
    if (index[p] < 0 && luma(c) > 70 && s > 0.55 && h < 58) lavaPixels.push(p);
  }
  const wave = u => 0.5 - 0.5 * Math.cos(2 * Math.PI * u);
  const lavaTones = kmeans(lavaPixels.map(p => at(image, p)), LAVA_CLUSTERS);
  const lavaStarts = lavaTones.map(tone => addRange(Array.from({ length: LAVA_ENTRIES }, (_, j) =>
    tone.map(v => v * (0.74 + 0.52 * wave(j / LAVA_ENTRIES)))), LAVA_TICKS));
  const lavaChosen = ditherTo(lavaPixels, lavaTones, p => at(image, p));
  for (const p of lavaPixels) {
    const x = p % W, y = (p / W) | 0, depth = 1 / (y - FLOOR_HORIZON), across = (x - W / 2) * depth;
    const turbulence = noise(across * 9, depth * 260) + 0.5 * noise(across * 21 + 5, depth * 600);
    const phase = -FLOW_DEPTH * depth + 0.55 * turbulence;
    index[p] = lavaStarts[lavaChosen.get(p)] + Math.floor(frac(phase) * LAVA_ENTRIES + dither(x, y)) % LAVA_ENTRIES;
  }

  // ---- lava light on the stone ----
  const light = p => { const a = at(image, p), b = at(cold, p); return a.map((v, i) => v - b[i]); };
  const lit = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0) { const l = light(p); if (luma(l) > 20 && l[0] > l[2]) lit.push(p); }
  const tones = kmeansVectors(lit.filter((_, i) => i % 3 === 0).map(p => at(image, p)), GLOW_CLUSTERS);
  const sums = tones.map(() => new Float64Array(7));
  for (const p of lit) {
    const s = sums[nearest(tones, at(image, p))], b = at(cold, p), l = light(p);
    for (let i = 0; i < 3; i++) { s[i] += b[i]; s[3 + i] += l[i]; }
    s[6]++;
  }
  const centers = sums.map(s => [[0, 1, 2].map(i => s[i] / s[6]), [3, 4, 5].map(i => s[i] / s[6])]);
  const mean = GLOW_FLICKER.reduce((a, b) => a + b) / GLOW_FLICKER.length;
  const glowStarts = centers.map(([base, glow]) => addRange(GLOW_FLICKER.map(f => base.map((v, i) => v + glow[i] * f)), GLOW_TICKS));
  const glowChosen = ditherTo(lit, centers.map(([base, glow]) => base.map((v, i) => v + glow[i] * mean)), p => at(image, p));
  for (const p of lit) index[p] = glowStarts[glowChosen.get(p)];

  // ---- everything else ----
  const fixedStart = colors.length, fixed = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0) fixed.push(at(image, p));
  for (const c of kmeans(fixed, 256 - fixedStart)) colors.push(consoleColor(c));
  const indices = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++)
    indices[p] = index[p] >= 0 ? index[p] : nearestIndex(colors, fixedStart, colors.length - fixedStart, at(image, p));
  const theme = {
    name: 'Lava Forge', family: 'Cycling', colors: interfaceColors(image),
    background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges },
    border: { source: 'internal', id: 8 },
  };
  const packed = packThemeImage(theme, { staticBackground: indexImage(W, H, indices), staticPalette: colors });
  await writeSdTheme('lava-forge.png', packed.image);
  const parsed = parseThemeImage(packed.image), preview = path.join(root, 'out/previews/cycling');
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(path.join(preview, 'lava-forge.png'), encodePng(renderTheme(parsed, { time: 0 })));
  console.log(`Lava Forge: ${ranges.length} ranges, ${colors.length - fixedStart} fixed colors; ${flame.length}px flame (rms ${fit.error.toFixed(1)}), `
    + `${fallPixels.length}px falls, ${lavaPixels.length}px lava, ${lit.length}px lava light`);
  return { parsed, frames };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildLava();
