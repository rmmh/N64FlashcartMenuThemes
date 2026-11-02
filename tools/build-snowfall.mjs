#!/usr/bin/env node
// Snowfall Village: snow drifting down over a mountain village at night, by
// palette cycling.
//
// Sources (see the .prompt files):
//   snowfall-village-raw.jpg   the painting; the base.
//   snowfall-village-mask.png  the sky blue, snow-covered surfaces (roofs,
//                              ground, banks, snow on trees) red.
//
// Flakes are small shapes (readable over interlaced video) stepping their own
// height at a time down their own paths, a gentle wind slant plus a sideways
// sway, and turning or tumbling as they go.
//
// A path pixel shows its flake for one entry and its resting color for the
// rest, and that resting color has to match its surroundings or the paths
// show as streaks. So the sky (apart from the moon, stars and bright cloud
// edges) is dithered to a few tones, each with its own snow range resting on
// exactly that tone; off the sky, a pixel can carry snow only if one of the
// other snow ranges rests close to its own color (see MISS_HIDDEN).
//
// Every path falls unbroken from the top until it settles on a snow-covered
// surface below its landing depth, or reaches the bottom: it is planned whole
// to weave around what can't carry snow (a lit window, the moon), and where
// there is no way around, it takes the nearest tone where that misses least.
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
// Paths: their spacing (px), the share that carry snow (picked by golden-ratio
// steps, so they spread evenly), the wind's slant (dx per dy), the sway's
// amplitude and wavelength ranges (px), the range of landing depths, and how
// far a path may sidestep to get around something.
const PATH_SPACING = 9, PATH_SHARE = 0.6, WIND = 0.12, SWAY = [1.5, 4.5], SWAY_LENGTH = [40, 90];
const LAND = [250, 470];
// Path planning: how far a path may stray from its drift (px), how far it may
// move sideways per step, and what straying and turning cost against a miss.
const REACH = 12, SHIFT = 2, STRAY = 0.6, TURN = 0.4;
// Flakes: their size and step (px), entries per loop (so flakes on a path are
// SNOW_ENTRIES flake heights apart), ticks per step, and the flake's
// brightness over its entries (lit for one step, no trail).
const SNOW_ENTRIES = 10, SNOW_TICKS = 6, FLAKE = [1, ...Array(9).fill(0)];
// Flakes and how often each is used: a cycle of shapes (rows of a pixel mask),
// one per step down the path, so a flake turns as it falls. A flake steps its
// own height each time, so the 3x3 ones fall faster, like nearer flakes.
const SHAPES = [
  // A small flake, still.
  [0.15, [['##', '##']]],
  // A small flake twirling between its diagonals.
  [0.15, [['#.', '.#'], ['#.', '.#'], ['.#', '#.'], ['.#', '#.']]],
  // A flake spinning: a plus, turned 45 degrees to a cross, and back.
  [0.45, [['.#.', '###', '.#.'], ['.#.', '###', '.#.'], ['#.#', '.#.', '#.#'], ['#.#', '.#.', '#.#']]],
  // A flake tumbling: face on, edge on, face on, turned.
  [0.25, [['.#.', '###', '.#.'], ['...', '###', '...'], ['.#.', '###', '.#.'], ['#.#', '.#.', '#.#']]],
].map(([share, frames]) => ({ share, h: frames[0].length, w: frames[0][0].length,
  frames: frames.map(rows => rows.flatMap((row, dy) => [...row].flatMap((c, dx) => c === '#' ? [[dx, dy]] : []))) }));
const FLAKE_COLOR = [236, 240, 255];
// Tones: the sky's (dithered) and the rest's; how far an off-sky pixel's color
// may be from its tone before the miss shows, on smooth painting and per unit
// of local texture (which hides it); and the brightest sky pixel that is
// dithered (the moon, stars and bright cloud edges keep their own colors).
const SKY_TONES = 5, OTHER_TONES = 11, MISS_HIDDEN = 7, TEXTURE_HIDES = 0.8, SKY_BRIGHT = 105;

const frac = v => v - Math.floor(v);
const hash = (a, b = 0) => frac(Math.sin(a * 12.9898 + b * 78.233 + 4.1) * 43758.5453);
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

