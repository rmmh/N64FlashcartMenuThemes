#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/png-node.mjs';
import { decodePlate } from './decode-plate.mjs';
import { cropImage } from '../src/utils.mjs';
import { resizeImage } from '../src/tile-tools.mjs';
import { cover } from '../src/palette-tools.mjs';
import { packThemeImage, parseThemeImage } from '../src/theme.mjs';
import { renderTheme } from '../src/renderer.mjs';
import { interfaceColors } from './build-panoramas.mjs';
import { compileFrameCycling } from './frame-cycling.mjs';
import { fixedRadarLayers, contactBrightness, crispSweepRamps, causalContactRamp, contactAtPixel } from './radar-layers.mjs';
import { writeSdTheme } from './theme-output.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'assets/cycling-sources');
const readImage = async name => decodePlate(new Uint8Array(await fs.readFile(path.join(sources, name))));

/** Register source artwork and interpolate its sweep motion before palette fitting. */
export function radarFrames(panel, sheet, timeline, count = timeline.frameCount ?? 16) {
  const { columns, rows, cellInset: inset, keyframes, scope } = timeline;
  if (!keyframes.length || keyframes[0].angle !== 0 ||
      keyframes.some((k, i) => !Number.isInteger(k.cell) || k.cell < 0 || k.cell >= columns * rows ||
        k.angle < 0 || k.angle >= 360 || (i && k.angle <= keyframes[i - 1].angle)))
    throw new Error('radar keyframes must start at 0 and have increasing angles and valid cells');
  const size = scope.radius * 2;
  const cells = keyframes.map(({ cell }) => {
    const x = Math.round((cell % columns) * sheet.width / columns);
    const y = Math.round(Math.floor(cell / columns) * sheet.height / rows);
    const w = Math.round((cell % columns + 1) * sheet.width / columns) - x;
    const h = Math.round((Math.floor(cell / columns) + 1) * sheet.height / rows) - y;
    return resizeImage(cropImage(sheet, [x + inset, y + inset, w - 2 * inset, h - 2 * inset]), size, size);
  });
  // A temporal median freezes glass, rings, and texture despite registration
  // differences in the generated cells. A minimum wrongly treats that texture
  // as moving light. Extract light only inside each annotated source beam.
  const base = new Float32Array(size * size * 3);
  for (let p = 0; p < size * size; p++) for (let c = 0; c < 3; c++)
    base[p * 3 + c] = cells.map(f => f.data[p * 4 + c]).sort((a, b) => a - b)[Math.floor((cells.length - 1) / 2)];
  const contactWeight = (x, y) => {
    let w = 0;
    for (const [cx, cy] of timeline.contacts ?? []) {
      const r = Math.hypot(x + .5 - scope.radius * (1 + cx), y + .5 - scope.radius * (1 + cy));
      w = Math.max(w, Math.max(0, Math.min(1, (14 - r) / 4)));
    }
    return w;
  };
  const contactMask = Float32Array.from({ length: size * size }, (_, p) => contactWeight(p % size, Math.floor(p / size)));
  const sampleRgb = (f, x, y, c) => {
    const xx = Math.max(0, Math.min(size - 1, Math.round(x)));
    const yy = Math.max(0, Math.min(size - 1, Math.round(y)));
    const p = yy * size + xx;
    return { value: Math.max(0, f.data[p * 4 + c] - base[p * 3 + c]), contact: contactMask[p] };
  };
  // Robust radial sampling extracts the generated beam's angular glow rather
  // than transporting individual shapes. Small blips, their halos, and grid
  // registration errors are outliers and cannot become rotating echoes.
  const profiles = timeline.extractBeamProfile ? cells.map(f => {
    const profile = new Float32Array(720 * 3);
    for (let a = 0; a < 720; a++) {
      const bearing = a * Math.PI / 360;
      for (let c = 0; c < 3; c++) {
        const samples = [];
        for (let j = 0; j < 31; j++) {
          const r = scope.radius * (.25 + .65 * j / 30);
          const s = sampleRgb(f, scope.radius - .5 + r * Math.sin(bearing), scope.radius - .5 - r * Math.cos(bearing), c);
          if (s.contact === 0) samples.push(s.value);
        }
        samples.sort((a, b) => a - b);
        profile[a * 3 + c] = samples[Math.floor(samples.length / 2)] ?? 0;
      }
    }
    return profile;
  }) : null;
  const beamLights = cells.map((f, i) => {
    const light = new Float32Array(size * size * 3);
    for (let p = 0; p < size * size; p++) {
      const dx = p % size + .5 - scope.radius, dy = Math.floor(p / size) + .5 - scope.radius;
      const bearing = Math.atan2(dx, -dy) * 180 / Math.PI;
      const behind = ((keyframes[i].angle - bearing + 360) % 360 + 360) % 360;
      // A little allowance ahead accounts for subpixel source registration.
      if (timeline.beamTailDegrees !== undefined && behind > timeline.beamTailDegrees && behind < 357) continue;
      const at = ((bearing * 2 % 720) + 720) % 720, lo = Math.floor(at), hi = (lo + 1) % 720, w = at - lo;
      for (let c = 0; c < 3; c++) light[p * 3 + c] = profiles ?
        profiles[i][lo * 3 + c] * (1 - w) + profiles[i][hi * 3 + c] * w :
        Math.max(0, f.data[p * 4 + c] - base[p * 3 + c]) * (1 - contactMask[p]);
    }
    return light;
  });
  const sampleLight = (light, x, y, c) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    let v = 0;
    for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
      const xx = x0 + dx, yy = y0 + dy;
      if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
      const p = yy * size + xx;
      v += light[p * 3 + c] * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
    }
    return v;
  };
  const layers = fixedRadarLayers(cells, keyframes, base, profiles, timeline, size);
  const stationaryImage = { ...panel, data: new Uint8ClampedArray(panel.data) };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (Math.hypot(x + .5 - scope.radius, y + .5 - scope.radius) >= scope.radius) continue;
    const p = ((y + scope.centerY - scope.radius) * panel.width + x + scope.centerX - scope.radius) * 4;
    for (let c = 0; c < 3; c++) stationaryImage.data[p + c] = base[(y * size + x) * 3 + c] +
      (timeline.cloudGain ? Math.max(0, layers.cloud[y * size + x] - .65) * [2, 16, 4][c] : 0);
  }
  const frames = Array.from({ length: count }, (_, t) => {
    const angle = t * 360 / count;
    let at = keyframes.findLastIndex(k => k.angle <= angle);
    const next = (at + 1) % keyframes.length;
    const weight = (angle - keyframes[at].angle) / ((next ? keyframes[next].angle : 360) - keyframes[at].angle);
    const rotations = [keyframes[at].angle - angle, (next ? keyframes[next].angle : 360) - angle]
      .map(a => [Math.cos(a * Math.PI / 180), Math.sin(a * Math.PI / 180)]);
    const out = { ...panel, data: new Uint8ClampedArray(panel.data) };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (Math.hypot(x + .5 - scope.radius, y + .5 - scope.radius) >= scope.radius) continue;
      const q = (y * size + x) * 4;
      const p = ((y + scope.centerY - scope.radius) * panel.width + x + scope.centerX - scope.radius) * 4;
      for (let c = 0; c < 3; c++) {
        if (!timeline.motionCompensated) {
          out.data[p + c] = cells[at].data[q + c] * (1 - weight) + cells[next].data[q + c] * weight;
          continue;
        }
        const stationary = base[(y * size + x) * 3 + c];
        const dx = x + .5 - scope.radius, dy = y + .5 - scope.radius;
        const light = rotations.map(([co, si], i) => sampleLight(beamLights[i ? next : at],
          dx * co - dy * si + scope.radius - .5, dx * si + dy * co + scope.radius - .5, c));
        const cw = contactMask[y * size + x];
        const contact = Math.max(0, cells[at].data[q + c] * (1 - weight) + cells[next].data[q + c] * weight - stationary);
        const moving = (light[0] * (1 - weight) + light[1] * weight) * layers.cloud[y * size + x];
        let fixedContact = 0;
        for (const s of layers.contacts) {
          const sx = x - s.x + s.radius, sy = y - s.y + s.radius, side = s.radius * 2 + 1;
          if (sx >= 0 && sy >= 0 && sx < side && sy < side)
            fixedContact += s.sprite[(sy * side + sx) * 3 + c] * contactBrightness(s, angle, timeline, count);
        }
        const glow = layers.contacts.length ? moving + fixedContact : moving * (1 - cw) + contact * cw;
        const cloudBase = timeline.cloudGain ? Math.max(0, layers.cloud[y * size + x] - .65) * [2, 16, 4][c] : 0;
        out.data[p + c] = stationary + cloudBase + (timeline.phosphorGain ?? 1) * glow;
      }
    }
    return out;
  });
  frames.contacts = layers.contacts.map(s => ({ x: s.x + scope.centerX - scope.radius,
    y: s.y + scope.centerY - scope.radius, radius: s.radius, opacity: s.opacity }));
  frames.stationaryImage = stationaryImage;
  frames.cloud = layers.cloud;
  return frames;
}

