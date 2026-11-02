#!/usr/bin/env node
// Campfire Woods: a generated flame animation, compiled into palette cycles.
//
// The flames: campfire-woods-flame-sheet.jpg is 16 consecutive frames of a
// looping flame on black (every other one is used), generated as one sprite sheet so that neighbouring
// frames follow on from each other. Each frame is scaled to the painted fire
// and screen-blended over campfire-woods-noflame.jpg, the painting with the
// flames removed but the logs, embers and firelight kept. Every flame
// pixel's sequence of 8 colors is matched to one of a few prototype
// sequences at some offset in time (shift-invariant k-means), each prototype
// a cycling range; rising flames are close to time-shifted copies of each
// other, which is what palette cycling reproduces well.
//
// The firelight: campfire-woods-plate.jpg is the painting with the fire out,
// so painting minus plate is the light the fire casts. Lit pixels are drawn
// as plate + light * flicker, clustered and dithered as for the aurora.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'assets/cycling-sources');
const W = 640, H = 480, REVERSE = 1, BLEND = 2;
// Flames: prototypes, frame time, and the box (640x480 pixels) they live in.
const FLAME_CLUSTERS = 11, FLAME_TICKS = 8, FLAME_BOX = [215, 190, 430, 440];
// Where the sprite goes: its flames' bottom center, and the scale from sheet cells.
const FLAME_BASE = [324, 392], FLAME_SCALE = 0.49, FLAME_FADE = 40;
// The log pile (rows below PILE_TOP, feathered) keeps the painting's own fire.
const PILE_TOP = 338, PILE_FEATHER = 16;
// Firelight: clusters and an irregular flicker, in units of full light.
const GLOW_CLUSTERS = 5, GLOW_TICKS = 24, FLICKER = [1.0, 0.68, 0.9, 0.6, 1.14, 0.55, 0.84, 1.06];
const GLOW_MEAN = FLICKER.reduce((a, b) => a + b) / FLICKER.length;
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Shift-invariant k-means: sequences of `n` RGB colors, each matched to a
 * prototype at its best cyclic offset. Returns prototypes and, per sequence,
 * { cluster, shift } such that sequence[t] ~ prototype[(t + shift) % n].
 */
export function shiftKmeans(sequences, k, n, iterations = 12) {
  const dist = (seq, proto, s) => {
    let d = 0;
    for (let t = 0; t < n; t++) for (let c = 0; c < 3; c++) d += (seq[t * 3 + c] - proto[((t + s) % n) * 3 + c]) ** 2;
    return d;
  };
  const assign = (seq, protos) => {
    let best = { cluster: 0, shift: 0 }, bd = Infinity;
    protos.forEach((p, j) => { for (let s = 0; s < n; s++) { const d = dist(seq, p, s); if (d < bd) { bd = d; best = { cluster: j, shift: s }; } } });
    return best;
  };
  // k-means++ seeds (deterministic), drawn from a subsample.
  let seed = 11;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const sample = sequences.filter((_, i) => i % 4 === 0);
  const protos = [sample[Math.floor(rand() * sample.length)].slice()];
  const nearest = sample.map(q => dist(q, protos[0], 0));
  while (protos.length < k) {
    let r = rand() * nearest.reduce((a, b) => a + b), pick = 0;
    for (; pick < sample.length - 1; pick++) { r -= nearest[pick]; if (r <= 0) break; }
    protos.push(sample[pick].slice());
    sample.forEach((q, i) => { const { cluster, shift } = assign(q, [protos.at(-1)]); nearest[i] = Math.min(nearest[i], dist(q, protos.at(-1), shift)); });
  }
  let assigned;
  for (let it = 0; it < iterations; it++) {
    assigned = sequences.map(seq => assign(seq, protos));
    const sums = protos.map(() => new Float64Array(n * 3 + 1));
    sequences.forEach((seq, i) => {
      const { cluster, shift } = assigned[i], s = sums[cluster];
      for (let t = 0; t < n; t++) for (let c = 0; c < 3; c++) s[((t + shift) % n) * 3 + c] += seq[t * 3 + c];
      s[n * 3]++;
    });
    sums.forEach((s, j) => { if (s[n * 3]) protos[j] = Array.from(s.subarray(0, n * 3), v => v / s[n * 3]); });
  }
  const error = Math.sqrt(sequences.reduce((e, q, i) => e + dist(q, protos[assigned[i].cluster], assigned[i].shift), 0) / (sequences.length * n * 3));
  return { protos, assigned, error };
}

