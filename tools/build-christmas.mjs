#!/usr/bin/env node
// Christmas Tree: twinkling tree lights, a burning hearth and its flickering
// firelight, by palette cycling.
//
// Sources (see the .prompt files):
//   christmas-tree-base.jpg      the raw painting with five stockings and a
//                                plain landscape over the mantel; the base.
//   christmas-tree-nolights.jpg  the base with the tree's lights and star off.
//                                Base minus this is each bulb's light.
//   christmas-tree-noflame.jpg   the base with the hearth's flames removed.
//   christmas-tree-fireout.jpg   the base with the fire and candles out. Base
//                                minus this is the firelight on the room.
// The hearth burns the generated flame animation from Campfire Woods
// (campfire-woods-flame-sheet.jpg), compiled as for the campfire.
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
import { ditherTo } from './build-lava.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'assets/cycling-sources');
const W = 640, H = 480, REVERSE = 1, BLEND = 2;
// Hearth: the flame's base (bottom center) and height, the box where the
// flame-free edit replaces the painting, and the flame's ranges and frame time.
const FLAME = [70, 318, 76], FLAME_BOX = [18, 226, 124, 330], FLAME_CLUSTERS = 4, FLAME_TICKS = 8;
// Flames stay below FLAME_CEILING (clear of the stockings), fading out over the rows above it.
const FLAME_CEILING = 248, CEILING_FADE = 14;
// The flame's base fades out over this many rows, so it rises from inside the logs.
const FLAME_FADE = 22;
// Tree: the box holding it, how bright a bulb's core is, ranges, and the
// twinkle, a smooth fade. Bulbs light in a wave spiralling up the tree, with
// alternate bulbs half a cycle apart, like two strands trading off. The star
// (above STAR_BELOW) stays lit; glow reaches GLOW_REACH pixels from a bulb.
const TREE_BOX = [182, 8, 462, 372], BULB_CORE = 50, TREE_CLUSTERS = 7, TREE_TICKS = 10;
const TWINKLE = Array.from({ length: 12 }, (_, j) => 0.3 + 0.7 * (0.5 + 0.5 * Math.cos(2 * Math.PI * j / 12)));
const STAR_BELOW = 44, GLOW_REACH = 5, TREE_CENTER = 321, SPIRAL_TURNS = 3;
// Firelight on the room, with the candles: ranges and an irregular flicker.
const GLOW_CLUSTERS = 5, GLOW_TICKS = 9, FLICKER = [1, 0.8, 0.94, 0.72, 1.1, 0.84, 0.98, 1.05];

const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const frac = v => v - Math.floor(v);
const hash = (a, b = 0) => frac(Math.sin(a * 12.9898 + b * 78.233 + 4.1) * 43758.5453);
const inside = ([x0, y0, x1, y1], p) => { const x = p % W, y = (p / W) | 0; return x >= x0 && x < x1 && y >= y0 && y < y1; };

/** Light clusters dithered to the painting: each range is plate + light * curve(j). */
function lightRanges(pixels, plateOf, lightOf, imageOf, count, curve, addRange, ticks) {
  // Clusters of the painting's own colors; each holds its members' average plate and light.
  const tones = kmeansVectors(pixels.filter((_, i) => i % 3 === 0).map(imageOf), count);
  const near = c => { let k = 0, best = Infinity; tones.forEach((t, j) => { const d = (t[0] - c[0]) ** 2 + (t[1] - c[1]) ** 2 + (t[2] - c[2]) ** 2; if (d < best) { best = d; k = j; } }); return k; };
  const sums = tones.map(() => new Float64Array(7));
  for (const p of pixels) {
    const s = sums[near(imageOf(p))], b = plateOf(p), l = lightOf(p);
    for (let i = 0; i < 3; i++) { s[i] += b[i]; s[3 + i] += l[i]; }
    s[6]++;
  }
  const centers = sums.map(s => [[0, 1, 2].map(i => s[i] / Math.max(1, s[6])), [3, 4, 5].map(i => s[i] / Math.max(1, s[6]))]);
  const mean = curve.reduce((a, b) => a + b) / curve.length;
  const starts = centers.map(([base, glow]) => addRange(curve.map(f => base.map((v, i) => v + glow[i] * f)), ticks));
  const chosen = ditherTo(pixels, centers.map(([base, glow]) => base.map((v, i) => v + glow[i] * mean)), imageOf);
  return p => starts[chosen.get(p)];
}

