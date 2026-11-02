#!/usr/bin/env node
// Builds the Particle family: a looping panorama (as in build-panoramas.mjs)
// with an animated particle overlay drawn over it. Scenes and particle sheets
// are image-generated (assets/particle-sources/, prompts alongside).
// Velocities follow the console: positive moves particles right/down, in
// units of 8 texels per nominal frame; overlays are drawn 1:1 so particles at
// least two texels wide stay steady under bilinear filtering.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSdTheme } from './theme-output.mjs';
import { encodePng } from '../src/png-node.mjs';
import { decodePlate } from './decode-plate.mjs';
import { packThemeImage, parseThemeImage } from '../src/theme.mjs';
import { renderTheme } from '../src/renderer.mjs';
import { makeTile, tilePreview } from '../src/tile-tools.mjs';
import { cover, wrapByRamp, quantizeIndexed } from '../src/palette-tools.mjs';
import { interfaceColors } from './build-panoramas.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'assets/particle-sources');
const outPreview = path.join(root, 'out/previews/particles');

/*
 * name, scene, particle sheet, and particle settings:
 *   speed [x, y]   motion; with `along`, the y speed is applied along the streak angle
 *   scale          overlay scale; 0.5 doubles the repeat period for large particles
 *   crop           fraction of the sheet cropped before shrinking to 64x64 (smaller = bigger particles)
 *   cover          fraction of texels that become particles (sets the brightness threshold)
 *   wind           sideways gust amplitude (animated X velocity), or 0
 *   pulse          [min, max] animated overlay alpha, or null
 */
export const PARTICLES = [
  ['Firefly Dusk', 'firefly-dusk', 'p-fireflies', { speed: [0.01, -0.02], crop: 0.3, cover: 0.012, wind: 0.015, pulse: [90, 255] }],
  ['Petal Park', 'petal-park', 'p-petals', { speed: [0.04, 0.05], scale: 0.5, crop: 0.9, cover: 0.05, wind: 0.025, alpha: 230 }],
  ['Leaf Road', 'leaf-road', 'p-leaves', { speed: [0.025, 0.06], scale: 0.5, crop: 0.8, cover: 0.06, wind: 0.025, alpha: 240 }],
  ['Bubble Reef', 'bubble-reef', 'p-bubbles', { speed: [0, -0.2], crop: 0.45, cover: 0.03, wind: 0.02, alpha: 190 }],
  ['Dusty Library', 'dusty-library', 'p-dust', { speed: [0.008, -0.006], crop: 0.3, cover: 0.025, wind: 0.008, pulse: [80, 220] }],
  ['Night Carnival', 'night-carnival', 'p-confetti', { speed: [0.01, 0.08], scale: 0.5, crop: 0.9, cover: 0.05, wind: 0.025, alpha: 255 }],
  ['Spore Swamp', 'spore-swamp', 'p-spores', { speed: [0.01, -0.05], crop: 0.5, cover: 0.015, wind: 0.015, pulse: [100, 255] }],
  ['Lantern Lake', 'lantern-lake', 'p-lanterns', { speed: [0.005, -0.035], scale: 0.5, crop: 0.8, cover: 0.03, wind: 0.005, alpha: 255 }],
];

/** Dominant streak direction (unit vector, pointing down) from the luma structure tensor. */
function streakDirection(image) {
  const { width: w, height: h, data } = image, l = (x, y) => { const i = (y * w + x) * 4; return data[i] + data[i + 1] + data[i + 2]; };
  let xx = 0, yy = 0, xy = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const gx = l(x + 1, y) - l(x - 1, y), gy = l(x, y + 1) - l(x, y - 1);
    xx += gx * gx; yy += gy * gy; xy += gx * gy;
  }
  // Gradients cross a streak; the streak runs along the eigenvector of the smaller eigenvalue.
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy) + Math.PI / 2;
  let dx = Math.cos(angle), dy = Math.sin(angle);
  if (dy < 0 || (Math.abs(dy) < 1e-6 && dx < 0)) { dx = -dx; dy = -dy; }
  return [dx, dy];
}

/** Remove isolated single-texel particles, which shimmer when they move. */
function despeckle(image) {
  const d = image.data, w = image.width, h = image.height, opaque = (x, y) => d[(((y + h) % h) * w + ((x + w) % w)) * 4 + 3] > 0;
  const lone = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    if (opaque(x, y) && !opaque(x - 1, y) && !opaque(x + 1, y) && !opaque(x, y - 1) && !opaque(x, y + 1)) lone.push((y * w + x) * 4);
  for (const i of lone) d[i + 3] = 0;
  return image;
}

/*
 * Shrinking a bright particle on black averages it with the background, so
 * its opaque texels come out dim. Glowing particles are lifted to full
 * brightness at their own hue; solid objects only lose their dark fringes.
 */
