#!/usr/bin/env node
// Caustic Pool: simulated caustic light dappling the pool floor.
//
// caustic-pool-plate.jpg, the raw painting with its caustic web removed, is
// the floor: evenly lit sand, with the simulated light laid over all of it.
// caustic-pool-depth.png, a generated depth map, gives the water depth the
// light passes through, and dims the light in deep water.
//
// The light comes from a simulation. A looping water surface (waves with
// whole numbers of cycles per loop) refracts sunlight onto the floor: each
// surface point's ray lands displaced along the surface slope by an amount
// that grows with the water depth there, and where rays bunch up the floor
// is bright. So the dapples' size and focus follow the depth map, and on
// raised rocks the pattern shifts and sharpens.
//
// Each lit pixel's FRAMES-long light sequence is fitted to one of a few
// shared sequences at its own offset in time (shift-invariant k-means);
// each pairing of a shared sequence with a floor tone is one cycling range,
// and the floor tones are dithered.
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
const W = 640, H = 480, REVERSE = 1, BLEND = 2;
// The simulated surface: waves as (direction in turns, wavelength in floor
// pixels, cycles per loop, amplitude), a mostly one-way swell with some cross
// chop; the loop's frames; and how far a unit of slope displaces a ray per
// unit of water depth.
const WAVES = [[0.08, 150, 1, 0.8], [0.19, 113, 2, 0.55], [-0.04, 88, 2, 0.45], [0.33, 71, 3, 0.32], [-0.17, 61, 3, 0.3],
  [0.47, 53, 4, 0.22], [0.71, 47, 3, 0.18], [-0.29, 41, 4, 0.16], [0.6, 34, 5, 0.12]];
const FRAMES = 12, DISPLACE = 26000, SUPERSAMPLE = 2;
// The floor recedes upward: wavelengths scale from TOP_SCALE at the top row to 1 at the bottom.
const TOP_SCALE = 0.55;
// Shared light sequences, floor tones (SEQUENCES * TONES ranges), and time per frame.
const SEQUENCES = 3, TONES = 5, TICKS = 16;
// Pixels whose floor color is further than this from every tone stay fixed.
const TONE_MATCH = 64;
// The caustic light's color and gain; light is dimmed to SHADE in the deepest water.
const LIGHT = [255, 236, 190], GAIN = 0.55, SHADE = 0.45;

const frac = v => v - Math.floor(v);
const hash = (a, b = 0) => frac(Math.sin(a * 12.9898 + b * 78.233 + 4.1) * 43758.5453);
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
/** Box blur of a per-pixel float field, radius r (separable, two passes). */
export function blurField(field, r) { return blur(field, r); }
function blur(field, r) {
  const out = new Float32Array(field.length), tmp = new Float32Array(field.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0; for (let d = -r; d <= r; d++) { const X = x + d; if (X >= 0 && X < W) { s += field[y * W + X]; n++; } } tmp[y * W + x] = s / n;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0; for (let d = -r; d <= r; d++) { const Y = y + d; if (Y >= 0 && Y < H) { s += tmp[Y * W + x]; n++; } } out[y * W + x] = s / n;
  }
  return out;
}

/** Floor coordinates of screen pixel (x, y): foreshortened toward the top. */
function floorAt(x, y) {
  const scale = TOP_SCALE + (1 - TOP_SCALE) * y / H;
  // Rows integrated, so floor distance per row shrinks smoothly upward.
  const v = H / (1 - TOP_SCALE) * Math.log(scale / TOP_SCALE);
  return [(x - W / 2) / scale, v];
}

/** The light reaching each screen pixel at loop time t (0..1), normalized to mean 1. */
export function simulate(t, depth) {
  const accum = new Float32Array(W * H), waves = WAVES.map(([turn, length, cycles, amplitude]) => {
    const k = 2 * Math.PI / length;
    return { kx: k * Math.cos(2 * Math.PI * turn), ky: k * Math.sin(2 * Math.PI * turn), phase: 2 * Math.PI * cycles * t, amplitude: amplitude * length / 150 };
  });
  // Rays start beyond the frame too, so light still lands at its edges.
  const step = 1 / SUPERSAMPLE, margin = 48;
  for (let sy = -margin; sy < H + margin; sy += step) for (let sx = -margin; sx < W + margin; sx += step) {
    const [u, v] = floorAt(sx, sy), scale = TOP_SCALE + (1 - TOP_SCALE) * sy / H;
    // Surface slope in floor units.
    let gx = 0, gy = 0;
    for (const w of waves) { const s = -Math.sin(w.kx * u + w.ky * v - w.phase) * w.amplitude; gx += s * w.kx; gy += s * w.ky; }
    const d = depth[Math.max(0, Math.min(H - 1, Math.round(sy))) * W + Math.max(0, Math.min(W - 1, Math.round(sx)))];
    // Displacement on the floor, back to screen pixels.
    const x = sx + DISPLACE * d * gx * scale / 100, y = sy + DISPLACE * d * gy * scale / 100;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
      const X = x0 + dx, Y = y0 + dy;
      if (X >= 0 && Y >= 0 && X < W && Y < H) accum[Y * W + X] += (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
    }
  }
  const norm = 1 / (SUPERSAMPLE * SUPERSAMPLE);
  for (let p = 0; p < W * H; p++) accum[p] *= norm;
  return accum;
}

