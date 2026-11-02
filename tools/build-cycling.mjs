#!/usr/bin/env node
// Builds the Cycling family: image-generated scenes animated only by CI8
// palette cycling (type 12), in the manner of classic color-cycling art.
// Sources and prompts are in assets/cycling-sources/.
//
// Most themes have their own builder (tools/build-<theme>.mjs), compiling
// image-generated plates (lit and unlit versions of a scene, masks, flame
// sheets) or simulations into cycling ranges; Radar Sweep is compiled from
// generated animation frames. A theme without one lists effects instead.
// An effect names the pixels that move (a mask),
// how their phase runs (along a flow, around a point, per object, ...) and
// the light that travels along that phase. Its pixels are clustered into a
// few colors, each given a ramp of palette entries that is cycled, so light
// moves toward increasing phase. Everything else keeps fixed colors. The
// format allows 16 cycling ranges, one per cluster.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSdTheme } from './theme-output.mjs';
import { encodePng } from '../src/png-node.mjs';
import { decodePlate } from './decode-plate.mjs';
import { packThemeImage, parseThemeImage } from '../src/theme.mjs';
import { renderTheme } from '../src/renderer.mjs';
import { cover, kmeans, nearestIndex, indexImage, consoleColor } from '../src/palette-tools.mjs';
import { interfaceColors } from './build-panoramas.mjs';
import { buildRadarSweep } from './build-radar-sweep.mjs';
import { buildAurora } from './build-aurora.mjs';
import { buildCampfire } from './build-campfire.mjs';
import { buildLighthouse } from './build-lighthouse.mjs';
import { buildLava } from './build-lava.mjs';
import { buildHyperspace } from './build-hyperspace.mjs';
import { buildCaustics } from './build-caustics.mjs';
import { buildChristmas } from './build-christmas.mjs';
import { buildWaterfall } from './build-waterfall.mjs';
import { buildThunderstorm } from './build-thunderstorm.mjs';
import { buildSnowfall } from './build-snowfall.mjs';
import { buildMeteors } from './build-meteors.mjs';
import { ABSTRACT } from './build-abstract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'assets/cycling-sources');
const outPreview = path.join(root, 'out/previews/cycling');
const W = 640, H = 480, MAX_RANGES = 16;
const BLEND = 2;

// ---- pixel helpers ----------------------------------------------------------
const luma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
function hsv([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max ? d / max : 0, max];
}
function fromHsv(h, s, v) {
  h = ((h % 360) + 360) % 360 / 60;
  const c = v * s, x = c * (1 - Math.abs((h % 2) - 1)), m = v - c, i = Math.floor(h);
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][i];
  return [r + m, g + m, b + m];
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp = c => c.map(v => Math.max(0, Math.min(255, v)));
const frac = v => v - Math.floor(v);
// Deterministic hash in [0, 1).
const hash = (...n) => frac(Math.sin(n.reduce((a, v, i) => a + v * [12.9898, 78.233, 37.719, 4.581][i % 4], 0)) * 43758.5453);

/** Connected components of a mask; returns a label per pixel (-1 outside) and component centroids. */
function components(mask) {
  const label = new Int32Array(W * H).fill(-1), centers = [];
  for (let p = 0; p < W * H; p++) {
    if (!mask[p] || label[p] >= 0) continue;
    const id = centers.length, stack = [p]; let sx = 0, sy = 0, n = 0;
    label[p] = id;
    while (stack.length) {
      const q = stack.pop(), x = q % W, y = (q / W) | 0; sx += x; sy += y; n++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, r = ny * W + nx;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && mask[r] && label[r] < 0) { label[r] = id; stack.push(r); }
      }
    }
    centers.push([sx / n, sy / n, n]);
  }
  return { label, centers };
}

