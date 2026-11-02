#!/usr/bin/env node
// Lighthouse Storm: a sweeping lamp and rolling swells, both by palette cycling.
//
// lighthouse-storm-calm.jpg is the raw painting edited to a gentler sea with
// no beam and no rain (falling rain could not share the palette with the
// beam); lighthouse-storm-lit.jpg is that edit with the lamp lighting
// everything around it, so lit minus calm is how each cloud and
// cliff looks when the beam reaches it. lighthouse-storm-mask.png marks the
// lighthouse and its headland, which the beam passes over.
//
// The beam: the lamp turns in a horizontal plane. A horizontal ray from the
// lamp projects to the line from the lamp toward that direction's vanishing
// point on the horizon, so every pixel above the horizon belongs to one beam
// direction: pixels below the lamp to beams pointing away, pixels above it
// to beams turned toward the viewer. That direction is the pixel's phase, and
// its color runs calm + light * beam(phase - t) for two opposed beams. The
// lamp's glass brightens on the same clock as a beam turns to face the viewer.
//
// The sea: lighthouse-storm-sea-sheet.jpg is a generated looping animation
// of swells rolling in (16 consecutive frames). It supplies only the timing:
// when each pixel's swell passes and how deep it is. The colors are the
// painting's, brightened and darkened as the swell passes.
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
const W = 640, H = 480, BLEND = 2;
// Scene geometry (640x480): the lamp, the sea horizon, and the camera's
// principal point and focal length for the beam's perspective.
const LAMP = [530, 92], HORIZON = 311, FOCAL = 520, CENTER_X = 320;
// Beam: clusters, entries per half turn (the two beams are identical), the
// time per entry, and the beam's half-width in turns.
const BEAM_CLUSTERS = 6, BEAM_ENTRIES = 12, BEAM_TICKS = 18, BEAM_WIDTH = 0.035;
// The lamp's glass: clusters and radius. It brightens, on the beam's clock,
// as a beam turns toward the viewer, and dims as the beams point sideways.
const LAMP_CLUSTERS = 3, LAMP_RADIUS = 15;
// Sea: the generated animation's grid (columns, rows), ranges, entries per
// swell, time per entry, and how far brightness swings at the deepest swell.
const SEA_SHEET = [2, 8], SEA_CLUSTERS = 5, SEA_ENTRIES = 8, SEA_TICKS = 27, SEA_GAIN = 0.8;

const frac = v => v - Math.floor(v);
const hash = (a, b = 0) => frac(Math.sin(a * 12.9898 + b * 78.233 + 4.1) * 43758.5453);
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const nearest4 = (list, c) => { let best = 0, bd = Infinity; list.forEach((v, j) => { let d = 0; for (let i = 0; i < 4; i++) d += (v[i] - c[i]) ** 2; if (d < bd) { bd = d; best = j; } }); return best; };
const nearest = (list, c) => { let best = 0, bd = Infinity; list.forEach((v, j) => { const d = d2(v, c); if (d < bd) { bd = d; best = j; } }); return best; };
function hsv([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max ? d / max : 0, max];
}
/** A stable per-pixel threshold, so phases between entries dither instead of banding. */
const dither = (x, y) => hash(x * 0.731 + y * 1.37, y * 0.29 - x * 0.11);

/** The lamp's direction, in turns, whose beam passes over (x, y). */
function beamTurn(x, y) {
  const [lx, ly] = LAMP;
  if (Math.abs(y - ly) < 0.5) return x < lx ? 0.5 : 0;
  // Where the screen line from the lamp through the pixel meets the horizon.
  const vx = lx + (x - lx) * (HORIZON - ly) / (y - ly), along = vx - CENTER_X;
  // Below the lamp the ray runs away from the viewer, above it toward them.
  const angle = y > ly ? Math.atan2(FOCAL, along) : Math.atan2(-FOCAL, -along);
  return frac(angle / (2 * Math.PI));
}