export async function buildChristmas() {
  const read = async name => cover(decodePlate(new Uint8Array(await fs.readFile(path.join(sources, name)))), W, H);
  const [image, nolights, noflame, fireout] = await Promise.all(['base', 'nolights', 'noflame', 'fireout'].map(n => read(`christmas-tree-${n}.jpg`)));
  const sheet = decodePlate(new Uint8Array(await fs.readFile(path.join(sources, 'campfire-woods-flame-sheet.jpg'))));
  const at = (img, p) => [img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]];
  const colors = [], ranges = [], index = new Int16Array(W * H).fill(-1);
  const addRange = (entries, stepTicks, flags = BLEND) => {
    const start = colors.length;
    for (const c of entries) colors.push(consoleColor(c));
    ranges.push({ start, length: entries.length, stepTicks, flags });
    return start;
  };

  // ---- hearth flames ----
  const [x0, y0, x1, y1] = FLAME_BOX;
  // The flame-free edit inside the box, feathered into the painting at its edges.
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const w = Math.min(1, (x - x0) / 8, (x1 - 1 - x) / 8, (y - y0) / 8, (y1 - 1 - y) / 8);
    for (let i = 0; i < 3; i++) { const q = (y * W + x) * 4 + i; image.data[q] = image.data[q] * (1 - w) + noflame.data[q] * w; }
  }
  const cell = sheet.width / 4, cells = [0, 2, 4, 6, 8, 10, 12, 14].map(i =>
    cropImage(sheet, [Math.round((i % 4) * cell), Math.round(Math.floor(i / 4) * cell), Math.round(cell), Math.round(cell)]));
  let top = cell, bottom = 0, left = cell, right = 0;
  for (const c of cells) for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++)
    if (Math.max(...at(c, y * c.width + x)) > 40) { top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x); }
  const [fx, fy, fh] = FLAME, scale = fh / (bottom - top), size = Math.round(cell * scale);
  const ox = fx - Math.round((left + right) / 2 * scale), oy = fy - Math.round(bottom * scale);
  const frames = cells.map(c => {
    const sprite = resizeImage(c, size, size), f = { width: W, height: H, data: new Uint8ClampedArray(image.data) };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const X = x + ox, Y = y + oy;
      if (X < x0 || Y < y0 || X >= x1 || Y >= y1) continue;
      const p = (Y * W + X) * 4, q = (y * size + x) * 4, a = Math.max(0, Math.min(1, (Math.round(bottom * scale) - y) / FLAME_FADE, (Y - FLAME_CEILING) / CEILING_FADE));
      for (let i = 0; i < 3; i++) f.data[p + i] = 255 - (255 - f.data[p + i]) * (255 - a * sprite.data[q + i]) / 255;
    }
    return f;
  });
  const n = frames.length, flame = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = y * W + x, ls = frames.map(f => luma(at(f, p)));
    if (Math.max(...ls) - Math.min(...ls) > 12) flame.push(p);
  }
  const fit = shiftKmeans(flame.map(p => frames.flatMap(f => at(f, p))), FLAME_CLUSTERS, n);
  // A reversed range shows index i the entry i + step: start + shift plays prototype[(t + shift) % n].
  const flameStarts = fit.protos.map(proto => addRange(Array.from({ length: n }, (_, t) => proto.slice(t * 3, t * 3 + 3)), FLAME_TICKS, REVERSE | BLEND));
  flame.forEach((p, i) => { index[p] = flameStarts[fit.assigned[i].cluster] + fit.assigned[i].shift; });

  // ---- tree lights ----
  // Each bulb core is one light; the glow around it takes the nearest core's
  // offset (found by a breadth-first fill outward from the cores).
  const bulbLight = p => { const a = at(image, p), b = at(nolights, p); return a.map((v, i) => v - b[i]); };
  const owner = new Int32Array(W * H).fill(-1), reach = new Int16Array(W * H), queue = [], centers = [];
  let bulbs = 0;
  for (let p = 0; p < W * H; p++) {
    if (!inside(TREE_BOX, p) || owner[p] >= 0 || luma(bulbLight(p)) < BULB_CORE) continue;
    const stack = [p], members = []; owner[p] = bulbs;
    while (stack.length) {
      const q = stack.pop(); members.push(q);
      for (const d of [1, -1, W, -W]) { const r = q + d; if (inside(TREE_BOX, r) && owner[r] < 0 && luma(bulbLight(r)) >= BULB_CORE) { owner[r] = bulbs; stack.push(r); } }
    }
    queue.push(...members);
    centers.push([members.reduce((a, q) => a + q % W, 0) / members.length, members.reduce((a, q) => a + ((q / W) | 0), 0) / members.length]);
    bulbs++;
  }
  for (let i = 0; i < queue.length; i++) {
    const q = queue[i];
    if (reach[q] >= GLOW_REACH) continue;
    for (const d of [1, -1, W, -W]) { const r = q + d; if (inside(TREE_BOX, r) && owner[r] < 0) { owner[r] = owner[q]; reach[r] = reach[q] + 1; queue.push(r); } }
  }
  // A bulb's offset: its place on a garland spiralling up the tree (height
  // plus the turn around the trunk the cone's width implies), and alternate
  // bulbs along it on opposite strands.
  const offset = centers.map(([x, y], b) => {
    const halfWidth = Math.max(8, (y - TREE_BOX[1]) * 0.36), around = Math.asin(Math.max(-1, Math.min(1, (x - TREE_CENTER) / halfWidth))) / Math.PI;
    const along = SPIRAL_TURNS * (1 - y / TREE_BOX[3]) + 0.5 * around;
    return frac(along + (hash(b, 3) < 0.5 ? 0.5 : 0));
  });
  const treePixels = [];
  for (let p = 0; p < W * H; p++)
    if (index[p] < 0 && inside(TREE_BOX, p) && owner[p] >= 0 && centers[owner[p]][1] >= STAR_BELOW && luma(bulbLight(p)) > 10) treePixels.push(p);
  const treeStart = lightRanges(treePixels, p => at(nolights, p), bulbLight, p => at(image, p), TREE_CLUSTERS, TWINKLE, addRange, TREE_TICKS);
  for (const p of treePixels) index[p] = treeStart(p) + Math.floor(offset[owner[p]] * TWINKLE.length) % TWINKLE.length;

  // ---- firelight and candles ----
  const fireLight = p => { const a = at(image, p), b = at(fireout, p); return a.map((v, i) => v - b[i]); };
  const lit = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0) { const l = fireLight(p); if (luma(l) > 16 && l[0] > l[2]) lit.push(p); }
  const glowStart = lightRanges(lit, p => at(fireout, p), fireLight, p => at(image, p), GLOW_CLUSTERS, FLICKER, addRange, GLOW_TICKS);
  for (const p of lit) index[p] = glowStart(p);

  // ---- everything else ----
  const fixedStart = colors.length, fixed = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0) fixed.push(at(image, p));
  for (const c of kmeans(fixed, 256 - fixedStart)) colors.push(consoleColor(c));
  const indices = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++)
    indices[p] = index[p] >= 0 ? index[p] : nearestIndex(colors, fixedStart, colors.length - fixedStart, at(image, p));
  const theme = {
    name: 'Christmas Tree', family: 'Cycling', colors: interfaceColors(image),
    background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges },
    border: { source: 'internal', id: 8 },
  };
  const packed = packThemeImage(theme, { staticBackground: indexImage(W, H, indices), staticPalette: colors });
  await writeSdTheme('christmas-tree.png', packed.image);
  const parsed = parseThemeImage(packed.image), preview = path.join(root, 'out/previews/cycling');
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(path.join(preview, 'christmas-tree.png'), encodePng(renderTheme(parsed, { time: 0 })));
  console.log(`Christmas Tree: ${ranges.length} ranges, ${colors.length - fixedStart} fixed colors; ${flame.length}px flame (rms ${fit.error.toFixed(1)}), `
    + `${bulbs} bulbs over ${treePixels.length}px, ${lit.length}px firelight`);
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildChristmas();