// ---- phases, in cycles; light moves toward increasing phase ---------------
export const phase = {
  /** Along direction (dx, dy), one cycle per `wavelength` px; `jitter` cycles of per-streak offset across it. */
  flow: (dx, dy, wavelength, jitter = 0, streak = 3) => (x, y) => {
    const along = (x * dx + y * dy) / wavelength, across = Math.floor((x * -dy + y * dx) / streak);
    return along + jitter * hash(across);
  },
  /** Outward from (cx, cy): `log` spaces cycles logarithmically, as for rushing depth. */
  radial: (cx, cy, wavelength, log = false) => (x, y) => {
    const r = Math.hypot(x - cx, y - cy) + 1;
    return log ? Math.log(r) / wavelength : r / wavelength;
  },
  /** Around (cx, cy) clockwise, `turns` cycles per revolution; `twist` adds cycles per log radius (spirals). */
  angle: (cx, cy, turns = 1, twist = 0) => (x, y) =>
    turns * (Math.atan2(y - cy, x - cx) / (2 * Math.PI)) + twist * Math.log(Math.hypot(x - cx, y - cy) + 1),
  /** Toward the viewer on a ground plane whose horizon is row `horizon`. */
  depth: (horizon, scale, jitter = 0, streak = 4) => (x, y) => -scale / Math.max(1, y - horizon) + jitter * hash(Math.floor(x / streak)),
  /** Sum of drifting sines, for shimmer. */
  noise: (scale, seed = 1) => (x, y) => 0.5 * Math.sin(x / scale + seed) + 0.35 * Math.sin((x * 0.6 + y) / (scale * 0.8) + 2 * seed)
    + 0.25 * Math.sin((y * 1.3 - x * 0.4) / (scale * 0.6) + 3 * seed),
  /** One phase for every pixel. */
  uniform: (value = 0) => () => value,
};

// ---- ramp shapes: brightness of entry u in [0, 1), the light at u near 1 ----
export const shape = {
  wave: u => 0.5 - 0.5 * Math.cos(2 * Math.PI * u),
  /** A short bright head with a fading tail behind it. */
  streak: (tail = 0.25) => u => Math.exp(-(1 - u) / tail),
  /** `count` bright pulses per cycle with duty `duty`. */
  chase: (count = 2, duty = 0.5) => u => (frac(u * count) < duty ? 1 : 0.08),
  /** Off except a brief flash at the end of the cycle. */
  flash: (length = 0.06) => u => (u > 1 - length ? 1 : u > 1 - 2.5 * length ? 0.35 : 0),
  /** An irregular flicker. */
  flicker: seed => u => 0.55 + 0.45 * Math.sin(2 * Math.PI * u * 3 + seed) * Math.sin(2 * Math.PI * u * 5 + 2 * seed),
};

/**
 * One effect's palette ramps. `style`:
 *   'light' brightens toward `tint` (or white) by shape(u) * amount;
 *   'shade' scales brightness by 1 + amount * (2 * shape(u) - 1);
 *   'hue'   rotates hue a full turn, keeping saturation and value.
 */
function ramp(base, effect) {
  const { entries, style = 'light', amount = 0.8, tint = null } = effect, f = effect.shape ?? shape.wave;
  return Array.from({ length: entries }, (_, j) => {
    const u = j / entries, w = f(u);
    if (style === 'hue') { const [h, s, v] = hsv(base); return clamp(fromHsv(h + 360 * u, Math.max(s, 0.55), v)); }
    if (style === 'shade') return clamp(base.map(v => v * (1 + amount * (2 * w - 1))));
    const target = tint ?? base.map(v => Math.min(255, v * 1.8 + 60));
    return clamp(mix(base, target, Math.min(1, w * amount)));
  });
}

/**
 * Index `image` (640x480 RGBA) for `effects`, each
 *   { name, mask(x, y, rgb, ctx) -> bool, phase(x, y, ctx) -> cycles, clusters, entries,
 *     stepTicks, blend = true, perObject: per-component random phase added, style, shape, amount, tint }.
 * Pixels claimed by an earlier effect are not offered to later ones.
 */