/**
 * Shift-invariant k-means on scalar sequences of length n, trained on a
 * subsample: returns prototypes and assign(seq) -> { cluster, shift } with
 * seq[t] ~ prototype[(t + shift) % n].
 */
function shiftFit(sequences, k, n, iterations = 14) {
  const dist = (q, proto, s) => { let d = 0; for (let t = 0; t < n; t++) d += (q[t] - proto[(t + s) % n]) ** 2; return d; };
  const assign = q => {
    let best = { cluster: 0, shift: 0, error: Infinity };
    protos.forEach((proto, j) => { for (let s = 0; s < n; s++) { const d = dist(q, proto, s); if (d < best.error) best = { cluster: j, shift: s, error: d }; } });
    return best;
  };
  const sample = sequences.filter((_, i) => i % 7 === 0);
  let seed = 5;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const protos = [Float64Array.from(sample[Math.floor(rand() * sample.length)])];
  while (protos.length < k) {
    const errors = sample.map(q => assign(q).error), total = errors.reduce((a, b) => a + b);
    let r = rand() * total, pick = 0;
    for (; pick < sample.length - 1; pick++) { r -= errors[pick]; if (r <= 0) break; }
    protos.push(Float64Array.from(sample[pick]));
  }
  for (let it = 0; it < iterations; it++) {
    const sums = protos.map(() => new Float64Array(n + 1));
    for (const q of sample) {
      const { cluster, shift } = assign(q);
      for (let t = 0; t < n; t++) sums[cluster][(t + shift) % n] += q[t];
      sums[cluster][n]++;
    }
    sums.forEach((s, j) => { if (s[n]) protos[j] = Float64Array.from(s.subarray(0, n), v => v / s[n]); });
  }
  return { protos, assign, n };
}