export async function buildLighthouse() {
  const read = async name => cover(decodePlate(new Uint8Array(await fs.readFile(path.join(sources, name)))), W, H);
  const [image, lit, mask] = await Promise.all(['lighthouse-storm-calm.jpg', 'lighthouse-storm-lit.jpg', 'lighthouse-storm-mask.png'].map(read));
  const sheet = decodePlate(new Uint8Array(await fs.readFile(path.join(sources, 'lighthouse-storm-sea-sheet.jpg'))));
  const at = (img, p) => [img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]];
  const colors = [], ranges = [], index = new Int16Array(W * H).fill(-1);
  const addRange = (entries, stepTicks) => {
    const start = colors.length;
    for (const c of entries) colors.push(consoleColor(c));
    ranges.push({ start, length: entries.length, stepTicks, flags: BLEND });
    return start;
  };

  // ---- beam ----
  const light = p => { const a = at(lit, p), b = at(image, p); return a.map((v, i) => v - b[i]); };
  // The tower, the keeper's house and the near headland (magenta in the
  // mask) are out of the beam's path; the distant cliffs behind them are in it.
  const shadowed = (x, y) => {
    const [r, g, b] = at(mask, y * W + x);
    return (r > 128 && b > 128 && g < 100) || Math.hypot(x - LAMP[0], y - LAMP[1]) < 12;
  };
  const beamPixels = [];
  for (let y = 0; y < HORIZON; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (index[p] < 0 && !shadowed(x, y) && luma(light(p)) > 8) beamPixels.push(p);
  }
  const profile = u => { const d = Math.min(u, 1 - u); return Math.exp(-((d / (BEAM_WIDTH * 2)) ** 2)); };
  const centers = kmeansVectors(beamPixels.filter((_, i) => i % 4 === 0).map(p => [...at(image, p), ...light(p).map(v => v * 1.5)]), BEAM_CLUSTERS)
    .map(c => [c.slice(0, 3), c.slice(3).map(v => v / 1.5)]);
  const beamStarts = centers.map(([base, glow]) => addRange(Array.from({ length: BEAM_ENTRIES }, (_, j) =>
    base.map((v, i) => v + glow[i] * profile(j / BEAM_ENTRIES))), BEAM_TICKS));
  // Dithered by error diffusion on the unlit color, as the still frame shows it.
  const inSet = new Uint8Array(W * H), error = new Float32Array(W * H * 3);
  for (const p of beamPixels) inSet[p] = 1;
  const unlit = centers.map(([base, glow]) => base.map((v, i) => v + glow[i] * profile(0.5)));
  for (const p of beamPixels) {
    const x = p % W, y = (p / W) | 0, want = at(image, p).map((v, i) => v + error[p * 3 + i]);
    const k = nearest(unlit, want);
    for (const [dx, dy, w] of [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]) {
      const q = (y + dy) * W + x + dx;
      if (x + dx < 0 || x + dx >= W || y + dy >= H || !inSet[q]) continue;
      for (let i = 0; i < 3; i++) error[q * 3 + i] += (want[i] - unlit[k][i]) * w * 0.8;
    }
    // Two opposed beams: the phase is the direction modulo half a turn.
    const half = frac(2 * beamTurn(x, y));
    index[p] = beamStarts[k] + Math.floor(half * BEAM_ENTRIES + dither(x, y)) % BEAM_ENTRIES;
  }

  // ---- lamp ----
  // Beam pixels light when the step reaches their phase; a beam faces the
  // viewer (direction 3/4 turn, half-turn phase 1/2) at step BEAM_ENTRIES / 2.
  const lampPixels = [];
  for (let y = LAMP[1] - LAMP_RADIUS; y <= LAMP[1] + LAMP_RADIUS; y++) for (let x = LAMP[0] - LAMP_RADIUS; x <= LAMP[0] + LAMP_RADIUS; x++) {
    const p = y * W + x, [r, g, b] = at(image, p);
    if (index[p] < 0 && Math.hypot(x - LAMP[0], y - LAMP[1]) <= LAMP_RADIUS && luma([r, g, b]) > 70 && r > b + 30) lampPixels.push(p);
  }
  const lampTones = kmeans(lampPixels.map(p => at(image, p)), LAMP_CLUSTERS);
  const facing = u => { const d = Math.min(u, 1 - u); return 0.42 + 0.95 * Math.exp(-((d / 0.16) ** 2)); };
  const lampStarts = lampTones.map(tone => addRange(Array.from({ length: BEAM_ENTRIES }, (_, j) => tone.map(v => v * facing(j / BEAM_ENTRIES))), BEAM_TICKS));
  // Dithered, so the glass keeps its gradient and glazing bars.
  const lampSet = new Set(lampPixels), lampError = new Map();
  for (const p of lampPixels) {
    const e = lampError.get(p) ?? [0, 0, 0], want = at(image, p).map((v, i) => v + e[i]), k = nearest(lampTones, want);
    for (const [dx, dw] of [[1, 7 / 16], [W - 1, 3 / 16], [W, 5 / 16], [W + 1, 1 / 16]]) {
      if (!lampSet.has(p + dx)) continue;
      const n = lampError.get(p + dx) ?? [0, 0, 0];
      lampError.set(p + dx, n.map((v, i) => v + (want[i] - lampTones[k][i]) * dw));
    }
    index[p] = lampStarts[k] + BEAM_ENTRIES / 2;
  }

  // ---- sea ----
  // Sea pixels by neighbourhood: mostly saturated blue-teal around them
  // (rocks are greyer and more violet); foam counts where the sea is.
  const core = new Uint8Array(W * H);
  for (let p = HORIZON * W; p < W * H; p++) { const [h, s] = hsv(at(image, p)); core[p] = h >= 198 && h <= 223 && s > 0.4 ? 1 : 0; }
  const seaPixels = [];
  for (let y = HORIZON + 2; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (index[p] >= 0) continue;
    let n = 0, m = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const X = x + dx, Y = y + dy; if (X < 0 || X >= W || Y >= H) continue; n++; m += core[Y * W + X];
    }
    if (m / n > 0.45) seaPixels.push(p);
  }
  // The motion comes from the generated animation of the sea: each pixel's
  // brightness over the loop, reduced to its first harmonic, gives when its
  // swell passes and how strongly. The colors stay the painting's.
  const cellW = sheet.width / SEA_SHEET[0], cellH = sheet.height / SEA_SHEET[1];
  const seaFrames = Array.from({ length: SEA_SHEET[0] * SEA_SHEET[1] }, (_, i) => resizeImage(cropImage(sheet,
    [Math.round((i % SEA_SHEET[0]) * cellW), Math.round(Math.floor(i / SEA_SHEET[0]) * cellH), Math.round(cellW), Math.round(cellH)]), W, H - HORIZON));
  const n = seaFrames.length, swell = new Map();
  for (const p of seaPixels) {
    const x = p % W, y = ((p / W) | 0) - HORIZON;
    let re = 0, im = 0, mean = 0;
    seaFrames.forEach((f, t) => {
      const l = luma(at(f, y * W + x)), a = 2 * Math.PI * t / n;
      re += l * Math.cos(a); im -= l * Math.sin(a); mean += l / n;
    });
    swell.set(p, { phase: frac(-Math.atan2(im, re) / (2 * Math.PI)), depth: Math.min(0.9, 2 * Math.hypot(re, im) / n / Math.max(8, mean)) });
  }
  // Ranges by painted color and swell depth, dithered to the painting.
  const seaFeature = p => [...at(image, p), swell.get(p).depth * 120];
  const seaCenters = kmeansVectors(seaPixels.filter((_, i) => i % 3 === 0).map(seaFeature), SEA_CLUSTERS);
  const seaStarts = seaCenters.map(c => addRange(Array.from({ length: SEA_ENTRIES }, (_, j) =>
    c.slice(0, 3).map(v => v * (1 + SEA_GAIN * (c[3] / 120) * Math.cos(2 * Math.PI * j / SEA_ENTRIES)))), SEA_TICKS));
  const seaSet = new Uint8Array(W * H), seaError = new Float32Array(W * H * 3);
  for (const p of seaPixels) seaSet[p] = 1;
  for (const p of seaPixels) {
    const x = p % W, y = (p / W) | 0, c = at(image, p).map((v, i) => v + seaError[p * 3 + i]);
    const { phase, depth } = swell.get(p), k = nearest4(seaCenters, [...c, depth * 120]);
    for (const [dx, dy, w] of [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]) {
      const q = (y + dy) * W + x + dx;
      if (x + dx < 0 || x + dx >= W || y + dy >= H || !seaSet[q]) continue;
      for (let i = 0; i < 3; i++) seaError[q * 3 + i] += (c[i] - seaCenters[k][i]) * w * 0.8;
    }
    // Index i shows entry i - step, brightest (entry 0) when step reaches its phase.
    index[p] = seaStarts[k] + Math.floor(phase * SEA_ENTRIES + dither(x, y)) % SEA_ENTRIES;
  }

  // ---- everything else ----
  const fixedStart = colors.length, fixed = [];
  for (let p = 0; p < W * H; p++) if (index[p] < 0) fixed.push(at(image, p));
  for (const c of kmeans(fixed, 256 - fixedStart)) colors.push(consoleColor(c));
  const indices = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++)
    indices[p] = index[p] >= 0 ? index[p] : nearestIndex(colors, fixedStart, colors.length - fixedStart, at(image, p));
  const theme = {
    name: 'Lighthouse Storm', family: 'Cycling', colors: interfaceColors(image),
    background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges },
    border: { source: 'internal', id: 8 },
  };
  const packed = packThemeImage(theme, { staticBackground: indexImage(W, H, indices), staticPalette: colors });
  await writeSdTheme('lighthouse-storm.png', packed.image);
  const parsed = parseThemeImage(packed.image), preview = path.join(root, 'out/previews/cycling');
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(path.join(preview, 'lighthouse-storm.png'), encodePng(renderTheme(parsed, { time: 0 })));
  console.log(`Lighthouse Storm: ${ranges.length} ranges, ${colors.length - fixedStart} fixed colors; ${lampPixels.length}px lamp, ${beamPixels.length}px beam, ${seaPixels.length}px sea`);
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildLighthouse();
