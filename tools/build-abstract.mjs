#!/usr/bin/env node
// Abstract Cycling themes: procedural fields animated only by palette
// cycling. Each theme paints a phase field once; cycling its ranges sends
// colour running through the field. Fractional phases are ordered-dithered
// and ranges blend between steps, so bands move smoothly.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/png-node.mjs';
import { decodePlate } from './decode-plate.mjs';
import { cover, kmeans, nearestIndex, indexImage, consoleColor } from '../src/palette-tools.mjs';
import { packThemeImage, parseThemeImage } from '../src/theme.mjs';
import { renderTheme } from '../src/renderer.mjs';
import { writeSdTheme } from './theme-output.mjs';
import { interfaceColors } from './build-panoramas.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'assets/cycling-sources');
const W = 640, H = 480, BLEND = 2;
const TAU = 2 * Math.PI;

export const frac = v => v - Math.floor(v);
export const hash = (a, b = 0) => frac(Math.sin(a * 12.9898 + b * 78.233 + 4.1) * 43758.5453);
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
export const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
/** A cyclic cosine palette (Inigo Quilez's): a + b cos(2 pi (c t + d)). */
export const cosine = (a, b, c, d) => t => a.map((_, i) => 255 * clamp(a[i] + b[i] * Math.cos(TAU * (c[i] * t + d[i]))));
/** A cyclic palette through the given colour stops, evenly spaced. */
export const loop = stops => t => {
  const u = frac(t) * stops.length, i = Math.floor(u);
  return mix(stops[i], stops[(i + 1) % stops.length], smooth(0, 1, u - i));
};
// An 8x8 Bayer matrix, in [0, 1).
const BAYER = (() => {
  const m = [[0]];
  let b = m;
  for (let n = 1; n < 8; n *= 2) b = [...b.map(r => [...r.map(v => 4 * v), ...r.map(v => 4 * v + 2)]), ...b.map(r => [...r.map(v => 4 * v + 3), ...r.map(v => 4 * v + 1)])];
  return b.map(r => r.map(v => (v + 0.5) / 64));
})();
export const bayer = (x, y) => BAYER[y & 7][x & 7];

/** A palette under construction: colours, cycling ranges, and helpers. */
export function palette() {
  const colors = [], ranges = [];
  return {
    colors, ranges,
    /** A cycling range sampling f(t) for t in [0, 1); returns its start. */
    range(n, f, stepTicks, flags = BLEND) {
      const start = colors.length;
      for (let j = 0; j < n; j++) colors.push(consoleColor(f(j / n, j)));
      ranges.push({ start, length: n, stepTicks, flags });
      return start;
    },
    /** A fixed colour; returns its index. */
    fixed(c) { colors.push(consoleColor(c)); return colors.length - 1; },
  };
}
/** The entry of a range of n at phase `phase` (in loops), dithered at (x, y). */
export const entry = (start, n, phase, x, y) => start + ((Math.floor(frac(phase) * n + bayer(x, y) - 0.5) % n) + n) % n;

/** The image the indices show, at rest. */
const colourize = (colors, indices) => {
  const data = new Uint8ClampedArray(W * H * 4);
  indices.forEach((k, p) => { data.set(colors[k], p * 4); data[p * 4 + 3] = 255; });
  return { width: W, height: H, data };
};