export async function buildCaustics() {
  const read = async name => cover(decodePlate(new Uint8Array(await fs.readFile(path.join(sources, name)))), W, H);
  const [image, plate, depthMap] = await Promise.all(['caustic-pool-raw.jpg', 'caustic-pool-plate.jpg', 'caustic-pool-depth.png'].map(read));
  const at = (img, p) => [img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]];
  const near = Float32Array.from({ length: W * H }, (_, p) => luma(at(depthMap, p)) / 255);
  const floor = blur(blur(near, 24), 24);
  let lo = 1, hi = 0; for (const v of floor) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const deep = p => 1 - (floor[p] - lo) / (hi - lo), height = p => Math.max(0, near[p] - floor[p]);
  // The floor is the plate as painted: evenly lit sand, with the light laid
  // over it everywhere, dimmed only by depth (the painting's own web is not
  // used, so no patch of floor is left dark or unlit).
  const base = p => at(plate, p);
  const strength = p => GAIN * (1 - (1 - SHADE) * deep(p));
  // Water depth over each pixel: the deep floor is far, raised surfaces near.
  // Smoothed, so object outlines do not print as lines in the light.
  const depth = blur(Float32Array.from({ length: W * H }, (_, p) => 0.25 + 0.75 * (1 - near[p])), 5);
  const frames = Array.from({ length: FRAMES }, (_, f) => simulate(f / FRAMES, depth));

  const colors = [], ranges = [], index = new Int16Array(W * H).fill(-1), pixels = [];
  for (let p = 0; p < W * H; p++) if (strength(p) > 0.06) pixels.push(p);
  // Light above the mean; the floor's own tone carries the mean.
  const sequence = p => frames.map(f => Math.min(2.4, Math.max(0, f[p] - 0.55)));
  const tones = kmeansVectors(pixels.filter((_, i) => i % 4 === 0).map(p => [...base(p), strength(p) * 200]), TONES);
  for (let i = pixels.length - 1; i >= 0; i--) {
    const c = base(pixels[i]);
    if (Math.min(...tones.map(t => d2(t, c))) > TONE_MATCH ** 2) pixels.splice(i, 1);
  }
  const fit = shiftFit(pixels.map(sequence), SEQUENCES, FRAMES);
  const meanLight = fit.protos.map(proto => proto.reduce((a, b) => a + b) / FRAMES);
  // Range (sequence s, tone k): entry j is the tone lit by prototype s at step j.
  // A reversed range shows index i the entry i + step, so start + shift plays prototype[(t + shift) % n].
  const starts = [];
  fit.protos.forEach((proto, sIdx) => tones.forEach(t => {
    const start = colors.length, str = t[3] / 200;
    for (let j = 0; j < FRAMES; j++)
      colors.push(consoleColor(t.slice(0, 3).map((v, c) => v + LIGHT[c] * str * (proto[j] - meanLight[sIdx]))));
    ranges.push({ start, length: FRAMES, stepTicks: TICKS, flags: REVERSE | BLEND });
    starts.push(start);
  }));
  let squared = 0;
  // Dither each pixel's floor tone, and its light sequence too: what the
  // chosen shared sequence gets wrong is passed on to the neighbours, so the
  // borders between sequences break up into grain instead of facets. Error
  // stays among lit pixels.
  const inSet = new Uint8Array(W * H), error = new Float32Array(W * H * 3), lightError = new Float32Array(W * H * FRAMES);
  for (const p of pixels) inSet[p] = 1;
  for (const p of pixels) {
    const x = p % W, y = (p / W) | 0, want = base(p).map((v, c) => v + error[p * 3 + c]);
    // Only tones near the pixel's own color are candidates, so dithering
    // never scatters a far tone (dark rock green into blue water) as specks.
    const own = base(p), near = tones.map((t, j) => j).filter(j => d2(tones[j], own) <= TONE_MATCH ** 2);
    let k = near[0] ?? 0, best = Infinity;
    for (const j of near) { const t = tones[j], d = d2(t, want) + 0.5 * (t[3] - strength(p) * 200) ** 2; if (d < best) { best = d; k = j; } }
    for (const [dx, dy, w] of [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]) {
      const q = (y + dy) * W + x + dx;
      if (x + dx < 0 || x + dx >= W || y + dy >= H || !inSet[q]) continue;
      for (let c = 0; c < 3; c++) error[q * 3 + c] += (want[c] - tones[k][c]) * w * 0.8;
    }
    const seq = sequence(p), want2 = seq.map((v, t) => v + lightError[p * FRAMES + t]);
    const { cluster, shift } = fit.assign(want2), proto = fit.protos[cluster];
    for (let t = 0; t < FRAMES; t++) {
      const got = proto[(t + shift) % FRAMES], residual = want2[t] - got;
      squared += (seq[t] - got) ** 2;
      for (const [dx, dy, w] of [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]) {
        const q = (y + dy) * W + x + dx;
        if (x + dx >= 0 && x + dx < W && y + dy < H && inSet[q]) lightError[q * FRAMES + t] += residual * w * 0.75;
      }
    }
    index[p] = starts[cluster * TONES + k] + shift;
  }

  const fixedStart = colors.length, fixed = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0) fixed.push(base(p));
  for (const c of kmeans(fixed, 256 - fixedStart)) colors.push(consoleColor(c));
  const indices = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++)
    indices[p] = index[p] >= 0 ? index[p] : nearestIndex(colors, fixedStart, colors.length - fixedStart, base(p));
  const theme = {
    name: 'Caustic Pool', family: 'Cycling', colors: interfaceColors(image),
    background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges },
    border: { source: 'internal', id: 8 },
  };
  const packed = packThemeImage(theme, { staticBackground: indexImage(W, H, indices), staticPalette: colors });
  await writeSdTheme('caustic-pool.png', packed.image);
  const parsed = parseThemeImage(packed.image), preview = path.join(root, 'out/previews/cycling');
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(path.join(preview, 'caustic-pool.png'), encodePng(renderTheme(parsed, { time: 0 })));
  console.log(`Caustic Pool: ${ranges.length} ranges, ${colors.length - fixedStart} fixed colors; ${pixels.length}px lit (light rms ${Math.sqrt(squared / (pixels.length * FRAMES)).toFixed(2)})`);
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildCaustics();
