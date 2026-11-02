#!/usr/bin/env node
// Thunderstorm City: lightning, rain and splashes on a riverside promenade,
// by palette cycling.
//
// Sources (see the .prompt files):
//   thunderstorm-city-base.jpg   the painting (with no rain drawn in), its bridge completed across
//                                the river; the base.
//   thunderstorm-city-flash.jpg  the base at the instant of a lightning strike:
//                                the bolt, the clouds lit from within, cold light
//                                on the river and the wet paving. Flash minus
//                                base is the lightning's light.
//   thunderstorm-city-mask.png   sky blue, river green, walkable ground red.
//
// Lightning: the light plays a fixed strike pattern (a faint distant flicker,
// then a double strike that fades), clustered by (base, light) and dithered
// toward the base, separately for the sky and the rest so each keeps its tones.
// Rain: thin slanting streaks fall over the sky and the dark parts of the
// scene; each streak line has its own offset so no bands form. Pixels only
// carry rain where a rain range rests on exactly (in the sky) or closely
// (elsewhere) their own color, so the streaks leave no paths between drops.
// Splashes: small rings, squashed
// by the ground's perspective, open on the paving and the river.
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
const W = 640, H = 480;
// Lightning: the strike pattern (one entry per step), its step, the clusters
// for the sky and the rest, and the least light (luma) that flashes at all.
const STRIKE = [0, 0.3, 0.08, 0, 0, 1, 0.3, 0.85, 0.4, 0.12];
// The bolt shows only at the strikes' peaks.
const BOLT = [0, 0, 0, 0, 0, 1, 0, 0.8, 0, 0];
const STRIKE_TICKS = 19, SKY_CLUSTERS = 3, GROUND_CLUSTERS = 2, SKY_MIN = -1, GROUND_MIN = 26;
// The bolt: thin lines of the flash brighter than its own surroundings (within
// BOLT_REACH px) by BOLT_SEED, grown along neighbors brighter by BOLT_GROW, so
// its branches stay joined even where it crosses glowing cloud; only where the
// flash brightens the sky by BOLT_GAIN, which leaves out the lit cloud rims.
const BOLT_REACH = 4, BOLT_SEED = 55, BOLT_GROW = 26, BOLT_FLOOR = 150, BOLT_GAIN = 95;
// Rain: streak lines' spacing (px) and slant (dx per dy), the share that carry
// rain, a drop's period along its line (px; it falls PERIOD / ENTRIES px per
// step), the loop, the streak's brightness down its length, its color, and,
// off the sky, how close (RGB distance) a pixel must be to the rain range's
// resting color to carry rain.
const RAIN_SPACING = 4, RAIN_SLANT = 0.18, RAIN_SHARE = 0.5, RAIN_PERIOD = 24, RAIN_ENTRIES = 8, RAIN_TICKS = 1;
const RAIN_CURVE = [0.2, 0.45, 0.7, 1, 0, 0, 0, 0], RAIN_LIGHT = [50, 56, 70], RAIN_TONES = 3, RAIN_MATCH = 20, RAIN_BRIGHT = 90, RAIN_FLASH_MAX = 80;
// Splashes: drops per 1000 px of water and ground, their loop, ring radii (px)
// across, the horizon that sets how flat they are, and how close a pixel must be.
// The loop matches the falling drops' (30 ticks), so a drop lands as its ring opens.
// Splashes only open below SPLASH_TOP: further off, on the water under the
// bridge's arches, they would read as specks on the bridge.
const SPLASH_DENSITY = 1.6, SPLASH_ENTRIES = 10, SPLASH_TICKS = 3, SPLASH_RADIUS = 4, HORIZON = 290, SPLASH_TOP = 312;
// A ring (tail first, see below): bright as it opens, fading as it spreads;
// nothing between drops.
const RING_CURVE = [0.25, 0.5, 0.75, 1, ...Array(SPLASH_ENTRIES - 4).fill(0)], RING_HEAD = 3;
const SPLASH_CLUSTERS = 1, SPLASH_MATCH = 30, SPLASH_GAIN = 0.9, SPLASH_TINT = [85, 95, 125];
// Falling drops: near splashes (below NEAR_Y) that get a streak falling into
// them, its loop (15 steps of 2 ticks, 30 ticks like the splashes), how far it
// falls per step (px), its length (px) and how close a pixel must be to carry it.
const NEAR_Y = 370, FALL_SHARE = 0.6, FALL_ENTRIES = 15, FALL_TICKS = 2, FALL_STEP = 6, FALL_REACH = [36, 90];
const FALL_CURVE = [0.25, 0.55, 1, ...Array(12).fill(0)], FALL_MATCH = 24, FALL_HEAD = 2;
// (A pixel steps down through its range's entries, so every curve here is
// written tail first: a streak's head, or a ring's first flash, is its last
// lit entry.)