export async function buildRadarSweep() {
  const [raw, sheet, timeline] = await Promise.all([
    readImage('radar-sweep-raw.jpg'), readImage('radar-sweep-frames.png'),
    fs.readFile(path.join(sources, 'radar-sweep-timeline.json'), 'utf8').then(JSON.parse),
  ]);
  const frames = radarFrames(cover(raw, 640, 480), sheet, timeline);
  const contactAt = p => contactAtPixel(frames.contacts, p % 640, Math.floor(p / 640), 640);
  const bearing = (x, y) => (Math.atan2(x + .5 - timeline.scope.centerX, timeline.scope.centerY - y - .5) * 180 / Math.PI + 360) % 360;
  let sweepBackground;
  const indexed = compileFrameCycling(frames, { clusters: 3, stepTicks: timeline.stepTicks, threshold: 12,
    groupClusters: [2, 1], groupFrameCounts: [96, 32],
    groupForPixel: p => contactAt(p) ? 1 : 0,
    phaseForPixel: (p, group, length) => {
      if (!group) return Math.ceil(bearing(p % 640, Math.floor(p / 640)) / 360 * length) % length;
      const s = contactAt(p);
      return (Math.ceil(bearing(s.x, s.y) / 360 * length) + 1) % length;
    },
    transformCenters: (centers, group) => {
      if (!group) {
        crispSweepRamps(centers, timeline.beamTailDegrees);
        sweepBackground = Array.from(centers[0].subarray(3, 6));
      } else causalContactRamp(centers, timeline.contactPaletteStepTicks, timeline.contactHoldTicks, timeline.contactFadeTicks, sweepBackground);
    },
    forceFixed: p => !contactAt(p) && frames.stationaryImage.data[p * 4 + 1] > 32,
    fixedColorForPixel: p => frames.stationaryImage.data.subarray(p * 4, p * 4 + 3),
    centerForPixel: (p, group, allowed) => {
      if (group) return allowed[0];
      const q = bearing(p % 640, Math.floor(p / 640)) / 360 * 96;
      const x = p % 640 - timeline.scope.centerX + timeline.scope.radius;
      const y = Math.floor(p / 640) - timeline.scope.centerY + timeline.scope.radius;
      const cloud = frames.cloud[y * timeline.scope.radius * 2 + x] ?? 1;
      const fraction = Math.max(0, Math.min(1, Math.ceil(q) - q + (cloud - 1) * .35));
      let hash = Math.imul(p + 1, 0x7feb352d);
      hash = Math.imul(hash ^ (hash >>> 16), 0x846ca68b);
      return allowed[((hash ^ (hash >>> 16)) >>> 0) / 4294967296 < fraction ? 1 : 0];
    },
  });
  const colors = interfaceColors(frames[0]);
  // The phosphor green is the menu accent; lower panel opacity reveals the sweep.
  colors[1] = [3, 18, 10, 112];
  colors[2] = [140, 232, 158, 255];
  colors[5] = [102, 238, 138, 255];
  colors[6] = [18, 64, 34, 176];
  const theme = {
    name: 'Radar Sweep', family: 'Cycling', colors, background: { mode: 'static' },
    staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges: indexed.ranges },
    border: { source: 'internal', id: 8 },
  };
  const packed = packThemeImage(theme, { staticBackground: indexed.image, staticPalette: indexed.colors });
  await writeSdTheme('radar-sweep.png', packed.image);
  const parsed = parseThemeImage(packed.image), preview = path.join(root, 'out/previews/cycling');
  await fs.mkdir(preview, { recursive: true });
  await fs.writeFile(path.join(preview, 'radar-sweep.png'), encodePng(renderTheme(parsed)));
  // Both strips use the same timings, so reconstruction errors are easy to compare.
  for (const kind of ['reference', 'compiled']) {
    const count = Math.min(frames.length, 32), stride = frames.length / count;
    const rows = Math.ceil(count / 4);
    const strip = { width: 640 * 4, height: 480 * rows, data: new Uint8ClampedArray(640 * 4 * 480 * rows * 4) };
    for (let i = 0; i < count; i++) {
      const t = i * stride;
      const frame = kind === 'reference' ? frames[t] : renderTheme(parsed, { time: t * timeline.stepTicks / 60, ui: false });
      for (let y = 0; y < 480; y++) strip.data.set(frame.data.subarray(y * 640 * 4, (y + 1) * 640 * 4),
        (((i >> 2) * 480 + y) * strip.width + (i % 4) * 640) * 4);
    }
    await fs.writeFile(path.join(preview, `radar-sweep-${kind}.png`), encodePng(strip));
  }
  await fs.writeFile(path.join(preview, 'radar-sweep-report.json'), JSON.stringify(indexed.report, null, 2) + '\n');
  console.log('Radar Sweep:', indexed.report);
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildRadarSweep();