/** Pack, write and preview a theme. */
export async function emit(stem, name, pal, indices) {
  if (pal.colors.length > 256 || pal.ranges.length > 16) throw new Error(`${name}: ${pal.colors.length} colours, ${pal.ranges.length} ranges`);
  const theme = {
    name, family: 'Cycling', colors: interfaceColors(colourize(pal.colors, indices)),
    background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges: pal.ranges },
    border: { source: 'internal', id: 8 },
  };
  const packed = packThemeImage(theme, { staticBackground: indexImage(W, H, indices), staticPalette: pal.colors });
  await writeSdTheme(`${stem}.png`, packed.image);
  const parsed = parseThemeImage(packed.image), preview = path.join(root, 'out/previews/cycling');
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(path.join(preview, `${stem}.png`), encodePng(renderTheme(parsed, { time: 0 })));
  console.log(`${name}: ${pal.ranges.length} ranges, ${pal.colors.length} colours`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Plasma Field: the demoscene plasma. A sum of sines (two drifting centres,
// two diagonal waves) is one phase field; a vivid looping palette runs
// through it, twice over its range.
async function plasma() {
  const pal = palette(), N = 240;
  const colour = loop([[8, 4, 40], [40, 10, 110], [150, 30, 170], [255, 90, 140], [255, 200, 120], [120, 240, 230], [20, 110, 200], [10, 30, 90]]);
  const start = pal.range(N, colour, 2);
  const indices = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = Math.sin(x / 41) + Math.sin(y / 29 + 1.3) + Math.sin((x + y) / 53)
      + Math.sin(Math.hypot(x - 180, y - 150) / 31) + Math.sin(Math.hypot(x - 470, y - 330) / 23);
    indices[y * W + x] = entry(start, N, v / 5 * 1.5, x, y);
  }
  return emit('plasma-field', 'Plasma Field', pal, indices);
}

const BANDS = 5, LACE = 0.3;
// Fractal Bloom: a Julia set (c = -0.8 + 0.156i). Smooth escape counts are
// the phase, so the bands flow out of the set forever; inside is black, and
// its chaotic edge is a fixed deep violet.
async function fractal() {
  const pal = palette(), N = 240;
  const colour = loop([[10, 6, 40], [40, 90, 200], [120, 220, 255], [255, 250, 220], [255, 170, 40], [160, 30, 60]]);
  const start = pal.range(N, colour, 1), inside = pal.fixed([4, 2, 16]), lace = pal.fixed([18, 10, 44]);
  const cr = -0.8, ci = 0.156, span = 3.1, limit = 1500;
  const level = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // The median of four samples, which steadies the chaotic edge of the set.
    const mus = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([u, v]) => {
      let zr = (x + u - W / 2) * span / W, zi = (y + v - H / 2) * span / W, n = 0;
      for (; n < limit && zr * zr + zi * zi < 256; n++) { const t = zr * zr - zi * zi + cr; zi = 2 * zr * zi + ci; zr = t; }
      return n === limit ? Infinity : n + 1 - Math.log(Math.log(Math.hypot(zr, zi))) / Math.LN2;
    }).sort((a, b) => a - b);
    level[y * W + x] = Math.sqrt((mus[1] + mus[2]) / 2);
  }
  const indices = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, l = level[p];
    if (!Number.isFinite(l)) { indices[p] = inside; continue; }
    // Where the count swings from pixel to pixel (the set's chaotic edge),
    // a fixed deep violet instead of noise.
    let swing = 0;
    for (const q of [p - 1, p + 1, p - W, p + W]) if (q >= 0 && q < W * H) swing = Math.max(swing, Number.isFinite(level[q]) ? Math.abs(level[q] - l) : 9);
    if (swing > LACE) { indices[p] = lace; continue; }
    // Bands spaced by the root of the count, so they widen far from the set
    // and stay a few pixels across close in.
    indices[p] = entry(start, N, -l * BANDS, x, y);
  }
  return emit('fractal-bloom', 'Fractal Bloom', pal, indices);
}

// Op Art: rings expand through spiralling spokes, XOR'd into a turning
// polar checkerboard. A pixel on a light spoke shows the rings inverted, so
// two ranges (the rings and their inverse) are all it takes. Not dithered,
// so every edge stays crisp.
async function opArt() {
  const pal = palette(), N = 32, SPOKES = 18, wave = 30, TWIST = 0.9;
  const light = [244, 236, 214], dark = [14, 12, 20], accent = [214, 44, 64];
  // A ring: light for half its wavelength, with a red edge leading it.
  const ring = t => frac(t) < 0.06 ? accent : frac(t) < 0.5 ? light : dark;
  const plain = pal.range(N, t => ring(t), 2, 0), inverse = pal.range(N, t => ring(t + 0.5), 2, 0);
  const indices = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - W / 2, dy = y - H / 2, r = Math.hypot(dx, dy);
    const spoke = frac(Math.atan2(dy, dx) / TAU * SPOKES + TWIST * Math.log(1 + r / 40)) < 0.5;
    indices[y * W + x] = (spoke ? inverse : plain) + Math.floor(frac(-r / wave) * N);
  }
  return emit('op-art', 'Op Art', pal, indices);
}

