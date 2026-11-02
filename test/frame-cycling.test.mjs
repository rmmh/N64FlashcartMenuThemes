import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFrameCycling } from '../tools/frame-cycling.mjs';
import { consoleColor, colorizeIndexImage } from '../src/palette-tools.mjs';
import { cycledStaticPalette } from '../src/animation.mjs';
import { radarFrames } from '../tools/build-radar-sweep.mjs';
import { fixedRadarLayers, contactBrightness } from '../tools/radar-layers.mjs';
import { decodePng } from '../src/png-node.mjs';
import { packThemeImage, parseThemeImage } from '../src/theme.mjs';
import { renderTheme } from '../src/renderer.mjs';
import fs from 'node:fs/promises';

const image = colors => ({ width: colors.length, height: 1, data: new Uint8ClampedArray(colors.flat()) });
const radarContacts = [[223, 121], [383, 137], [419, 301], [256, 288]];

test('frame histories reproduce independent sweep and contact phases with a fixed panel', () => {
  const beam = [[99, 231, 66, 255], [33, 99, 33, 255], [8, 33, 8, 255], [0, 8, 0, 255]];
  const contact = [[198, 255, 165, 255], [66, 165, 49, 255], [16, 66, 16, 255], [0, 8, 0, 255]];
  const fixed = [41, 16, 8, 255];
  const frames = Array.from({ length: 4 }, (_, t) => image([
    beam[(4 - t) % 4], beam[(5 - t) % 4], contact[(6 - t) % 4], fixed,
  ]));
  const compiled = compileFrameCycling(frames, { clusters: 2, stepTicks: 12 });
  assert.equal(compiled.ranges.length, 2);
  for (let t = 0; t < 4; t++) {
    const palette = cycledStaticPalette(compiled.colors, compiled, t * 12 / 60);
    const actual = colorizeIndexImage(compiled.image, palette);
    assert.deepEqual(actual.data, new Uint8ClampedArray(
      Array.from({ length: 4 }, (_, p) => consoleColor(Array.from(frames[t].data.subarray(p * 4, p * 4 + 3)))).flat()));
  }
  assert.deepEqual(cycledStaticPalette(compiled.colors, compiled, 0),
    cycledStaticPalette(compiled.colors, compiled, compiled.report.cycleSeconds));
});

test('frame compiler rejects inconsistent sizes and impossible palette budgets', () => {
  assert.throws(() => compileFrameCycling([]), /frames/);
  assert.throws(() => compileFrameCycling([image([[0, 0, 0, 255]]), image([[0, 0, 0, 255], [1, 1, 1, 255]])]), /dimensions/);
  const frames = Array.from({ length: 16 }, () => image([[0, 0, 0, 255]]));
  assert.throws(() => compileFrameCycling(frames, { clusters: 16 }), /budget/);
  assert.throws(() => compileFrameCycling(frames, { stepTicks: 0 }), /stepTicks/);
  assert.throws(() => compileFrameCycling(frames), /no changing pixels/);
});

test('radar timeline interpolates supplied cells in authored order, including wrap', () => {
  const panel = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) };
  const sheet = { width: 6, height: 2, data: new Uint8ClampedArray(48) };
  // Source cell order is deliberately reversed.
  for (let y = 0; y < 2; y++) for (let x = 0; x < 6; x++) sheet.data.set([[120, 0, 0, 255], [0, 0, 0, 255], [240, 0, 0, 255]][x >> 1], (y * 6 + x) * 4);
  const timeline = { columns: 3, rows: 1, cellInset: 0, scope: { centerX: 2, centerY: 2, radius: 1 },
    keyframes: [{ cell: 1, angle: 0 }, { cell: 0, angle: 120 }, { cell: 2, angle: 240 }] };
  const frames = radarFrames(panel, sheet, timeline, 6);
  assert.deepEqual(frames.map(f => f.data[20]), [0, 60, 120, 180, 240, 120]);
  assert.ok(frames.every(f => f.data[0] === 255), 'surrounding panel stays fixed');
  assert.throws(() => radarFrames(panel, sheet, { ...timeline, keyframes: [...timeline.keyframes].reverse() }), /increasing/);
});

test('radar motion interpolation transports source light between beam positions', () => {
  const panel = { width: 10, height: 10, data: new Uint8ClampedArray(400) };
  const sheet = { width: 20, height: 10, data: new Uint8ClampedArray(800) };
  for (let y = 1; y <= 2; y++) for (let x = 4; x <= 5; x++) sheet.data.set([150, 150, 150, 255], (y * 20 + x) * 4);
  for (let y = 4; y <= 5; y++) for (let x = 7; x <= 8; x++) sheet.data.set([150, 150, 150, 255], (y * 20 + x + 10) * 4);
  const timeline = { columns: 2, rows: 1, cellInset: 0, scope: { centerX: 5, centerY: 5, radius: 5 },
    keyframes: [{ cell: 0, angle: 0 }, { cell: 1, angle: 90 }], motionCompensated: true };
  const frames = radarFrames(panel, sheet, timeline, 8);
  const middle = (2 * 10 + 7) * 4;
  assert.ok(frames[1].data[middle] > 100, '45-degree frame has transported light at the intermediate position');
  const faded = radarFrames(panel, sheet, { ...timeline, motionCompensated: false }, 8);
  assert.equal(faded[1].data[middle], 0, 'ordinary crossfade leaves the intermediate beam position dark');
});