export function cyclingIndexed(image, effects) {
  const { data } = image, rgb = p => [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]];
  const ctx = { rgb: (x, y) => rgb(y * W + x), luma: (x, y) => luma(rgb(y * W + x)), hsv: (x, y) => hsv(rgb(y * W + x)) };
  const owner = new Int16Array(W * H).fill(-1), colors = [], ranges = [], cycled = new Int16Array(W * H).fill(-1);
  const clusterCount = effects.reduce((n, e) => n + e.clusters, 0);
  if (clusterCount > MAX_RANGES) throw new Error(`${clusterCount} cycling clusters; the format allows ${MAX_RANGES}`);
  effects.forEach((effect, e) => {
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (owner[p] < 0 && effect.mask(x, y, rgb(p), ctx)) { mask[p] = 1; owner[p] = e; }
    }
    const pixels = []; for (let p = 0; p < W * H; p++) if (mask[p]) pixels.push(rgb(p));
    if (!pixels.length) throw new Error(`effect ${effect.name} matched no pixels`);
    const bases = kmeans(pixels, effect.clusters).sort((a, b) => luma(a) - luma(b));
    const starts = bases.map(base => {
      const start = colors.length;
      for (const c of ramp(base, effect)) colors.push(consoleColor(c));
      ranges.push({ start, length: effect.entries, stepTicks: effect.stepTicks, flags: effect.blend === false ? 0 : BLEND });
      return start;
    });
    const objects = effect.perObject ? components(mask) : null, baseColors = bases.map(consoleColor);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!mask[p]) continue;
      let ph = effect.phase(x, y, ctx);
      if (objects) ph += hash(objects.label[p] + 1, e);
      const c = nearestIndex(baseColors, 0, baseColors.length, rgb(p));
      cycled[p] = starts[c] + Math.floor(frac(ph) * effect.entries) % effect.entries;
    }
    effect.pixels = pixels.length;
  });
  const fixedStart = colors.length, fixed = [];
  for (let p = 0; p < W * H; p++) if (owner[p] < 0) fixed.push(rgb(p));
  for (const c of kmeans(fixed, 256 - fixedStart)) colors.push(consoleColor(c));
  const indices = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++)
    indices[p] = cycled[p] >= 0 ? cycled[p] : nearestIndex(colors, fixedStart, colors.length - fixedStart, data.subarray(p * 4, p * 4 + 3));
  return { image: indexImage(W, H, indices), colors, ranges, fixedColors: colors.length - fixedStart };
}

// ---- masks ----------------------------------------------------------------
const within = (x0, y0, x1, y1) => (x, y) => x >= x0 * W && x < x1 * W && y >= y0 * H && y < y1 * H;
const and = (...fs) => (x, y, c, ctx) => fs.every(f => f(x, y, c, ctx));
const not = f => (x, y, c, ctx) => !f(x, y, c, ctx);
const bright = (min, max = 256) => (x, y, c) => luma(c) >= min && luma(c) < max;
const hue = (from, to, minSat = 0.3) => (x, y, c) => { const [h, s] = hsv(c); return s >= minSat && (from <= to ? h >= from && h <= to : h >= from || h <= to); };
const grey = (maxSat = 0.25) => (x, y, c) => hsv(c)[1] <= maxSat;
/** Small bright spots: brighter than their surroundings by `contrast`. */
const spot = (contrast, radius = 3) => (x, y, c, ctx) => {
  if (x < radius || y < radius || x >= W - radius || y >= H - radius) return false;
  let s = 0, n = 0;
  for (const [dx, dy] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius]]) { s += ctx.luma(x + dx, y + dy); n++; }
  return luma(c) - s / n > contrast;
};

// A strike and a double strike at uneven points in each 24-entry cycle (brightness for 'shade').