export async function buildSnowfall() {
  const read = async name => cover(decodePlate(new Uint8Array(await fs.readFile(path.join(sources, name)))), W, H);
  const [image, mask] = await Promise.all([read('snowfall-village-raw.jpg'), read('snowfall-village-mask.png')]);
  const at = (img, p) => [img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]];
  const base = p => at(image, p);
  const label = p => { const [r, g, b] = at(mask, p); return r > 128 && g < 100 && b < 100 ? 'snow' : b > 128 && r < 100 && g < 100 ? 'sky' : null; };
  const labels = Array.from({ length: W * H }, (_, p) => label(p));
  const colors = [], ranges = [];
  const snowRange = tone => {
    const start = colors.length;
    for (const c of FLAKE) colors.push(consoleColor(tone.map((v, i) => v + (FLAKE_COLOR[i] - v) * c)));
    ranges.push({ start, length: SNOW_ENTRIES, stepTicks: SNOW_TICKS, flags: 0 });
    return start;
  };

  // ---- what each pixel rests on: a snow range's start, or -1 ----
  const carrier = new Int16Array(W * H).fill(-1);
  // The sky, dithered to its tones.
  const sky = [];
  for (let p = 0; p < W * H; p++) if (labels[p] === 'sky' && luma(base(p)) < SKY_BRIGHT) sky.push(p);
  const skyTones = kmeans(sky.map(base), SKY_TONES), skyStarts = skyTones.map(snowRange);
  const skyTone = new Int8Array(W * H).fill(-1), inSky = new Uint8Array(W * H), error = new Float32Array(W * H * 3);
  for (const p of sky) inSky[p] = 1;
  for (const p of sky) {
    const x = p % W, y = (p / W) | 0, want = base(p).map((v, i) => v + error[p * 3 + i]);
    let k = 0, best = Infinity;
    skyTones.forEach((t, j) => { const d = d2(t, want); if (d < best) { best = d; k = j; } });
    for (const [dx, dy, w] of [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]) {
      const q = (y + dy) * W + x + dx;
      if (x + dx < 0 || x + dx >= W || y + dy >= H || !inSky[q]) continue;
      for (let i = 0; i < 3; i++) error[q * 3 + i] += (want[i] - skyTones[k][i]) * w * 0.85;
    }
    skyTone[p] = k;
    carrier[p] = skyStarts[k];
  }
  // How busy the painting is around each pixel: its 5x5 luma deviation.
  const busy = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, s2 = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (x + dx < 0 || x + dx >= W || y + dy < 0 || y + dy >= H) continue;
      const l = luma(base((y + dy) * W + x + dx)); s += l; s2 += l * l; n++;
    }
    busy[y * W + x] = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  }
  // The rest: tones fitted to the scenery, weighted toward its smooth parts,
  // where a miss would show.
  const scenery = [];
  for (let p = 0; p < W * H; p += 2) if (labels[p] !== 'sky' && hash(p % W, p / W | 0) < 1 / (1 + busy[p] / 8)) scenery.push(p);
  const otherTones = kmeansVectors(scenery.map(base), OTHER_TONES), otherStarts = otherTones.map(snowRange);
  // Every pixel's nearest snow range, and how visibly its resting color would
  // miss the painting there (0 where texture hides it, or in the dithered sky).
  const nearest = new Int16Array(W * H), excess = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    if (carrier[p] >= 0) { nearest[p] = carrier[p]; continue; }
    const tones = labels[p] === 'sky' ? skyTones : otherTones, starts = labels[p] === 'sky' ? skyStarts : otherStarts;
    let k = 0, best = Infinity;
    tones.forEach((t, j) => { const d = d2(t, base(p)); if (d < best) { best = d; k = j; } });
    nearest[p] = starts[k];
    const miss = Math.sqrt(best) - Math.max(MISS_HIDDEN, TEXTURE_HIDES * busy[p]);
    excess[p] = miss > 0 ? miss + 4 : 0;
  }

  // ---- the paths ----
  const index = new Int16Array(W * H).fill(-1);
  // Each path is planned whole, by dynamic programming over its rows: at each
  // row the flake sits up to REACH px either side of its drift, moving at most
  // SHIFT px a step; a block costs the misses of its pixels (nothing where
  // they carry snow), a taken pixel can't be used, and straying from the drift
  // costs a little. So every path falls all the way, around what it can, and
  // through the least visible miss where it can't.
  // Off screen (a flake blowing in from the left) costs nothing and isn't drawn.
  const onScreen = (shape, x) => x >= 0 && x + shape.w <= W;
  // The flake's frame at row y: the shape's cycle, one frame per step.
  const block = (shape, x, y, spin) => shape.frames[((y / shape.h | 0) + spin) % shape.frames.length]
    .filter(([, dy]) => y + dy < H).map(([dx, dy]) => (y + dy) * W + x + dx);
  const cost = (shape, x, y, spin) => {
    if (!onScreen(shape, x)) return 0;
    let c = 0;
    for (const p of block(shape, x, y, spin)) { if (index[p] >= 0) return 1e6; c += excess[p]; }
    return c;
  };
  let paths = 0, flakePixels = 0, landed = 0, forced = 0;
  for (let n = -Math.ceil(WIND * H / PATH_SPACING) - 2; n * PATH_SPACING < W + 8; n++) {
    if (frac(n * 0.6180339887 + 0.17) >= PATH_SHARE) continue;
    const x0 = n * PATH_SPACING + 3 * hash(n, 1), sway = SWAY[0] + hash(n, 2) * (SWAY[1] - SWAY[0]);
    const length = SWAY_LENGTH[0] + hash(n, 3) * (SWAY_LENGTH[1] - SWAY_LENGTH[0]), turn = hash(n, 4) * 2 * Math.PI;
    const land = LAND[0] + hash(n, 5) * (LAND[1] - LAND[0]), offset = Math.floor(hash(n, 6) * SNOW_ENTRIES);
    const drift = y => Math.round(x0 + WIND * y + sway * Math.sin(2 * Math.PI * y / length + turn));
    let pick = hash(n, 7), shape = SHAPES[0];
    for (const s of SHAPES) { if (pick < s.share) { shape = s; break; } pick -= s.share; }
    const spin = Math.floor(hash(n, 8) * shape.frames.length), rows = [];
    for (let y = 0; y < H; y += shape.h) rows.push(y);
    const span = 2 * REACH + 1, total = new Float32Array(rows.length * span).fill(Infinity), from = new Int8Array(rows.length * span);
    rows.forEach((y, r) => {
      for (let o = -REACH; o <= REACH; o++) {
        const here = cost(shape, drift(y) + o, y, spin) + STRAY * Math.abs(o);
        if (r === 0) { total[o + REACH] = here; continue; }
        let best = Infinity, arg = 0;
        for (let d = -SHIFT; d <= SHIFT; d++) {
          const q = o - d;
          if (q < -REACH || q > REACH) continue;
          const t = total[(r - 1) * span + q + REACH] + TURN * Math.abs(d);
          if (t < best) { best = t; arg = q; }
        }
        total[r * span + o + REACH] = best + here;
        from[r * span + o + REACH] = arg;
      }
    });
    // Trace back from the cheapest end, then lay the path down from the top,
    // skipping it while off screen and stopping where it settles on snow.
    let o = 0, end = Infinity;
    for (let q = -REACH; q <= REACH; q++) if (total[(rows.length - 1) * span + q + REACH] < end) { end = total[(rows.length - 1) * span + q + REACH]; o = q; }
    if (end >= 1e6) continue;
    const route = new Array(rows.length);
    for (let r = rows.length - 1; r >= 0; r--) { route[r] = o; o = from[r * span + o + REACH]; }
    let settled = false;
    rows.forEach((y, r) => {
      if (settled) return;
      const x = drift(y) + route[r];
      if (!onScreen(shape, x)) return;
      const cells = block(shape, x, y, spin);
      if (y >= land && cells.some(p => labels[p] === 'snow')) { settled = true; landed++; return; }
      const entry = ((y / shape.h | 0) + offset) % SNOW_ENTRIES;
      for (const p of cells) {
        index[p] = nearest[p] + entry;
        flakePixels++;
        if (excess[p] > 0) forced++;
      }
    });
    paths++;
  }

  // ---- everything else ----
  // Fixed colors: the sky tones themselves first (for the dithered sky off the
  // paths), then the painting's colors.
  const fixedStart = colors.length;
  for (const t of skyTones) colors.push(consoleColor(t));
  const fixed = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0 && skyTone[p] < 0) fixed.push(base(p));
  for (const c of kmeans(fixed, 256 - colors.length)) colors.push(consoleColor(c));
  const paintStart = fixedStart + skyTones.length;
  // Where a path pixel's resting tone misses the painting, the painting pixels
  // beside and below it take up the difference, so the local color stays true
  // and the path dissolves into the texture instead of showing as a line.
  const restOf = new Map([...skyStarts.map((st, k) => [st, skyTones[k]]), ...otherStarts.map((st, k) => [st, otherTones[k]])]);
  const owed = new Float32Array(W * H * 3);
  const indices = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const x = p % W;
    if (index[p] >= 0) {
      indices[p] = index[p];
      if (labels[p] === 'sky') continue;
      const tone = restOf.get(nearest[p]), miss = base(p).map((v, i) => v - tone[i]);
      for (const [dp, w, dx] of [[1, 7 / 16, 1], [W - 1, 3 / 16, -1], [W, 5 / 16, 0], [W + 1, 1 / 16, 1]]) {
        const q = p + dp;
        if (q >= W * H || x + dx < 0 || x + dx >= W || index[q] >= 0 || skyTone[q] >= 0) continue;
        for (let i = 0; i < 3; i++) owed[q * 3 + i] += miss[i] * w;
      }
      continue;
    }
    indices[p] = skyTone[p] >= 0 ? fixedStart + skyTone[p]
      : nearestIndex(colors, paintStart, colors.length - paintStart, base(p).map((v, i) => v + owed[p * 3 + i]));
  }
  const theme = {
    name: 'Snowfall Village', family: 'Cycling', colors: interfaceColors(image),
    background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges },
    border: { source: 'internal', id: 8 },
  };
  const packed = packThemeImage(theme, { staticBackground: indexImage(W, H, indices), staticPalette: colors });
  await writeSdTheme('snowfall-village.png', packed.image);
  const parsed = parseThemeImage(packed.image), preview = path.join(root, 'out/previews/cycling');
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(path.join(preview, 'snowfall-village.png'), encodePng(renderTheme(parsed, { time: 0 })));
  console.log(`Snowfall Village: ${ranges.length} ranges, ${colors.length - fixedStart} fixed colors; `
    + `${paths} paths (${landed} settling), ${flakePixels}px of snow (${forced} missing their color), ${sky.length}px dithered sky`);
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildSnowfall();
