#!/usr/bin/env node
// Builds the three format-extension showcase themes from image-generated
// sources in assets/showcase-sources/ (prompts in prompts.json there):
//
//   Sea of Clouds   type-11 panorama, CI8 palette, slow horizontal pan
//   Snowbound Shrine static painting with a falling-snow overlay layer
//   Zellige Courtyard period-cropped repeating texture
//
// Generated art is only cropped, resized, quantized and assigned to palette
// ranges here; nothing is drawn procedurally.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSdTheme } from './theme-output.mjs';
import { encodePng } from '../src/png-node.mjs';
import { decodePlate } from './decode-plate.mjs';
import { packThemeImage, parseThemeImage } from '../src/theme.mjs';
import { renderTheme } from '../src/renderer.mjs';
import { cover, wrapHorizontally, consoleColor, quantizeIndexed } from '../src/palette-tools.mjs';
import { resizeImage, findPeriod, makeTile, tilePreview } from '../src/tile-tools.mjs';
import { cropImage } from '../src/utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = path.join(root, 'assets/showcase-sources');
const outPreview = path.join(root, 'out/previews/showcase');
const read = async name => decodePlate(new Uint8Array(await fs.readFile(path.join(sources, name))));
const write = async (file, image) => fs.writeFile(file, encodePng(image));

const C = (r, g, b, a = 255) => [r, g, b, a];
function colors({ background, panel, border, text, muted, accent, highlight, tabInactive, tabActive, shadow }) {
  return [background, panel, border, text, muted, accent, highlight, tabInactive, tabActive, shadow,
    C(120, 220, 150), C(250, 190, 90), background, background, background, background];
}


// ---- themes ----------------------------------------------------------------

async function cloudSea() {
  // A wide band of the panorama: mountains and cloud tops with some sky.
  // 800x384 CI8 (300 KB) fits a 4 MiB console; the menu scales it by 1.25
  // to cover the screen, so it loops every 1000 screen pixels.
  const src = await read('cloudsea-raw.jpg');
  const band = cover(src, 900, 384, 0.55);
  const panorama = ci8(wrapHorizontally(band, 800, 100));
  return {
    file: 'sea-of-clouds.png',
    theme: {
      name: 'Sea of Clouds', family: 'Panorama',
      colors: colors({ background: C(70, 64, 104), panel: C(38, 34, 72, 176), border: C(255, 214, 196), text: C(255, 248, 242),
        muted: C(206, 192, 214), accent: C(255, 190, 150), highlight: C(150, 104, 150), tabInactive: C(62, 54, 96), tabActive: C(124, 92, 140), shadow: C(22, 18, 40) }),
      background: { mode: 'static' }, staticLayout: { panX: -0.2, panY: 0 },
      staticPalette: { ranges: [] }, border: { source: 'internal', id: 8 },
    },
    artwork: { staticBackground: panorama.image, staticPalette: panorama.colors },
  };
}

/** Quantize a painting to a 256-color CI8 static image with no cycling. */
const ci8 = image => quantizeIndexed(image, 256);

/** Palette entries are stored as the RGBA5551 colors the console shows. */
class Palette {
  constructor() { this.colors = []; }
  add(rgb) { this.colors.push(consoleColor(rgb)); return this.colors.length - 1; }
}

