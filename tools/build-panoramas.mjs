#!/usr/bin/env node
// Builds the Panorama family from image-generated wide scenes in
// assets/panorama-sources/ (prompts alongside as *.prompt). Each scene keeps its
// full width, is made to loop horizontally, quantized to 800x384 CI8
// (300 KB, which fits a 4 MiB console; the menu draws it at 1.25x) and pans
// slowly. Interface colors are derived from the image.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSdTheme } from './theme-output.mjs';
import { encodePng } from '../src/png-node.mjs';
import { decodePlate } from './decode-plate.mjs';
import { packThemeImage, parseThemeImage } from '../src/theme.mjs';
import { renderTheme } from '../src/renderer.mjs';
import { cover, wrapByRamp, horizontalSeam, quantizeIndexed, kmeans, pixelsOf, colorizeIndexImage, nearestIndex, indexImage, consoleColor } from '../src/palette-tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'assets/panorama-sources');
const outPreview = path.join(root, 'out/previews/panoramas');

// name, file stem, pan (output px per frame; negative moves left), vertical focus of the band
export const PANORAMAS = [
  ['Aurora Fjord', 'aurora-fjord', -0.15, 0.45],
  ['Neon Skyline', 'neon-skyline', -0.25, 0.5],
  ['Dune Sea', 'dune-sea', -0.2, 0.55],
  ['Kelp Cathedral', 'kelp-cathedral', 0.15, 0.5],
  ['Ink Mountains', 'ink-mountains', -0.12, 0.5],
  ['Great Wave', 'great-wave', 0.25, 0.6],
  ['Ringed Horizon', 'ringed-horizon', -0.1, 0.4],
  ['Palm Dusk', 'palm-dusk', -0.18, 0.5],
  ['Fungal Glow', 'fungal-glow', -0.15, 0.5],
  ['Pixel Lake', 'pixel-lake', -0.15, 0.5],
  ['Side Scroller', 'side-scroller', -0.5, 0.5],
  ['Dungeon Crawl', 'dungeon-crawl', -0.3, 0.5],
  ['Voxel Isles', 'voxel-isles', -0.2, 0.5],
  ['Bauhaus Shapes', 'bauhaus-shapes', -0.15, 0.5],
  ['Liquid Marble', 'liquid-marble', 0.12, 0.5],
  ['Alpine Meadow', 'alpine-meadow', -0.15, 0.5],
  ['Bamboo Grove', 'bamboo-grove', -0.15, 0.5],
  ['Canyon River', 'canyon-river', -0.15, 0.5],
  ['Glacier Bay', 'glacier-bay', -0.15, 0.5],
  ['Rice Terraces', 'rice-terraces', -0.15, 0.5],
  ['Redwood Fog', 'redwood-fog', -0.15, 0.5],
  ['Tulip Fields', 'tulip-fields', -0.15, 0.5],
  ['Autumn Valley', 'autumn-valley', -0.15, 0.5],
  ['Salt Mirror', 'salt-mirror', -0.15, 0.5],
  ['Thunder Plains', 'thunder-plains', -0.15, 0.5],
  ['Coral Shallows', 'coral-shallows', -0.15, 0.5],
  ['Midnight Sun', 'midnight-sun', -0.15, 0.5],
  ['Mangrove Dawn', 'mangrove-dawn', -0.15, 0.5],
  ['Lavender Rows', 'lavender-rows', -0.15, 0.5],
  ['Waterfall Gorge', 'waterfall-gorge', -0.15, 0.5],
  ['Black Sand Coast', 'black-sand-coast', -0.15, 0.5],
  ['Birch Snow', 'birch-snow', -0.15, 0.5],
  ['Desert Milky Way', 'desert-milkyway', -0.15, 0.5],
  ['Highland Loch', 'highland-loch', -0.15, 0.5],
  ['Tea Hills', 'tea-hills', -0.15, 0.5],
  ['Rooftops Dusk', 'rooftops-dusk', -0.15, 0.5],
  ['Rainy Alley', 'rainy-alley', -0.15, 0.5],
  ['Medina Roofs', 'medina-roofs', -0.15, 0.5],
  ['Container Port', 'container-port', -0.15, 0.5],
  ['Pastel Skyline', 'pastel-skyline', -0.15, 0.5],
  ['Cliff Village', 'cliff-village', -0.15, 0.5],
  ['Jungle Temple', 'jungle-temple', -0.15, 0.5],
  ['Alpine Village', 'alpine-village', -0.15, 0.5],
  ['Space Habitat', 'space-habitat', -0.15, 0.5],
  ['Crystal Cavern', 'crystal-cavern', -0.15, 0.5],
  ['Dragon Peaks', 'dragon-peaks', -0.15, 0.5],
  ['Elven City', 'elven-city', -0.15, 0.5],
  ['Sky Whales', 'sky-whales', -0.15, 0.5],
  ['Mech Hangar', 'mech-hangar', -0.15, 0.5],
  ['Alien Ocean', 'alien-ocean', -0.15, 0.5],
  ['Clockwork City', 'clockwork-city', -0.15, 0.5],
  ['Mars Outpost', 'mars-outpost', -0.15, 0.5],
  ['Nebula Drift', 'nebula-drift', -0.1, 0.5],
  ['Ice Planet', 'ice-planet', -0.15, 0.5],
  ['Haunted Moor', 'haunted-moor', -0.15, 0.5],
  ['Kart Circuit', 'kart-circuit', -0.45, 0.5],
  ['RPG Overworld', 'rpg-overworld', -0.3, 0.5],
  ['Shmup Space', 'shmup-space', -0.6, 0.5],
  ['Ice Level', 'ice-level', -0.4, 0.5],
  ['Lava Castle', 'lava-castle', -0.4, 0.5],
  ['Jungle Level', 'jungle-level', -0.4, 0.5],
  ['Graveyard Level', 'graveyard-level', -0.35, 0.5],
  ['Cyber Level', 'cyber-level', -0.45, 0.5],
  ['Canyon Racer', 'canyon-racer', -0.45, 0.5],
  ['Castle Grounds', 'castle-grounds', -0.3, 0.5],
  ["Beat 'em Up Street", 'beatemup-street', -0.35, 0.5],
  ['Voxel Forest', 'voxel-forest', -0.25, 0.5],
  ['Memphis Pattern', 'memphis-pattern', -0.1, 0.5],
  ['Stained Glass', 'stained-glass', -0.1, 0.5],
  ['Topo Lines', 'topo-lines', -0.1, 0.5],
  ['Paper Layers', 'paper-layers', -0.1, 0.5],
  ['Ink Bloom', 'ink-bloom', -0.1, 0.5],
  ['Risograph Sunset', 'risograph-sunset', -0.1, 0.5],
  ['Silk Ribbons', 'silk-ribbons', -0.1, 0.5],
  ['Glitch Sort', 'glitch-sort', -0.1, 0.5],
  ['Terrazzo Chips', 'terrazzo-chips', -0.1, 0.5],
  ['Art Deco', 'art-deco', -0.1, 0.5],
  ['Sunken Ship', 'sunken-ship', -0.15, 0.5],
  ['Puzzle Blocks', 'puzzle-blocks', -0.2, 0.5],
];