test('source texture changes outside the beam are excluded from interpolation', () => {
  const panel = { width: 10, height: 10, data: new Uint8ClampedArray(400) };
  const sheet = { width: 30, height: 10, data: new Uint8ClampedArray(1200) };
  // One generated cell has a spurious bright spot opposite its beam. It must
  // never turn into a rotating spot elsewhere in the reconstructed frames.
  sheet.data.set([200, 200, 200, 255], (8 * 30 + 4) * 4);
  const timeline = { columns: 3, rows: 1, cellInset: 0,
    scope: { centerX: 5, centerY: 5, radius: 5 }, motionCompensated: true, beamTailDegrees: 65,
    keyframes: [{ cell: 0, angle: 0 }, { cell: 1, angle: 120 }, { cell: 2, angle: 240 }] };
  assert.ok(radarFrames(panel, sheet, timeline, 32).every(f => f.data.every(v => v === 0)));
  sheet.data.fill(0);
  // A small halo inside the beam but outside the known contact masks is also
  // rejected by radial-profile extraction, rather than copied around the disk.
  sheet.data.set([200, 200, 200, 255], (1 * 30 + 4) * 4);
  assert.ok(radarFrames(panel, sheet, { ...timeline, extractBeamProfile: true }, 32)
    .every(f => f.data.every(v => v === 0)));
});

test('shifted contact drawings become one fixed sprite with brightness-only keyframes', () => {
  const size = 80, cells = [180, 80, 0].map((v, i) => {
    const data = new Uint8ClampedArray(size * size * 4);
    if (v) data.set([v, v, v, 255], ((40 + i * 3) * size + 40 - i * 3) * 4);
    return { width: size, height: size, data };
  });
  const base = new Float32Array(size * size * 3);
  const result = fixedRadarLayers(cells, [{ cell: 0 }, { cell: 1 }, { cell: 2 }], base, null,
    { contactSprites: [{ x: 0, y: 0, cell: 0 }] }, size);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].x, 40);
  assert.equal(result.contacts[0].y, 40);
  assert.ok(result.contacts[0].sprite.some(v => v > 0));
  assert.equal(result.contacts[0].levels[0], 1);
  assert.ok(result.contacts[0].levels[1] > result.contacts[0].levels[2]);
});

test('contacts stay dark before the beam, then linger and fade before the next sweep', () => {
  const timeline = { scope: { radius: 100 }, stepTicks: 6, contactHoldTicks: 6, contactFadeTicks: 72 };
  const contact = { x: 149.5, y: 99.5 }; // 90 degrees, exactly east.
  const at = seconds => contactBrightness(contact, 90 + seconds / 3.2 * 360, timeline, 32);
  assert.equal(at(-.1), 0);
  assert.equal(at(0), 0);
  assert.equal(at(.05), 0, 'blending guard keeps pre-crossing palette entry dark');
  assert.equal(at(.15), 1);
  assert.ok(at(.6) > .15, 'contact remains visible well after the beam has passed');
  assert.ok(at(.6) > at(1.1));
  assert.equal(at(1.5), 0);
  assert.equal(at(3.15), 0);
});