// Kaleidoscope: a twelve-fold mirrored mandala. Three motif layers, picked by
// a petal pattern, each run their own palette, some outward and some inward,
// with a twist so they turn as they go.
async function kaleidoscope() {
  const pal = palette(), N = 80, FOLD = 12;
  const palettes = [
    loop([[30, 0, 60], [140, 20, 160], [255, 90, 200], [255, 220, 120], [80, 200, 255], [20, 40, 140]]),
    loop([[0, 30, 40], [0, 140, 140], [160, 255, 200], [255, 255, 240], [255, 140, 40], [120, 20, 30]]),
    loop([[20, 10, 0], [200, 120, 20], [255, 230, 140], [60, 160, 255], [10, 30, 90]]),
  ];
  const starts = palettes.map(f => pal.range(N, f, 3));
  const indices = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - W / 2, dy = y - H / 2, r = Math.hypot(dx, dy);
    // The angle folded into one mirrored wedge, 0..1 across it.
    const wedge = frac(Math.atan2(dy, dx) / TAU * FOLD / 2) * 2, m = Math.abs(wedge - 1) < 1 ? 1 - Math.abs(wedge - 1) : 0;
    const petal = r / 70 + 0.45 * Math.cos(TAU * m * 1.5) * smooth(0, 60, r) + 0.25 * Math.sin(r / 23);
    const layer = Math.floor(frac(petal) * 3);
    const dir = layer === 1 ? -1 : 1, phase = dir * (r / 55) + 0.4 * m + 0.15 * Math.cos(TAU * m * 3);
    indices[y * W + x] = entry(starts[layer], N, phase, x, y);
  }
  return emit('kaleidoscope', 'Kaleidoscope', pal, indices);
}

// Wormhole: a spiral of nebula draining into its vanishing point. Log-polar arms carry the colour inward and around, in four
// dithered shades, all the way to the centre, so it never ends.
async function wormhole() {
  const pal = palette(), N = 56, ARMS = 3, WIND = 2.2;
  const nebula = loop([[10, 4, 30], [60, 10, 90], [180, 40, 140], [255, 140, 90], [255, 230, 170], [80, 160, 255], [20, 30, 110]]);
  const shades = [0, 1, 2, 3].map(k => pal.range(N, t => nebula(t).map(v => v * (0.62 + 0.125 * k)), 2));
  const indices = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - W / 2, dy = y - H / 2, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx) / TAU;
    const lr = Math.log(Math.max(r, 0.5) / 26);
    // Spiral coordinate: constant along each arm.
    const spiral = a * ARMS + lr * WIND;
    // Dithered between shades, so the arms have no hard edges.
    const k = clamp(Math.floor(clamp(0.5 + 0.5 * Math.cos(TAU * spiral) + 0.2 * Math.sin(r / 17 + a * TAU * 3)) * 4 + bayer(x, y) - 0.5), 0, 3);
    indices[y * W + x] = entry(shades[k], N, lr * 1.6 - a, x, y);
  }
  return emit('wormhole', 'Wormhole', pal, indices);
}