async function snowboundShrine() {
  // CI8 halves the image to 300 KB, which fits a 4 MiB console.
  const painting = ci8(cover(await read('shrine-raw.jpg'), 640, 480));
  // Snow: a seamless 64x64 alpha tile from the generated flake field.
  const flakes = await read('snowflakes-raw.jpg');
  // Flakes about two texels wide, drawn 1:1: single-texel flakes shimmer
  // under the console's bilinear filter as they move by fractions of a pixel.
  const tile = makeTile(flakes, { width: 64, height: 64, alphaLuma: 0.3, cropScale: 0.5 });
  const d = tile.image.data, opaque = (x, y) => d[(((y + 64) % 64) * 64 + ((x + 64) % 64)) * 4 + 3] > 0;
  const lone = [];
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++)
    if (opaque(x, y) && !opaque(x - 1, y) && !opaque(x + 1, y) && !opaque(x, y - 1) && !opaque(x, y + 1)) lone.push((y * 64 + x) * 4);
  for (const i of lone) d[i + 3] = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3]) d.set([236, 242, 255], i);
  // Wind: eight interpolated keys of sideways drift (texels per frame / 8).
  const winds = [0.020, 0.044, 0.012, -0.024, -0.008, 0.032, 0.052, 0.004];
  const frames = winds.map(v => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return b; });
  return {
    file: 'snowbound-shrine.png',
    tile,
    theme: {
      name: 'Snowbound Shrine', family: 'Nature',
      colors: colors({ background: C(10, 16, 34), panel: C(10, 18, 40, 168), border: C(255, 196, 120), text: C(244, 246, 255),
        muted: C(150, 168, 200), accent: C(255, 170, 80), highlight: C(120, 64, 40), tabInactive: C(18, 28, 56), tabActive: C(110, 60, 38), shadow: C(0, 4, 14) }),
      // On the console, positive Y velocity moves texture content down.
      background: { mode: 'static', overlay: true, scale: 1, velocityX: 0.02, velocityY: 0.14, rotation: 0, alpha: 190 },
      staticLayout: { panX: 0, panY: 0 }, staticPalette: { ranges: [] },
      parameterAnimation: { mask: 1 << 20, animation: { frameCount: 8, columns: 8, frameTicks: 120, flags: 8 }, frames },
      border: { source: 'internal', id: 8 },
    },
    artwork: { staticBackground: painting.image, staticPalette: painting.colors, layer0: tile.image },
  };
}

async function zelligeCourtyard() {
  const src = await read('zellige-raw.jpg');
  const period = findPeriod(src);
  const tile = makeTile(src, { width: 64, height: 64, sourceRect: period.rect, stretch: true });
  return {
    file: 'zellige-courtyard.png',
    tile, period,
    theme: {
      name: 'Zellige Courtyard', family: 'Materials',
      colors: colors({ background: C(18, 30, 80), panel: C(10, 20, 58, 216), border: C(236, 214, 170), text: C(250, 244, 228),
        muted: C(176, 186, 210), accent: C(232, 132, 72), highlight: C(28, 96, 76), tabInactive: C(16, 28, 72), tabActive: C(30, 90, 74), shadow: C(4, 6, 20) }),
      background: { mode: 'single', scale: 0.75, velocityX: 0.004, velocityY: 0.002, rotation: 0, alpha: 255 },
      border: { source: 'internal', id: 1 },
    },
    artwork: { layer0: tile.image },
  };
}

await fs.mkdir(outPreview, { recursive: true });
const only = process.argv.slice(2);
for (const build of [cloudSea, snowboundShrine, zelligeCourtyard]) {
  const result = await build();
  if (only.length && !only.some(n => result.file.startsWith(n))) continue;
  const packed = packThemeImage(result.theme, result.artwork);
  await writeSdTheme(result.file, packed.image);
  const parsed = parseThemeImage(packed.image);
  const stem = result.file.replace(/\.png$/, '');
  for (const t of [0, 2.5]) await write(path.join(outPreview, `${stem}-t${t}.png`), renderTheme(parsed, { time: t }));
  if (result.tile) await write(path.join(outPreview, `${stem}-tile-3x3.png`), tilePreview(result.tile.image));
  console.log(`${result.theme.name}: ${packed.image.width}x${packed.image.height}`
    + (parsed.staticPalette ? `, ${parsed.artwork.staticPalette.length} colors, ${parsed.staticPalette.ranges.length} ranges` : '')
    + (result.period ? `, period ${result.period.periodX.toFixed(1)}x${result.period.periodY.toFixed(1)}` : '')
    + (result.tile ? `, seam ${result.tile.quality.pass ? 'pass' : 'FAIL'}` : ''));
}