export const THEMES = [
  // A demoscene plasma: sines summed into one field, a palette running through it.
  { stem: 'plasma-field', name: 'Plasma Field', build: ABSTRACT['plasma-field'] },
  // Bands of colour pour out of a Julia set forever.
  { stem: 'fractal-bloom', name: 'Fractal Bloom', build: ABSTRACT['fractal-bloom'] },
  // Rings expand through a twisting polar checkerboard.
  { stem: 'op-art', name: 'Op Art', build: ABSTRACT['op-art'] },
  // A twelve-fold mandala whose motifs ripple outward and inward.
  { stem: 'kaleidoscope', name: 'Kaleidoscope', build: ABSTRACT['kaleidoscope'] },
  // A spiral of nebula drains into a black singularity.
  { stem: 'wormhole', name: 'Wormhole', build: ABSTRACT['wormhole'] },
  // Pulses stream out of the N64 main board's chips along its traces.
  { stem: 'circuit-pulse', name: 'Circuit Pulse', build: ABSTRACT['circuit-pulse'] },
  // A striped sun sinks over a grid rolling toward the viewer.
  { stem: 'synthwave-sunset', name: 'Synthwave Sunset', build: ABSTRACT['synthwave-sunset'] },
  // The whole screen is a lava lamp of swelling, merging blobs.
  { stem: 'metaballs', name: 'Metaballs', build: ABSTRACT['metaballs'] },
  // Water pours down the falls, rings spread across the pool, mist drifts.
  { stem: 'waterfall-grotto', name: 'Waterfall Grotto', build: buildWaterfall },
  // Lava falls stream, floor lava drifts, braziers burn and the lava light flickers.
  { stem: 'lava-forge', name: 'Lava Forge', build: buildLava },
  // The lamp's twin beams sweep the storm; swells roll in; rain falls.
  { stem: 'lighthouse-storm', name: 'Lighthouse Storm', build: buildLighthouse },
  // Generated animation frames are compiled into palette orbits separately.
  { stem: 'radar-sweep', name: 'Radar Sweep', frameBased: true },
  // The aurora's own light rolls along its curtains and their reflection.
  { stem: 'aurora-tundra', name: 'Aurora Tundra', build: buildAurora },
  // The painted streak field rushes out of the vanishing point.
  { stem: 'hyperspace', name: 'Hyperspace', build: buildHyperspace },
  // Snow drifts down and settles on the roofs and ground.
  { stem: 'snowfall-village', name: 'Snowfall Village', build: buildSnowfall },
  // Meteors streak across a slowly panning desert sky.
  { stem: 'shooting-stars', name: 'Shooting Stars', build: buildMeteors },
  // Generated flame poses play in turn; the firelight they cast flickers.
  { stem: 'campfire-woods', name: 'Campfire Woods', build: buildCampfire },
  // The tree's bulbs twinkle, the hearth burns and its firelight flickers.
  { stem: 'christmas-tree', name: 'Christmas Tree', build: buildChristmas },
  // A net of refracted light wobbles over the pool floor, following its depth.
  { stem: 'caustic-pool', name: 'Caustic Pool', build: buildCaustics },
  // Lightning strikes over the river, rain falls and splashes on the paving.
  { stem: 'thunderstorm-city', name: 'Thunderstorm City', build: buildThunderstorm },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await fs.mkdir(outPreview, { recursive: true });
  const only = process.argv.slice(2);
  for (const spec of THEMES) {
    if (only.length && !only.includes(spec.stem)) continue;
    if (spec.frameBased) { await buildRadarSweep(); continue; }
    if (spec.build) { await spec.build(); continue; }
    const file = path.join(sources, `${spec.stem}-raw.jpg`);
    const source = await fs.readFile(file).then(b => decodePlate(new Uint8Array(b)), () => null);
    if (!source) { console.log(`${spec.name}: no source yet`); continue; }
    const image = cover(source, W, H), indexed = cyclingIndexed(image, spec.effects);
    const theme = {
      name: spec.name, family: 'Cycling', colors: interfaceColors(image),
      background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges: indexed.ranges },
      border: { source: 'internal', id: 8 },
    };
    const packed = packThemeImage(theme, { staticBackground: indexed.image, staticPalette: indexed.colors });
    await writeSdTheme(`${spec.stem}.png`, packed.image);
    const parsed = parseThemeImage(packed.image);
    await fs.writeFile(path.join(outPreview, `${spec.stem}.png`), encodePng(renderTheme(parsed, { time: 0 })));
    const effects = spec.effects.map(e => `${e.name} ${e.pixels}px`).join(', ');
    console.log(`${spec.name}: ${indexed.ranges.length} ranges, ${indexed.fixedColors} fixed colors; ${effects}`);
  }
}