export async function buildCampfire() {
  const read = async name => decodePlate(new Uint8Array(await fs.readFile(path.join(sources, name))));
  const [raw, plateRaw, noflameRaw, sheet] = await Promise.all(['campfire-woods-raw.jpg', 'campfire-woods-plate.jpg',
    'campfire-woods-noflame.jpg', 'campfire-woods-flame-sheet.jpg'].map(read));
  const plate = cover(plateRaw, W, H), noflame = cover(noflameRaw, W, H);
  // The painting, with the flame-free edit inside the flame box above the
  // log pile; the pile keeps the painting's fire burning between the logs.
  const image = cover(raw, W, H), painted = cover(raw, W, H), [x0, y0, x1, y1] = FLAME_BOX;
  for (let y = y0; y < y1; y++) {
    const keep = Math.max(0, Math.min(1, (y - PILE_TOP) / PILE_FEATHER));
    for (let x = x0; x < x1; x++) for (let i = 0; i < 3; i++) {
      const p = (y * W + x) * 4 + i;
      image.data[p] = noflame.data[p] * (1 - keep) + painted.data[p] * keep;
    }
  }
  const at = (img, p) => [img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]];
  const colors = [], ranges = [], index = new Int16Array(W * H).fill(-1);

  // ---- flames ----
  // Every other frame of the 16; blending between entries fills in the rest.
  const cell = sheet.width / 4, cells = Array.from({ length: 8 }, (_, k) => 2 * k).map(i =>
    resizeImage(cropImage(sheet, [Math.round((i % 4) * cell), Math.round(Math.floor(i / 4) * cell), Math.round(cell), Math.round(cell)]),
      Math.round(cell * FLAME_SCALE), Math.round(cell * FLAME_SCALE)));
  // The sprite's flames span the union of lit pixels over all frames.
  const size = cells[0].width;
  let left = size, right = 0, bottom = 0;
  for (const c of cells) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
    if (Math.max(...at(c, y * size + x)) > 40) { left = Math.min(left, x); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  const ox = FLAME_BASE[0] - Math.round((left + right) / 2), oy = FLAME_BASE[1] - bottom;
  const frames = cells.map(c => {
    const f = { width: W, height: H, data: new Uint8ClampedArray(image.data) };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const X = x + ox, Y = y + oy;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      // The flat base fades out, so flames rise from inside the log pile.
      const p = (Y * W + X) * 4, q = (y * size + x) * 4, a = Math.min(1, (bottom - y) / FLAME_FADE);
      for (let i = 0; i < 3; i++) f.data[p + i] = 255 - (255 - f.data[p + i]) * (255 - a * c.data[q + i]) / 255;
    }
    return f;
  });
  const n = frames.length, flame = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = y * W + x, ls = frames.map(f => luma(...at(f, p)));
    if (Math.max(...ls) - Math.min(...ls) > 12) flame.push(p);
  }
  const sequences = flame.map(p => frames.flatMap(f => at(f, p)));
  const { protos, assigned, error: flameError } = shiftKmeans(sequences, FLAME_CLUSTERS, n);
  // Entry j holds prototype color j. A reversed range shows a pixel of index
  // i the entry i + step, so index start + shift plays prototype[(t + shift) % n].
  const flameStarts = protos.map(proto => {
    const start = colors.length;
    for (let t = 0; t < n; t++) colors.push(consoleColor(proto.slice(t * 3, t * 3 + 3)));
    ranges.push({ start, length: n, stepTicks: FLAME_TICKS, flags: REVERSE | BLEND });
    return start;
  });
  flame.forEach((p, i) => { index[p] = flameStarts[assigned[i].cluster] + assigned[i].shift; });

  // ---- firelight ----
  const light = p => { const a = at(image, p), b = at(plate, p); return a.map((v, i) => v - b[i]); };
  // Only well-lit pixels flicker; faint glow stays fixed.
  const lit = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0 && luma(...light(p)) > 20) { const [r, , b] = light(p); if (r > b) lit.push(p); }
  // Cluster the painting's own colors, so the still image keeps them; each
  // cluster's plate and light are its members' averages.
  const tones = kmeansVectors(lit.filter((_, i) => i % 3 === 0).map(p => at(image, p)), GLOW_CLUSTERS);
  const nearestTone = c => { let best = 0, bd = Infinity; tones.forEach((t, j) => { const d = (t[0] - c[0]) ** 2 + (t[1] - c[1]) ** 2 + (t[2] - c[2]) ** 2; if (d < bd) { bd = d; best = j; } }); return best; };
  const sums = tones.map(() => new Float64Array(7));
  for (const p of lit) {
    const s = sums[nearestTone(at(image, p))], b = at(plate, p), l = light(p);
    for (let i = 0; i < 3; i++) { s[i] += b[i]; s[3 + i] += l[i]; }
    s[6]++;
  }
  const centers = sums.map(s => [[0, 1, 2].map(i => s[i] / s[6]), [3, 4, 5].map(i => s[i] / s[6])]);
  const glowStarts = centers.map(([base, glow]) => {
    const start = colors.length;
    for (const f of FLICKER) colors.push(consoleColor(base.map((v, i) => v + glow[i] * f)));
    ranges.push({ start, length: FLICKER.length, stepTicks: GLOW_TICKS, flags: BLEND });
    return start;
  });
  const still = centers.map(([base, glow]) => base.map((v, i) => v + glow[i] * GLOW_MEAN));
  const inSet = new Uint8Array(W * H), error = new Float32Array(W * H * 3);
  for (const p of lit) inSet[p] = 1;
  for (const p of lit) {
    const x = p % W, y = (p / W) | 0, want = at(image, p).map((v, i) => v + error[p * 3 + i]);
    let best = 0, bd = Infinity;
    still.forEach((c, j) => { const d = (c[0] - want[0]) ** 2 + (c[1] - want[1]) ** 2 + (c[2] - want[2]) ** 2; if (d < bd) { bd = d; best = j; } });
    for (const [dx, dy, w] of [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]) {
      const nx = x + dx, ny = y + dy, q = ny * W + nx;
      if (nx < 0 || nx >= W || ny >= H || !inSet[q]) continue;
      for (let i = 0; i < 3; i++) error[q * 3 + i] += (want[i] - still[best][i]) * w * 0.8;
    }
    index[p] = glowStarts[best];
  }

  // ---- everything else ----
  const fixedStart = colors.length, fixed = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0) fixed.push(at(image, p));
  for (const c of kmeans(fixed, 256 - fixedStart)) colors.push(consoleColor(c));
  const indices = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++)
    indices[p] = index[p] >= 0 ? index[p] : nearestIndex(colors, fixedStart, colors.length - fixedStart, at(image, p));
  const theme = {
    name: 'Campfire Woods', family: 'Cycling', colors: interfaceColors(image),
    background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges },
    border: { source: 'internal', id: 8 },
  };
  const packed = packThemeImage(theme, { staticBackground: indexImage(W, H, indices), staticPalette: colors });
  await writeSdTheme('campfire-woods.png', packed.image);
  const parsed = parseThemeImage(packed.image), preview = path.join(root, 'out/previews/cycling');
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(path.join(preview, 'campfire-woods.png'), encodePng(renderTheme(parsed, { time: 0 })));
  console.log(`Campfire Woods: ${ranges.length} ranges, ${colors.length - fixedStart} fixed colors; ${flame.length}px flame (rms ${flameError.toFixed(1)}), ${lit.length}px firelight`);
  return { parsed, frames };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildCampfire();