const OBJECTS = new Set(['p-petals', 'p-leaves', 'p-confetti', 'p-lanterns']);
function brighten(image, glowing) {
  const d = image.data, texels = [];
  for (let i = 0; i < d.length; i += 4) if (d[i + 3]) texels.push(i);
  const luma = i => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  if (glowing) {
    for (const i of texels) {
      const m = Math.max(d[i], d[i + 1], d[i + 2], 1);
      for (let c = 0; c < 3; c++) d[i + c] = Math.round(d[i + c] * 255 / m);
    }
    return image;
  }
  const sorted = [...texels].sort((a, b) => luma(a) - luma(b)), typical = sorted[Math.floor(sorted.length * 0.75)];
  if (typical === undefined) return image;
  const color = [d[typical], d[typical + 1], d[typical + 2]], floor = luma(typical) * 0.55;
  for (const i of texels) if (luma(i) < floor) d.set(color, i);
  return image;
}

const f32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return b; };

/** Eight interpolated keys: wind gusts on layer-0 X velocity and/or a glow pulse on its alpha. */
function particleAnimation(settings, vx) {
  const gusts = [0.2, 1, 0.4, -0.6, -0.2, 0.7, 1.2, 0.1], glow = [0, 0.6, 1, 0.7, 0.3, 0.9, 0.5, 0.15];
  const wind = !!settings.wind, pulse = !!settings.pulse;
  if (!wind && !pulse) return null;
  const frames = gusts.map((g, i) => {
    const parts = [];
    if (wind) parts.push(f32(vx + settings.wind * g));
    if (pulse) parts.push(new Uint8Array([Math.round(settings.pulse[0] + (settings.pulse[1] - settings.pulse[0]) * glow[i])]));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  });
  return { mask: (wind ? 1 << 20 : 0) | (pulse ? 1 << 25 : 0), animation: { frameCount: 8, columns: 8, frameTicks: 100, flags: 8 }, frames };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await fs.mkdir(outPreview, { recursive: true });
  const only = process.argv.slice(2);
  const read = async name => fs.readFile(path.join(sources, name)).then(b => decodePlate(new Uint8Array(b)), () => null);
  for (const [name, sceneStem, particleStem, settings] of PARTICLES) {
    if (only.length && !only.includes(sceneStem)) continue;
    const scene = await read(`${sceneStem}-raw.jpg`), sheet = await read(`${particleStem}-raw.jpg`);
    if (!scene || !sheet) { console.log(`${name}: sources missing`); continue; }
    const looped = wrapByRamp(cover(scene, 800, 384, 0.5)), indexed = quantizeIndexed(looped, 256);
    // Pick the brightness threshold that turns the requested share of texels
    // into particles: thin streaks and soft glows are dim once shrunk.
    const plain = makeTile(sheet, { width: 64, height: 64, cropScale: settings.crop }).periodic;
    const lumas = []; for (let i = 0; i < plain.data.length; i += 4) lumas.push((0.2126 * plain.data[i] + 0.7152 * plain.data[i + 1] + 0.0722 * plain.data[i + 2]) / 255);
    lumas.sort((a, b) => a - b);
    const threshold = Math.max(0.08, lumas[Math.floor(lumas.length * (1 - settings.cover))]);
    const tile = makeTile(sheet, { width: 64, height: 64, alphaLuma: threshold, cropScale: settings.crop });
    despeckle(tile.image);
    brighten(tile.image, !OBJECTS.has(particleStem));
    let [vx, vy] = settings.speed;
    if (settings.along) { const [dx, dy] = streakDirection(tile.image); vx = dx * vy; vy = dy * vy; }
    const theme = {
      name, family: 'Particle', colors: interfaceColors(looped),
      background: { mode: 'static', overlay: true, scale: settings.scale ?? 1, velocityX: vx, velocityY: vy, rotation: 0, alpha: settings.alpha ?? 255 },
      staticLayout: { panX: -0.15, panY: 0 }, staticPalette: { ranges: [] },
      parameterAnimation: particleAnimation(settings, vx),
      border: { source: 'internal', id: 8 },
    };
    const packed = packThemeImage(theme, { staticBackground: indexed.image, staticPalette: indexed.colors, layer0: tile.image });
    await writeSdTheme(`${sceneStem}.png`, packed.image);
    const parsed = parseThemeImage(packed.image);
    await fs.writeFile(path.join(outPreview, `${sceneStem}.png`), encodePng(renderTheme(parsed, { time: 1, ui: false })));
    await fs.writeFile(path.join(outPreview, `${particleStem}-3x3.png`), encodePng(tilePreview(tile.image)));
    let opaque = 0; for (let i = 3; i < tile.image.data.length; i += 4) opaque += tile.image.data[i] > 0;
    console.log(`${name}: velocity ${vx.toFixed(3)},${vy.toFixed(3)}, ${opaque} particle texels`);
  }
}