// Circuit Pulse: the Nintendo 64's main board (a public-domain photograph,
// see circuit-pulse-board.txt), with trains of pulses in the N64 logo's
// colours running along its copper in the order data moves: red out of the
// CPU, blue between the RCP and the RDRAM, green out of the RCP to the rest
// of the board, and yellow out of the other parts. The copper is traced from
// a scan of a bare board into circuit-pulse-route.png: per pixel, the stage and the distance along the
// trace from its source pin, so every pulse leaves a pin.
async function circuit() {
  const pal = palette(), N = 16, TONES = 2, PERIOD = 40;
  const image = cover(decodePlate(new Uint8Array(await fs.readFile(path.join(sources, 'circuit-pulse-board.jpg')))), W, H);
  const route = decodePlate(new Uint8Array(await fs.readFile(path.join(sources, 'circuit-pulse-route.png'))));
  const base = p => [image.data[p * 4], image.data[p * 4 + 1], image.data[p * 4 + 2]];
  const HEADS = [[255, 40, 40], [70, 120, 255], [40, 230, 90], [255, 205, 30]];
  // Each stage starts where the one before it arrives: the RCP's outputs a
  // typical CPU-RCP run after the CPU's, the rest after the RCP's.
  const START = [0, 90, 90, 140];
  const stage = new Int8Array(W * H).fill(-1), phase = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const s = route.data[p * 4] - 1;
    if (s < 0) continue;
    stage[p] = s;
    phase[p] = START[s] + (route.data[p * 4 + 1] * 256 + route.data[p * 4 + 2]) / 16;
  }
  const lit = [];
  for (let p = 0; p < W * H; p++) if (stage[p] >= 0) lit.push(p);
  // A pulse: a bright head with a short tail (tail first, see the snow).
  const PULSE = [0.2, 0.5, 0.8, 1];
  const tones = kmeans(lit.map(base), TONES);
  const starts = HEADS.map(head => tones.map(tone => pal.range(N, (_, j) => j < PULSE.length ? mix(tone, head, PULSE[j]) : tone, 2)));
  const toneOf = p => { let k = 0, best = Infinity; tones.forEach((t, j) => { const d = d2(t, base(p)); if (d < best) { best = d; k = j; } }); return k; };
  const fixedStart = pal.colors.length, rest = [];
  for (let p = 0; p < W * H; p++) if (stage[p] < 0) rest.push(base(p));
  for (const c of kmeans(rest.filter((_, i) => i % 2 === 0), 256 - fixedStart)) pal.fixed(c);
  const owed = new Float32Array(W * H * 3), indices = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const x = p % W;
    if (stage[p] >= 0) {
      const k = toneOf(p), miss = base(p).map((v, i) => v - tones[k][i]);
      indices[p] = starts[stage[p]][k] + ((Math.floor(phase[p] / PERIOD * N) % N) + N) % N;
      for (const [dp, w, dx] of [[1, 7 / 16, 1], [W - 1, 3 / 16, -1], [W, 5 / 16, 0], [W + 1, 1 / 16, 1]]) {
        const q = p + dp;
        if (q >= W * H || x + dx < 0 || x + dx >= W || stage[q] >= 0) continue;
        for (let i = 0; i < 3; i++) owed[q * 3 + i] += miss[i] * w;
      }
      continue;
    }
    indices[p] = nearestIndex(pal.colors, fixedStart, pal.colors.length - fixedStart, base(p).map((v, i) => v + owed[p * 3 + i]));
  }
  console.log(`  ${lit.length}px of traces (${[0, 1, 2, 3].map(k => lit.filter(p => stage[p] === k).length).join('/')} by stage)`);
  return emit('circuit-pulse', 'Circuit Pulse', pal, indices);
}

