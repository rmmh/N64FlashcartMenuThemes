#!/usr/bin/env node
// Shooting Stars: a meteor shower over a desert valley, by palette cycling on
// a scrolling panorama.
//
// Source: shooting-stars-raw.jpg (see its .prompt), the starry valley, painted
// to tile horizontally. As in build-panoramas.mjs, an 800x384 band of it is
// looped and slowly panned; the meteors' paths are painted into the band (and
// wrap around its seam), so they drift across the sky with the stars.
//
// Meteors streak out from a radiant above the top left of the sky, as in a
// real shower: each runs a straight path away from it, a white head with a
// fading blue-green tail, two pixels thick so it holds up over interlaced
// video. All meteors share one timeline, a few dozen steps of dark sky with
// each meteor's flight staggered into it; blending between steps smooths the
// head's travel. A meteor's pixels rest on one of a few sky tones; stars
// along its path keep their own colors (the meteor passes behind them), and
// where a tone misses the sky, the pixels beside the path take up the
// difference so no trace of the path shows between meteors.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/png-node.mjs';
import { decodePlate } from './decode-plate.mjs';
import { cover, wrapByRamp, kmeans, nearestIndex, indexImage, consoleColor } from '../src/palette-tools.mjs';
import { packThemeImage, parseThemeImage } from '../src/theme.mjs';
import { renderTheme } from '../src/renderer.mjs';
import { interfaceColors } from './build-panoramas.mjs';
import { writeSdTheme } from './theme-output.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'assets/cycling-sources');
// The band's size, where it sits in the painting, and how fast it pans.
const W = 800, H = 384, FOCUS_Y = 0.5, PAN = -0.12, BLEND = 2;
// The meteors: [where each starts (px), its heading (degrees below
// horizontal; close together, as if from one radiant up to the left), its
// length (px)], all on the shared timeline in turn.
const METEORS = [[[90, 30], 31, 130], [[470, 60], 26, 170], [[260, 95], 35, 110], [[640, 20], 29, 160]];
// The timeline: steps per loop, ticks per step, and how far (px) a head moves
// per step; the streak over its steps (head last: a pixel steps down through
// its range, so it shows the head first and then the fading tail).
const ENTRIES = 64, TICKS = 4, STEP = 20;
const STREAK = [0.1, 0.25, 0.5, 0.8, 1];
const HEAD = [255, 250, 236], TAIL = [150, 215, 255];
// Sky: the lowest a meteor may run, its resting tones, and the brightest sky
// pixel a meteor covers (brighter ones are stars, which it passes behind).
const SKY_BOTTOM = 230, TONES = 2, STAR = 70;

const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

export async function buildMeteors() {
  const image = wrapByRamp(cover(decodePlate(new Uint8Array(await fs.readFile(path.join(sources, 'shooting-stars-raw.jpg')))), W, H, FOCUS_Y));
  const base = p => [image.data[p * 4], image.data[p * 4 + 1], image.data[p * 4 + 2]];

  // ---- the meteors' paths: each pixel's step on the timeline ----
  const step = new Map();
  METEORS.forEach(([[sx, sy], heading, run], m) => {
    const dx = Math.cos(heading * Math.PI / 180), dy = Math.sin(heading * Math.PI / 180), first = Math.round(m * ENTRIES / METEORS.length);
    for (let s = 0; s < run; s += 0.5) for (const off of [0, 1]) {
      const x = ((Math.round(sx + dx * s - dy * off * 0.9) % W) + W) % W, y = Math.round(sy + dy * s + dx * off * 0.9), p = y * W + x;
      if (y < 0 || y >= SKY_BOTTOM || step.has(p) || luma(base(p)) > STAR) continue;
      step.set(p, first + Math.floor(s / STEP));
    }
  });

  // ---- the timeline's ranges, one per resting tone ----
  const colors = [], ranges = [];
  const pixels = [...step.keys()];
  const tones = kmeans(pixels.map(base), TONES);
  const starts = tones.map(tone => {
    const start = colors.length;
    for (let j = 0; j < ENTRIES; j++) {
      const c = j < STREAK.length ? STREAK[j] : 0, glow = HEAD.map((v, i) => TAIL[i] + (v - TAIL[i]) * c);
      colors.push(consoleColor(tone.map((v, i) => v + (glow[i] - v) * c)));
    }
    ranges.push({ start, length: ENTRIES, stepTicks: TICKS, flags: BLEND });
    return start;
  });
  const toneOf = new Map(pixels.map(p => {
    let k = 0, best = Infinity;
    tones.forEach((t, j) => { const d = d2(t, base(p)); if (d < best) { best = d; k = j; } });
    return [p, k];
  }));

  // ---- everything else, taking up the paths' misses ----
  const fixedStart = colors.length, fixed = [];
  for (let p = 0; p < W * H; p++) if (!step.has(p)) fixed.push(base(p));
  for (const c of kmeans(fixed, 256 - fixedStart)) colors.push(consoleColor(c));
  const owed = new Float32Array(W * H * 3), indices = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const x = p % W;
    if (step.has(p)) {
      const k = toneOf.get(p), miss = base(p).map((v, i) => v - tones[k][i]);
      indices[p] = starts[k] + ((step.get(p) % ENTRIES) + ENTRIES) % ENTRIES;
      for (const [dp, w, dx] of [[1, 7 / 16, 1], [W - 1, 3 / 16, -1], [W, 5 / 16, 0], [W + 1, 1 / 16, 1]]) {
        const q = p + dp;
        if (q >= W * H || x + dx < 0 || x + dx >= W || step.has(q)) continue;
        for (let i = 0; i < 3; i++) owed[q * 3 + i] += miss[i] * w;
      }
      continue;
    }
    indices[p] = nearestIndex(colors, fixedStart, colors.length - fixedStart, base(p).map((v, i) => v + owed[p * 3 + i]));
  }

  const theme = {
    name: 'Shooting Stars', family: 'Cycling', colors: interfaceColors(image),
    background: { mode: 'static' }, staticLayout: { panX: PAN, panY: 0 }, staticPalette: { ranges },
    border: { source: 'internal', id: 8 },
  };
  const packed = packThemeImage(theme, { staticBackground: indexImage(W, H, indices), staticPalette: colors });
  await writeSdTheme('shooting-stars.png', packed.image);
  const parsed = parseThemeImage(packed.image), preview = path.join(root, 'out/previews/cycling');
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(path.join(preview, 'shooting-stars.png'), encodePng(renderTheme(parsed, { time: 0 })));
  console.log(`Shooting Stars: ${ranges.length} range(s), ${colors.length - fixedStart} fixed colors; ${METEORS.length} meteors over ${step.size}px`);
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildMeteors();
