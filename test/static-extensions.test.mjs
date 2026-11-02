import test from 'node:test';
import assert from 'node:assert/strict';
import { packThemeImage, parseThemeImage } from '../src/theme.mjs';
import { cycledStaticPalette } from '../src/animation.mjs';
import { renderTheme, staticPlacement } from '../src/renderer.mjs';
import { findPeriod } from '../src/tile-tools.mjs';
import { wrapByRamp, horizontalSeam, indexImage } from '../src/palette-tools.mjs';

const colors = Array.from({ length: 16 }, (_, i) => [i * 10, 20, 30, 255]);
const base = { name: 'Static Test', family: 'Panorama', colors, border: { source: 'internal', id: 0 } };
const gradientImage = (w, h) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([i % 251, (i * 7) % 253, 90, 255], i * 4);
  return { width: w, height: h, data };
};
const palette = n => Array.from({ length: n }, (_, i) => [i * 8 % 256, 255 - i * 8 % 256, 128, 255]);

test('static layout packs a wide panned image after all other artwork', () => {
  const theme = { ...base, background: { mode: 'static' }, staticLayout: { panX: -0.25, panY: 0 } };
  const { image, theme: parsed } = packThemeImage(theme, { staticBackground: gradientImage(700, 300) });
  assert.equal(image.width, 700);
  assert.deepEqual(parsed.staticLayout.rect, [0, parsed.metadataRows, 700, 300]);
  assert.equal(parsed.staticLayout.panX, -0.25);
  // Above the original 640x484 limit only with a layout.
  assert.throws(() => packThemeImage({ ...base, background: { mode: 'static' } }, { staticBackground: gradientImage(700, 300) }));
});

test('indexed static images round-trip and reject non-index pixels', () => {
  const indices = Uint8Array.from({ length: 64 * 32 }, (_, i) => i % 20);
  const theme = { ...base, background: { mode: 'static' }, staticLayout: { panX: 0, panY: 0 },
    staticPalette: { ranges: [{ start: 4, length: 8, stepTicks: 3, flags: 2 }] } };
  const artwork = { staticBackground: indexImage(64, 32, indices), staticPalette: palette(20) };
  const { image } = packThemeImage(theme, artwork);
  const parsed = parseThemeImage(image);
  assert.equal(parsed.artwork.staticPalette.length, 20);
  assert.deepEqual(parsed.staticPalette.ranges, [{ start: 4, length: 8, stepTicks: 3, flags: 2 }]);
  // A colored pixel, or an index past the palette, is invalid.
  const bad = { ...artwork, staticBackground: indexImage(64, 32, indices) };
  bad.staticBackground.data.set([5, 6, 5, 255], 0);
  assert.throws(() => packThemeImage(theme, bad), /gray palette index/);
  const past = { ...artwork, staticBackground: indexImage(64, 32, indices.map(() => 25)) };
  assert.throws(() => packThemeImage(theme, past), /gray palette index/);
  // Ranges must not overlap.
  assert.throws(() => packThemeImage({ ...theme, staticPalette: { ranges: [
    { start: 0, length: 4, stepTicks: 1, flags: 0 }, { start: 3, length: 4, stepTicks: 1, flags: 0 }] } }, artwork), /overlaps/);
});

test('color cycling rotates ranges forward, reversed and blended', () => {
  const colors = [[0, 0, 0, 255], [248, 0, 0, 255], [0, 248, 0, 255], [0, 0, 248, 255]];
  const ranges = s => ({ ranges: [{ start: 1, length: 3, stepTicks: 10, flags: s }] });
  // Output is what the console shows: RGBA5551 expanded back to 8 bits.
  assert.deepEqual(cycledStaticPalette(colors, ranges(0), 0).slice(1).map(c => c.slice(0, 3)), [[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
  // After one step, entry start+i shows color start+(i-1).
  const one = cycledStaticPalette(colors, ranges(0), 10 / 60);
  assert.deepEqual(one.slice(1).map(c => c.slice(0, 3)), [[0, 0, 255], [255, 0, 0], [0, 255, 0]]);
  const reversed = cycledStaticPalette(colors, ranges(1), 10 / 60);
  assert.deepEqual(reversed.slice(1).map(c => c.slice(0, 3)), [[0, 255, 0], [0, 0, 255], [255, 0, 0]]);
  const half = cycledStaticPalette(colors, ranges(2), 5 / 60);
  assert.ok(half[1][0] > 100 && half[1][2] > 100, 'blended halfway between red and blue');
  assert.deepEqual(cycledStaticPalette(colors, ranges(0), 1)[0], colors[0], 'colors outside ranges are fixed');
});

test('static overlay animates layer 0 over the image', () => {
  const layer0 = gradientImage(64, 64);
  for (let i = 3; i < layer0.data.length; i += 8) layer0.data[i] = 0;
  const theme = { ...base, background: { mode: 'static', overlay: true, scale: 1, velocityX: 0, velocityY: 0.5, rotation: 0, alpha: 255 },
    staticLayout: { panX: 0, panY: 0 } };
  const { image } = packThemeImage(theme, { staticBackground: gradientImage(640, 480), layer0 });
  const parsed = parseThemeImage(image);
  assert.ok(parsed.background.overlay && parsed.regions.layer0[2] === 64);
  assert.ok(parsed.staticLayout.rect[1] >= parsed.regions.layer0[1] + 64, 'image follows the overlay texture');
  const a = renderTheme(parsed, { time: 0, ui: false }), b = renderTheme(parsed, { time: 0.1, ui: false });
  assert.notDeepEqual(a.data, b.data);
});

test('placement covers the screen and wraps panned axes', () => {
  const still = staticPlacement({ panX: 0, panY: 0 }, 800, 384, 5);
  assert.equal(still.scale, 1.25);
  assert.equal(still.x0, (640 - 1000) / 2);
  const panned = staticPlacement({ panX: -0.5, panY: 0 }, 800, 384, 2);
  assert.ok(panned.wrapX && panned.x0 <= 0 && panned.x0 > -panned.W);
});

test('period detection finds a motif repeat and seamless wrapping closes the seam', () => {
  const w = 512, h = 512, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = ((x % 128) < 40) ^ ((y % 128) < 70) ? 220 : 30;
    data.set([v, v / 2, 255 - v, 255], (y * w + x) * 4);
  }
  const period = findPeriod({ width: w, height: h, data });
  assert.ok(Math.abs(period.periodX - 128) < 1 && Math.abs(period.periodY - 128) < 1);
  const ramp = gradientImage(300, 40);
  assert.ok(horizontalSeam(wrapByRamp(ramp)) < horizontalSeam(ramp));
});