const luma = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const sat = c => Math.max(...c) - Math.min(...c);
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const scaleTo = (c, l) => { const k = l / Math.max(1, luma(c)); return c.map(v => Math.max(0, Math.min(255, Math.round(v * k)))); };
const rgba = (c, a = 255) => [...c.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v)))), a];

/** Menu colors drawn from the scene: a dark tinted panel, a vivid accent, light text. */
export function interfaceColors(image) {
  const clusters = kmeans(pixelsOf(image), 8).sort((a, b) => luma(a) - luma(b));
  const dark = clusters[0], light = clusters[clusters.length - 1];
  const vivid = clusters.slice(2).reduce((a, b) => (sat(b) * (luma(b) > 70) > sat(a) * (luma(a) > 70) ? b : a));
  const panel = scaleTo(mix(dark, vivid, 0.15), 24);
  const accent = luma(vivid) < 120 ? scaleTo(vivid, 150) : vivid;
  const text = mix([248, 248, 250], light, 0.12);
  const highlight = scaleTo(mix(accent, panel, 0.35), 60);
  return [
    rgba(scaleTo(dark, 30)), rgba(panel, 176), rgba(mix(accent, [255, 255, 255], 0.35)), rgba(text),
    rgba(mix(text, panel, 0.4)), rgba(accent), rgba(highlight), rgba(scaleTo(panel, 36)), rgba(highlight),
    rgba(scaleTo(panel, 8)), rgba([120, 220, 150]), rgba([250, 190, 90]),
    rgba(dark), rgba(dark), rgba(dark), rgba(dark),
  ];
}