// Synthwave Sunset: a striped sun sinking behind neon mountains over a grid
// that rolls toward the viewer. The sun's stripes slide down it and widen as
// they go; the grid's cross lines run out of the horizon; the horizon glow
// breathes and the stars twinkle.
async function synthwave() {
  const pal = palette(), HORIZON = 300, SUN = [320, 210, 120];
  const sky = y => loop([[14, 4, 40], [60, 10, 90], [170, 30, 120], [255, 90, 110]])(clamp(y / HORIZON) * 0.75);
  // The sun: eight bands of colour, top to bottom, each a range whose gaps
  // (showing the sky behind) slide down and widen with the band.
  const BANDS = 8, SUN_N = 16, sunTone = k => mix([255, 236, 110], [255, 50, 150], k / (BANDS - 1));
  const sunStarts = Array.from({ length: BANDS }, (_, k) => {
    const yMid = SUN[1] - SUN[2] + (k + 0.5) / BANDS * 2 * SUN[2], gap = 0.08 + 0.42 * (k / (BANDS - 1)) ** 1.5;
    return pal.range(SUN_N, t => frac(t) < gap ? sky(yMid) : sunTone(k), 4, 0);
  });
  // The grid: cross lines in three distances, each fading into the haze.
  const GRID_N = 24, line = [255, 60, 220], floor = [16, 4, 34], haze = [120, 30, 120];
  const gridStarts = [0, 1, 2].map(k => pal.range(GRID_N, t => mix(mix(floor, haze, k / 3), mix(line, haze, k / 2.5), Math.max(0, 1 - frac(t) * (9 + k * 3))), 2));
  const glowStart = pal.range(16, t => mix([255, 80, 140], [255, 170, 120], 0.5 + 0.5 * Math.cos(TAU * t)), 8);
  const twinkle = pal.range(12, t => mix([90, 60, 140], [255, 240, 255], Math.pow(0.5 + 0.5 * Math.cos(TAU * t), 3)), 6);
  const skyTones = Array.from({ length: 16 }, (_, k) => pal.fixed(sky((k + 0.5) / 16 * HORIZON)));
  const HAZE = 30, hazeTones = Array.from({ length: 6 }, (_, k) => pal.fixed(mix([200, 60, 160], [40, 10, 70], k / 5)));
  const rails = pal.fixed(line), mountain = pal.fixed([28, 8, 52]), rim = pal.fixed([0, 230, 255]), floorFixed = pal.fixed(floor);
  const ridge = x => HORIZON - 30 - 34 * Math.abs(Math.sin(x / 97 + 1)) * (0.6 + 0.4 * Math.sin(x / 31)) - 18 * Math.max(0, Math.sin(x / 53 + 2));
  const indices = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (y >= HORIZON) {
      const depth = 60 / (y - HORIZON + 1), lateral = (x - W / 2) / (y - HORIZON + 1);
      // Rails toward the vanishing point, about a pixel wide.
      if (Math.abs(frac(lateral / 1.6 + 0.5) - 0.5) * 1.6 * (y - HORIZON + 1) < 0.9) { indices[p] = rails; continue; }
      if (y < HORIZON + 4) { indices[p] = entry(glowStart, 16, 0, x, y); continue; }
      // Within HAZE rows of the horizon the lines would be closer than a few
      // pixels, so the floor is a still haze there.
      if (y < HORIZON + HAZE) { indices[p] = hazeTones[clamp(Math.floor((y - HORIZON) / HAZE * 6 + bayer(x, y) - 0.5), 0, 5)]; continue; }
      const k = y < HORIZON + 55 ? 2 : y < HORIZON + 100 ? 1 : 0;
      indices[p] = gridStarts[k] + Math.floor(frac(-depth * 6) * GRID_N) % GRID_N;
      continue;
    }
    const ry = ridge(x);
    if (y > ry) { indices[p] = y < ry + 2 ? rim : mountain; continue; }
    const d = Math.hypot(x - SUN[0], y - SUN[1]);
    if (d < SUN[2]) {
      const k = Math.min(BANDS - 1, Math.floor((y - (SUN[1] - SUN[2])) / (2 * SUN[2]) * BANDS));
      // The stripes only cut the lower half of the sun.
      const v = (y - SUN[1]) / SUN[2];
      indices[p] = v < 0 ? sunStarts[k] + SUN_N - 1 : sunStarts[k] + Math.floor(frac(-v * 3.5) * SUN_N);
      continue;
    }
    if (hash(x, y) < 0.004 && y < HORIZON - 80) { indices[p] = twinkle + Math.floor(hash(y, x) * 12); continue; }
    // The sky, dithered between its bands.
    const u = y / HORIZON * 16 + bayer(x, y) - 0.5;
    indices[p] = skyTones[clamp(Math.floor(u), 0, 15)];
  }
  void floorFixed;
  return emit('synthwave-sunset', 'Synthwave Sunset', pal, indices);
}