const frac = v => v - Math.floor(v);
const hash = (a, b = 0) => frac(Math.sin(a * 12.9898 + b * 78.233 + 4.1) * 43758.5453);
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

export async function buildThunderstorm() {
  const read = async name => cover(decodePlate(new Uint8Array(await fs.readFile(path.join(sources, name)))), W, H);
  const [image, flash, mask] = await Promise.all(['base.jpg', 'flash.jpg', 'mask.png'].map(n => read(`thunderstorm-city-${n}`)));
  const at = (img, p) => [img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]];
  const label = p => { const [r, g, b] = at(mask, p); return r > 128 && g < 100 && b < 100 ? 'ground' : b > 128 && r < 100 && g < 100 ? 'sky' : g > 128 && r < 100 && b < 100 ? 'river' : null; };
  const labels = Array.from({ length: W * H }, (_, p) => label(p));
  const base = p => at(image, p);
  const colors = [], ranges = [], index = new Int16Array(W * H).fill(-1);
  const addRange = (list, ticks, flags) => {
    const start = colors.length;
    for (const c of list) colors.push(consoleColor(c));
    ranges.push({ start, length: list.length, stepTicks: ticks, flags });
    return start;
  };

  // ---- splashes on the river and the paving ----
  const wet = [];
  for (let p = SPLASH_TOP * W; p < W * H; p++) if ((labels[p] === 'ground' || labels[p] === 'river') && index[p] < 0) wet.push(p);
  const drops = Math.round(wet.length * SPLASH_DENSITY / 1000), splash = new Map(), falls = [];
  for (let d = 0; d < drops; d++) {
    const centre = wet[Math.floor(hash(d, 21) * wet.length)], cx = centre % W, cy = (centre / W) | 0;
    // The drop lands at the start of fall step `land`; the ring opens then.
    // A pixel at entry i shows its head entry from tick (i - HEAD) * ticks; the
    // drop's foot pixel lands at (land - 1 - FALL_HEAD) * FALL_TICKS, and the
    // ring's centre flashes on the next splash step.
    const land = Math.floor(hash(d, 22) * FALL_ENTRIES);
    const born = Math.ceil((land - 1 - FALL_HEAD) * FALL_TICKS / SPLASH_TICKS) + RING_HEAD;
    if (cy > NEAR_Y && hash(d, 23) < FALL_SHARE) falls.push([cx, cy, land, FALL_REACH[0] + hash(d, 24) * (FALL_REACH[1] - FALL_REACH[0])]);
    // Rings flatten toward the horizon and shrink with distance.
    const near = Math.min(1, Math.max(0.35, (cy - HORIZON) / (H - HORIZON))), squash = 0.18 + 0.3 * near;
    const reach = Math.max(1.5, SPLASH_RADIUS * (0.5 + near));
    for (let dy = -2; dy <= 2; dy++) for (let dx = -Math.ceil(reach); dx <= Math.ceil(reach); dx++) {
      const r = Math.hypot(dx, dy / squash), p = (cy + dy) * W + cx + dx;
      if (r > reach + 0.5 || cy + dy < 0 || cy + dy >= H || cx + dx < 0 || cx + dx >= W || splash.has(p)) continue;
      if ((labels[p] !== 'ground' && labels[p] !== 'river') || cy + dy < SPLASH_TOP) continue;
      splash.set(p, born + Math.round(r * 3.2 / reach));
    }
  }
  const splashPixels = [...splash.keys()];
  const splashTones = kmeans(splashPixels.map(base), SPLASH_CLUSTERS);
  const splashStarts = splashTones.map(tone => addRange(RING_CURVE.map(c => tone.map((v, i) => v + (SPLASH_TINT[i] + v * SPLASH_GAIN - v * 0.2) * c)), SPLASH_TICKS, 0));
  let splashCount = 0;
  for (const [p, phase] of splash) {
    const c = base(p);
    let k = -1, best = SPLASH_MATCH ** 2;
    splashTones.forEach((t, j) => { const d = d2(t, c); if (d < best) { best = d; k = j; } });
    if (k < 0) continue;
    index[p] = splashStarts[k] + ((phase % SPLASH_ENTRIES) + SPLASH_ENTRIES) % SPLASH_ENTRIES;
    splashCount++;
  }

  // ---- drops falling into the near splashes ----
  // Each falls along the rain's slant; the pixel `h` px above the splash is lit
  // h / FALL_STEP steps before it lands.
  const fallPixels = new Map();
  for (const [cx, cy, land, reach] of falls)
    for (let h = 1; h < reach; h++) {
      const y = cy - h, x = Math.round(cx - RAIN_SLANT * h), p = y * W + x;
      if (y < 0 || x < 0 || x >= W || index[p] >= 0 || fallPixels.has(p)) continue;
      fallPixels.set(p, land - Math.ceil(h / FALL_STEP));
    }
  const [fallTone] = fallPixels.size ? kmeans([...fallPixels.keys()].map(base), 1) : [[0, 0, 0]];
  const fallStart = addRange(FALL_CURVE.map(c => fallTone.map((v, i) => v + RAIN_LIGHT[i] * 1.3 * c)), FALL_TICKS, 0);
  let fallCount = 0;
  for (const [p, step] of fallPixels) {
    if (d2(fallTone, base(p)) > FALL_MATCH ** 2) continue;
    index[p] = fallStart + ((step % FALL_ENTRIES) + FALL_ENTRIES) % FALL_ENTRIES;
    fallCount++;
  }

  // ---- lightning ----
  const light = p => at(flash, p).map((v, i) => v - image.data[p * 4 + i]);
  // Warm lamplight and its reflections keep their own colors; the flash is too
  // brief to be worth posterizing them.
  const warm = ([r, , b]) => r > b + 12;
  let flashCount = 0, boltCount = 0, skyCenters = [];
  const skyCluster = new Map();
  // The bolt: thin bright lines of the flash, which light only at the peaks.
  const flashLuma = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) flashLuma[p] = luma(at(flash, p));
  const surround = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0, n = 0;
    for (let dy = -BOLT_REACH; dy <= BOLT_REACH; dy++) for (let dx = -BOLT_REACH; dx <= BOLT_REACH; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      sum += flashLuma[yy * W + xx]; n++;
    }
    surround[y * W + x] = sum / n;
  }
  const ridge = p => flashLuma[p] - surround[p];
  const inBolt = new Uint8Array(W * H), queue = [];
  for (let p = 0; p < W * H; p++)
    if (index[p] < 0 && labels[p] === 'sky' && ridge(p) > BOLT_SEED && flashLuma[p] > BOLT_FLOOR + 40 && luma(light(p)) > BOLT_GAIN) { inBolt[p] = 1; queue.push(p); }
  while (queue.length) {
    const p = queue.pop(), x = p % W;
    for (const q of [p - 1, p + 1, p - W, p + W, p - W - 1, p - W + 1, p + W - 1, p + W + 1]) {
      if (q < 0 || q >= W * H || inBolt[q] || Math.abs((q % W) - x) > 1) continue;
      if (index[q] >= 0 || labels[q] !== 'sky' || ridge(q) < BOLT_GROW || flashLuma[q] < BOLT_FLOOR || luma(light(q)) < BOLT_GAIN) continue;
      inBolt[q] = 1; queue.push(q);
    }
  }
  const bolt = [];
  for (let p = 0; p < W * H; p++) if (inBolt[p]) bolt.push(p);
  boltCount = bolt.length;
  const flashRegion = region => {
    const pixels = [], least = region === 'sky' ? SKY_MIN : GROUND_MIN;
    for (let p = 0; p < W * H; p++)
      if (index[p] < 0 && (labels[p] === 'sky') === (region === 'sky') && Math.abs(luma(light(p))) > least && (region === 'sky' || !warm(base(p)))) pixels.push(p);
    const centers = kmeansVectors(pixels.filter((p, i) => i % 2 === 0 && !inBolt[p]).map(p => [...base(p), ...light(p)]), region === 'sky' ? SKY_CLUSTERS : GROUND_CLUSTERS)
      .map(c => [c.slice(0, 3), c.slice(3)]);
    const starts = centers.map(([b, l]) => addRange(STRIKE.map(s => b.map((v, i) => v + l[i] * s)), STRIKE_TICKS, 0));
    if (region === 'sky') skyCenters = centers;
    const inSet = new Uint8Array(W * H), error = new Float32Array(W * H * 3);
    for (const p of pixels) inSet[p] = 1;
    for (const p of pixels) {
      const x = p % W, y = (p / W) | 0, want = base(p).map((v, i) => v + error[p * 3 + i]), l = light(p);
      let k = 0, best = Infinity;
      // The resting color matters most: it shows nearly all the time.
      centers.forEach(([cb, cl], j) => { const d = d2(cb, want) + (inBolt[p] ? 0 : 0.08 * d2(cl, l)); if (d < best) { best = d; k = j; } });
      for (const [dx, dy, w] of [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]) {
        const q = (y + dy) * W + x + dx;
        if (x + dx < 0 || x + dx >= W || y + dy >= H || !inSet[q]) continue;
        for (let i = 0; i < 3; i++) error[q * 3 + i] += (want[i] - centers[k][0][i]) * w * 0.8;
      }
      index[p] = starts[k];
      if (region === 'sky') skyCluster.set(p, k);
      flashCount++;
    }
  };
  flashRegion('sky');
  // The bolt's pixels took the sky tones they would have had; each tone gets a
  // bolt range that shows exactly that sky (at rest and in the faint flicker)
  // except at the strikes' peaks, so between strikes the bolt is invisible.
  skyCenters.forEach(([b, l], k) => {
    const mine = bolt.filter(p => skyCluster.get(p) === k);
    if (!mine.length) return;
    const lit = [0, 1, 2].map(i => mine.reduce((a, p) => a + at(flash, p)[i], 0) / mine.length);
    const start = addRange(BOLT.map((on, j) => on ? b.map((v, i) => v + (lit[i] - v) * on) : b.map((v, i) => v + l[i] * STRIKE[j])), STRIKE_TICKS, 0);
    for (const p of mine) { index[p] = start; skyCluster.delete(p); }
  });

  // ---- rain ----
  // A pixel is on a streak line if it is the line's pixel in its row. In the
  // sky, each rain range rests on one of the sky's lightning tones, so a pixel
  // carrying rain keeps exactly the color it would have had and the streak
  // lines leave no trace between drops (they stand dark against a flash).
  // Elsewhere it falls on over the buildings, river and street, wherever a
  // pixel is close to one of the off-sky rain tones (not over lit windows and
  // lamps, which would need tones of their own).
  const rainLine = p => {
    const x = p % W, y = (p / W) | 0, line = Math.round((x - RAIN_SLANT * y) / RAIN_SPACING);
    // Exactly one pixel per row (the line's rounded position), so no row drops
    // out where the line falls halfway between two pixels. Lines are picked by
    // golden-ratio steps rather than at random, so the streaks spread evenly.
    return x === Math.round(line * RAIN_SPACING + RAIN_SLANT * y) && frac(line * 0.6180339887 + 0.31) < RAIN_SHARE ? line : null;
  };
  const drop = (start, p) => start + Math.floor(frac(((p / W) | 0) / RAIN_PERIOD + hash(rainLine(p), 12)) * RAIN_ENTRIES);
  const rainRange = tone => addRange(RAIN_CURVE.map(c => tone.map((v, i) => v + RAIN_LIGHT[i] * c)), RAIN_TICKS, 0);
  const skyRain = skyCenters.map(([b]) => rainRange(b));
  let rainCount = 0;
  // Not where the flash lights the clouds brightest: there the resting streak
  // lines would stand out as dark stripes across the flash.
  for (const [p, k] of skyCluster) if (rainLine(p) !== null && luma(light(p)) < RAIN_FLASH_MAX) { index[p] = drop(skyRain[k], p); rainCount++; }
  const dry = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0 && labels[p] !== 'sky' && luma(base(p)) < RAIN_BRIGHT && luma(light(p)) < RAIN_FLASH_MAX && rainLine(p) !== null) dry.push(p);
  const rainTones = kmeans(dry.map(base), RAIN_TONES), otherRain = rainTones.map(rainRange);
  for (const p of dry) {
    let k = -1, best = RAIN_MATCH ** 2;
    rainTones.forEach((t, j) => { const d = d2(t, base(p)); if (d < best) { best = d; k = j; } });
    if (k >= 0) { index[p] = drop(otherRain[k], p); rainCount++; }
  }

  // The rest flashes after the rain is placed, so streaks run on through the
  // distant buildings (which the flash rim-lights) instead of stopping at them.
  flashRegion('rest');

  // ---- everything else ----
  const fixedStart = colors.length, fixed = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0) fixed.push(base(p));
  for (const c of kmeans(fixed, 256 - fixedStart)) colors.push(consoleColor(c));
  const indices = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++)
    indices[p] = index[p] >= 0 ? index[p] : nearestIndex(colors, fixedStart, colors.length - fixedStart, base(p));
  const theme = {
    name: 'Thunderstorm City', family: 'Cycling', colors: interfaceColors(image),
    background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges },
    border: { source: 'internal', id: 8 },
  };
  const packed = packThemeImage(theme, { staticBackground: indexImage(W, H, indices), staticPalette: colors });
  await writeSdTheme('thunderstorm-city.png', packed.image);
  const parsed = parseThemeImage(packed.image), preview = path.join(root, 'out/previews/cycling');
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(path.join(preview, 'thunderstorm-city.png'), encodePng(renderTheme(parsed, { time: 0 })));
  console.log(`Thunderstorm City: ${ranges.length} ranges, ${colors.length - fixedStart} fixed colors; `
    + `${flashCount}px lightning, ${boltCount}px bolt, ${rainCount}px rain, ${splashCount}px splashes (${drops} drops), ${fallCount}px falling into ${falls.length}`);
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildThunderstorm();