test('radar package loops, keeps console stationary, and survives canonical packing', async () => {
  const png = await fs.readFile(new URL('../assets/themes/radar-sweep.png', import.meta.url));
  const theme = parseThemeImage(decodePng(new Uint8Array(png)));
  assert.equal(theme.staticPalette.ranges.length, 3);
  assert.deepEqual(theme.staticPalette.ranges.map(r => [r.length, r.stepTicks, r.flags]), [[96, 2, 2], [96, 2, 2], [32, 6, 2]]);
  assert.equal(theme.artwork.staticPalette.length, 256);
  const [beam0, beam1] = theme.staticPalette.ranges;
  assert.deepEqual(theme.artwork.staticPalette[beam0.start], theme.artwork.staticPalette[beam1.start], 'all beam variants have the same undithered head');
  for (let j = 1; j < 75; j++) assert.deepEqual(theme.artwork.staticPalette[beam0.start + j], theme.artwork.staticPalette[beam1.start + j], 'dithering must not extend onto the leading side');
  const indices = theme.artwork.staticBackground;
  for (let y = 40; y < 385; y += 7) for (let x = 145; x < 495; x += 7) {
    const value = indices.data[(y * 640 + x) * 4];
    if (value >= 192) continue; // Stationary artwork and contact sprites.
    const bearing = (Math.atan2(x + .5 - 320, 213 - y - .5) * 180 / Math.PI + 360) % 360;
    assert.equal(value % 96, Math.ceil(bearing / 360 * 96) % 96, 'leading boundary must be one straight ray, with no scattered phases');
  }
  const first = renderTheme(theme, { ui: false });
  assert.deepEqual(renderTheme(theme, { time: 3.2, ui: false }).data, first.data);
  const later = renderTheme(theme, { time: .8, ui: false });
  assert.notDeepEqual(later.data, first.data);
  for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) {
    if (Math.hypot(x + .5 - 320, y + .5 - 213) < 186) continue;
    const p = (y * 640 + x) * 4;
    assert.deepEqual(later.data.subarray(p, p + 4), first.data.subarray(p, p + 4));
  }
  const repacked = packThemeImage(theme, theme.artwork);
  assert.deepEqual(renderTheme(parseThemeImage(repacked.image), { time: .8, ui: false }).data, later.data);
  const frames = Array.from({ length: 32 }, (_, t) => renderTheme(theme, { time: t * .1, ui: false }));
  const contacts = radarContacts;
  for (let y = 45; y < 385; y += 15) for (let x = 150; x < 490; x += 15) {
    const dx = x - 320, dy = y - 213, radius = Math.hypot(dx, dy);
    if (radius < 35 || radius > 170 || contacts.some(([cx, cy]) => Math.hypot(x - cx, y - cy) < 20)) continue;
    const bearing = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    const green = frames.map((f, t) => ({ behind: (t * 11.25 - bearing + 360) % 360, v: f.data[(y * 640 + x) * 4 + 1] }))
      .filter(s => s.behind > 100 && s.behind < 260).map(s => s.v);
    assert.equal(Math.max(...green) - Math.min(...green), 0, 'rear of scope must not swirl or pulse');
  }
  for (const [x, y] of radarContacts) {
    const radius = Math.hypot(x + .5 - 320, y + .5 - 213);
    assert.ok([46, 81, 116, 151, 183].every(r => Math.abs(radius - r) > 14), 'contact and halo must clear the range rings');
    let active = 0, missing = 0, core = 0, coreSize = 0, halo = 0, haloSize = 0;
    for (let dy = -9; dy <= 9; dy++) for (let dx = -9; dx <= 9; dx++) {
      if (Math.hypot(dx, dy) > 9) continue;
      const value = indices.data[((y + dy) * 640 + x + dx) * 4];
      const lit = value >= 192 && value < 224;
      if (lit) active++; else missing++;
      if (Math.hypot(dx, dy) <= 3) { coreSize++; if (lit) core++; }
      if (Math.hypot(dx, dy) >= 6) { haloSize++; if (lit) halo++; }
    }
    assert.ok(active > 8 && missing > 40, 'contact uses a varied core and halo rather than a filled disk');
    assert.ok(core / coreSize > halo / haloSize, 'contact core is denser than its soft halo');
    const bearing = (Math.atan2(x + .5 - 320, 213 - y - .5) * 180 / Math.PI + 360) % 360;
    const at = offset => {
      const time = ((bearing / 360 * 3.2 + offset) % 3.2 + 3.2) % 3.2;
      const f = renderTheme(theme, { time, ui: false }), p = (y * 640 + x) * 4;
      return Array.from(f.data.subarray(p, p + 3));
    };
    for (const offset of [-.2, -.15, -.05, -.01])
      assert.deepEqual(at(offset), theme.artwork.staticPalette[beam0.start + 1].slice(0, 3), 'contact is indistinguishable from unlit scope before the beam');
    assert.deepEqual(at(-.15), at(1.5), 'actual blended palette keeps contacts dark before the beam');
    assert.ok(at(.2)[0] > 150, 'contact flashes after the beam passes');
    assert.ok(at(.6)[0] > 50 && at(1)[0] > 15, 'phosphor persists well after the sweep');
    assert.ok(at(.6)[0] < at(.2)[0] && at(1)[0] < at(.6)[0], 'contact fades gradually');
  }
});

test('menu panel alpha reveals the animated background beneath it', () => {
  const colors = Array.from({ length: 16 }, () => [255, 255, 255, 255]);
  colors[0] = [80, 120, 160, 255];
  colors[1] = [0, 0, 0, 128];
  const theme = { colors, name: 'Alpha', family: 'Simple', background: { mode: 'solid' },
    border: { source: 'internal', id: 0 } };
  const actual = renderTheme(theme);
  assert.deepEqual(Array.from(actual.data.subarray((300 * 640 + 300) * 4, (300 * 640 + 300) * 4 + 4)),
    [40, 60, 80, 255]);
});