// Shift-invariant k-means of scalar sequences: prototypes, and for each
// sequence its prototype and the shift that best fits it.
function shiftFit(sequences, k, n, iterations = 12) {
  const dist = (q, proto, s) => { let d = 0; for (let t = 0; t < n; t++) d += (q[t] - proto[(t + s) % n]) ** 2; return d; };
  const assign = q => {
    let best = { cluster: 0, shift: 0, error: Infinity };
    protos.forEach((proto, j) => { for (let s = 0; s < n; s++) { const d = dist(q, proto, s); if (d < best.error) best = { cluster: j, shift: s, error: d }; } });
    return best;
  };
  const sample = sequences.filter((_, i) => i % 11 === 0);
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
    sums.forEach((sm, j) => { if (sm[n]) protos[j] = Float64Array.from(sm.subarray(0, n), v => v / sm[n]); });
  }
  return { protos, assign };
}

// Metaballs: the whole screen is a slow lava-lamp of merging blobs. Each
// pixel's level is a static blob field plus a travelling wave,
//   v = A(x, y) + WAVE cos(2 pi (phi(x, y) - t)),
// coloured by where v sits against the blobs' surface (v = 1). As the waves
// roll through, surfaces swell, bud, merge and part. A pixel's colour
// sequence depends only on A, quantized (and dithered) into ranges, and
// starts at phi: exact palette cycling, with no fitting error.
async function metaballs() {
  const pal = palette(), LEVELS = 12, N = 20, TICKS = 8, WAVE = 0.3;
  // Below the surface, a dark glow rising toward a hot pink rim; inside,
  // orange deepening to yellow at the blobs' hearts.
  const colour = v => v < 1 ? mix([14, 4, 34], [120, 20, 110], Math.pow(clamp(v), 3))
    : v < 1.12 ? mix([255, 60, 140], [255, 110, 90], (v - 1) / 0.12)
      : mix([255, 120, 60], [255, 236, 150], clamp((v - 1.12) / 1.2));
  const blobs = Array.from({ length: 22 }, (_, i) => [hash(i, 1) * W, hash(i, 2) * H, 22 + hash(i, 3) * 30]);
  const A = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0;
    for (const [bx, by, size] of blobs) v += size * size / ((x - bx) ** 2 + (y - by) ** 2 + 1);
    // Compressed so the blobs' hearts don't all saturate.
    A[y * W + x] = 1.9 * v / (1 + v);
  }
  const lo = 0.05, hi = 1.9, level = k => lo + (k + 0.5) / LEVELS * (hi - lo);
  // A pixel steps down through its range, so entry j shows time -j / N.
  const starts = Array.from({ length: LEVELS }, (_, k) => pal.range(N, t => colour(level(k) + WAVE * Math.cos(TAU * t)), TICKS));
  const indices = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = clamp(Math.floor((A[y * W + x] - lo) / (hi - lo) * LEVELS + bayer(x, y) - 0.5), 0, LEVELS - 1);
    const phi = x / 230 + 0.6 * Math.sin(y / 97 + x / 300) + 0.45 * Math.sin((x - y) / 143) + 0.3 * Math.cos(y / 61);
    // Dithered between steps too, so each surface creeps a pixel at a time.
    indices[y * W + x] = entry(starts[k], N, -phi, y, x);
  }
  return emit('metaballs', 'Metaballs', pal, indices);
}

export const ABSTRACT = {
  'plasma-field': plasma,
  'fractal-bloom': fractal,
  'op-art': opArt,
  kaleidoscope,
  wormhole,
  'circuit-pulse': circuit,
  'synthwave-sunset': synthwave,
  metaballs,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const only = process.argv.slice(2);
  for (const [stem, build] of Object.entries(ABSTRACT)) if (!only.length || only.includes(stem)) await build();
}