/**
 * Synthwave Grid cannot pan: sliding a perspective grid sideways moves its
 * vanishing point. Instead it stays put and the floor's horizontal lines
 * travel toward the viewer by color cycling. Floor pixels are indexed by
 * perspective depth; converging lines found in the image keep fixed colors.
 */
export function synthwaveIndexed(source) {
  const image = cover(source, 640, 480), { width: W, height: H, data } = image;
  const lum = (x, y) => { const i = (y * W + x) * 4; return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; };
  const rowMean = y => { let s = 0; for (let x = 0; x < W; x++) s += lum(x, y); return s / W; };
  // Horizon: the brightest row in the middle of the frame (the glowing seam).
  let horizon = 0, best = -1;
  for (let y = Math.floor(H * 0.45); y < H * 0.75; y++) { const m = rowMean(y); if (m > best) { best = m; horizon = y; } }
  const floorTop = horizon + 2;
  // Converging lines: luminance peaks along the darkest (line-free) floor row a
  // little below the horizon, where lines that later leave the sides still show.
  let refRow = horizon + 60, darkest = Infinity;
  for (let y = horizon + 40; y < horizon + 80; y++) { const m = rowMean(y); if (m < darkest) { darkest = m; refRow = y; } }
  const peaks = [], threshold = rowMean(refRow) + 30;
  for (let x = 2; x < W - 2; x++) {
    const l = lum(x, refRow);
    if (l > threshold && l >= lum(x - 1, refRow) && l > lum(x + 1, refRow) && l >= lum(x - 2, refRow) && l > lum(x + 2, refRow)) peaks.push(x);
  }
  const vx = W / 2, along = y => (y - horizon) / (refRow - horizon);
  const lineDistance = (x, y) => Math.min(...peaks.map(px => Math.abs(x - (vx + (px - vx) * along(y)))));
  // Colors from the image: line cyan from its brightest floor pixels, floor bases per depth band.
  const floorPixels = pixelsOf(image, (x, y) => y > floorTop).sort((a, b) => luma(a) - luma(b));
  const line = floorPixels[Math.floor(floorPixels.length * 0.995)];
  // Floor base runs smoothly from the horizon haze to the dark near floor.
  const sample = (y0, y1) => { const px = pixelsOf(image, (x, y) => y >= y0 && y < y1 && lineDistance(x, y) > 4).sort((p, q) => luma(p) - luma(q)); return px[Math.floor(px.length * 0.4)]; };
  const haze = sample(floorTop + 1, floorTop + 8), near = sample(H - 60, H);
  const baseAt = y => mix(haze, near, Math.pow(Math.min(1, (y - floorTop) / (H - floorTop)), 0.6));
  // Line phase in periods; about 40 px between lines at the bottom edge.
  const spacing = 40 / (H - horizon), phaseAt = y => (H - horizon) / (y - horizon) / spacing;
  // Soft line profile in line periods: a narrow core plus a faint glow.
  const profile = u => Math.min(1, Math.exp(-(u * u) / (2 * 0.044 * 0.044)) + 0.22 * Math.exp(-(u * u) / (2 * 0.14 * 0.14)));
  const circular = u => { u = ((u % 1) + 1) % 1; return Math.min(u, 1 - u); };
  /*
   * Mipmapped ramps: near the horizon a row spans much of a line period, so a
   * thin line would wink in and out as it cycles. Each row uses a ramp whose
   * profile is box-filtered over that row's footprint, so distant lines stay
   * visible as soft, low-contrast motion. Far levels use 16-entry ramps
   * stepped half as often (same speed, fewer colors); rows spanning nearly a
   * whole period are a flat haze.
   */
  const levels = [
    { entries: 32, ticks: 2, width: 1 / 32 }, { entries: 32, ticks: 2, width: 2 / 32 }, { entries: 32, ticks: 2, width: 4 / 32 },
    { entries: 16, ticks: 4, width: 4 / 16 }, { entries: 16, ticks: 4, width: 8 / 16 }, { entries: 16, ticks: 4, width: 12 / 16 },
  ];
  const levelRows = levels.map(() => []), flatRows = [], rowLevel = new Int16Array(H).fill(-1);
  for (let y = floorTop + 1; y < H; y++) {
    const footprint = Math.abs(phaseAt(y) - phaseAt(y + 1)), level = levels.findIndex(l => l.width >= footprint * 0.9);
    rowLevel[y] = level;
    (level < 0 ? flatRows : levelRows[level]).push(y);
  }
  const filtered = (w, u) => { let sum = 0; const n = 48; for (let k = 0; k < n; k++) sum += profile(circular(u - w / 2 + (k + 0.5) * w / n)); return sum / n; };
  const average = (() => { let sum = 0; for (let k = 0; k < 512; k++) sum += profile(circular(k / 512)); return sum / 512; })();
  const colors = [], ranges = [];
  levels.forEach((l, level) => {
    const rows = levelRows[level], start = colors.length;
    const base = rows.length ? baseAt(rows[Math.floor(rows.length / 2)]) : near;
    for (let j = 0; j < l.entries; j++) colors.push(consoleColor(base.map((v, c) => v + (line[c] - v) * filtered(l.width, j / l.entries))));
    ranges.push({ start, length: l.entries, stepTicks: l.ticks, flags: 3 });
  });
  // Rows too far away to resolve lines: a fixed haze gradient with the lines' average glow.
  const flatSteps = 4, flatStart = colors.length;
  for (let k = 0; k < flatSteps; k++) {
    const y = flatRows.length ? flatRows[Math.floor((k + 0.5) / flatSteps * flatRows.length)] : floorTop + 1;
    colors.push(consoleColor(baseAt(y).map((v, c) => v + (line[c] - v) * average)));
  }
  // Converging lines: five coverage levels over the mid floor color.
  const aaSteps = 5, aaStart = colors.length, aaBase = baseAt(Math.floor((floorTop + H) / 2));
  for (let k = 1; k <= aaSteps; k++) colors.push(consoleColor(aaBase.map((v, c) => v + (line[c] - v) * k / aaSteps)));
  // Stars twinkle; sky and mountains keep their own colors.
  const twinkle = 8, starStart = colors.length;
  for (let j = 0; j < twinkle; j++) { const k = 0.4 + 0.6 * Math.pow(0.5 + 0.5 * Math.cos((2 * Math.PI * j) / twinkle), 2); colors.push(consoleColor([255 * k, 236 * k, 255 * k])); }
  ranges.push({ start: starStart, length: twinkle, stepTicks: 10, flags: 2 });
  const star = (x, y) => y < horizon - 60 && x > 0 && x < W - 1 && y > 0 && lum(x, y) > 120
    && lum(x, y) - (lum(x - 1, y) + lum(x + 1, y) + lum(x, y - 1) + lum(x, y + 1)) / 4 > 35;
  const skyStart = colors.length;
  for (const c of kmeans(pixelsOf(image, (x, y) => y <= floorTop && !star(x, y)), 256 - skyStart)) colors.push(consoleColor(c));
  const indices = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (y > floorTop) {
      // Coverage of the converging line (and its glow) at this pixel.
      const d = lineDistance(x, y), half = 0.3 + 0.55 * along(y);
      // Lines thinner than a pixel near the vanishing point fade instead of breaking into dots.
      const coverage = Math.min(1, along(y) * 1.4) * Math.max(Math.min(1, Math.max(0, half + 0.5 - d)), 0.3 * Math.max(0, 1 - (d - half) / 2.5));
      const step = Math.round(coverage * aaSteps);
      if (step >= 1) { indices[p] = aaStart + step - 1; continue; }
      const level = rowLevel[y];
      if (level < 0) { indices[p] = flatStart + Math.min(flatSteps - 1, Math.floor(flatRows.indexOf(y) / flatRows.length * flatSteps)); continue; }
      const n = levels[level].entries;
      indices[p] = ranges[level].start + ((Math.round(phaseAt(y + 0.5) * n) % n) + n) % n;
    } else if (star(x, y)) indices[p] = starStart + ((x * 7 + y * 13) % twinkle);
    else indices[p] = nearestIndex(colors, skyStart, colors.length - skyStart, data.subarray(p * 4, p * 4 + 3));
  }
  return { image: indexImage(W, H, indices), colors, ranges, preview: image, lines: peaks.length, horizon };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await fs.mkdir(outPreview, { recursive: true });
  const only = process.argv.slice(2);
  for (const [name, stem, pan, focusY] of PANORAMAS) {
    if (only.length && !only.includes(stem)) continue;
    const file = path.join(sources, `${stem}-raw.jpg`);
    const source = await fs.readFile(file).then(b => decodePlate(new Uint8Array(b)), () => null);
    if (!source) { console.log(`${name}: no source yet`); continue; }
    const band = cover(source, 800, 384, focusY), seamBefore = horizontalSeam(band);
    const looped = wrapByRamp(band), indexed = quantizeIndexed(looped, 256);
    const theme = {
      name, family: 'Panorama', colors: interfaceColors(looped),
      background: { mode: 'static' }, staticLayout: { panX: pan, panY: 0 }, staticPalette: { ranges: [] },
      border: { source: 'internal', id: 8 },
    };
    const packed = packThemeImage(theme, { staticBackground: indexed.image, staticPalette: indexed.colors });
    await writeSdTheme(`${stem}.png`, packed.image);
    const parsed = parseThemeImage(packed.image);
    await fs.writeFile(path.join(outPreview, `${stem}.png`), encodePng(renderTheme(parsed, { time: 0 })));
    await fs.writeFile(path.join(outPreview, `${stem}-loop.png`), encodePng(colorizeIndexImage(indexed.image, indexed.colors)));
    console.log(`${name}: source seam ${seamBefore.toFixed(1)} -> ${horizontalSeam(looped).toFixed(1)}`);
  }
  if (!only.length || only.includes('synthwave-grid')) {
    const source = decodePlate(new Uint8Array(await fs.readFile(path.join(sources, 'synthwave-grid-raw.jpg'))));
    const synth = synthwaveIndexed(source);
    const theme = {
      name: 'Synthwave Grid', family: 'Panorama', colors: interfaceColors(synth.preview),
      background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges: synth.ranges },
      border: { source: 'internal', id: 8 },
    };
    const packed = packThemeImage(theme, { staticBackground: synth.image, staticPalette: synth.colors });
    await writeSdTheme('synthwave-grid.png', packed.image);
    const parsed = parseThemeImage(packed.image);
    for (const t of [0, 0.4]) await fs.writeFile(path.join(outPreview, `synthwave-grid-t${t}.png`), encodePng(renderTheme(parsed, { time: t, ui: false })));
    console.log(`Synthwave Grid: horizon ${synth.horizon}, ${synth.lines} converging lines, ${synth.colors.length} colors`);
  }
}
