// Helpers for palette-backed (type-12) static images: 256-color quantization,
// seamless panorama wrapping and cover cropping. Shared by the builders and
// the browser editor; no Node dependencies.
import { rgba5551FromRgba, rgbaFrom5551 } from './theme.mjs';
import { cropImage } from './utils.mjs';
import { resizeImage } from './tile-tools.mjs';

/** The RGBA5551 color the console shows for `rgb`, as opaque RGBA8. */
export function consoleColor(rgb) {
  const c = rgb.map(v => Math.max(0, Math.min(255, Math.round(v))));
  return rgbaFrom5551(rgba5551FromRgba(c[0], c[1], c[2], 255));
}

/** Resize to cover width x height, then crop (centered horizontally, at focusY vertically). */
export function cover(image, width, height, focusY = 0.5) {
  const s = Math.max(width / image.width, height / image.height);
  const w = Math.round(image.width * s), h = Math.round(image.height * s);
  const resized = resizeImage(image, w, h);
  return cropImage(resized, [Math.floor((w - width) / 2), Math.floor((h - height) * focusY), width, height]);
}

/**
 * Make an image wrap horizontally: keep `width` columns and cross-fade the
 * following `overlap` columns into its start, so column width-1 continues
 * into column 0.
 */
export function wrapHorizontally(image, width, overlap) {
  if (width + overlap > image.width) throw new Error('wrapHorizontally needs width + overlap source columns');
  const out = cropImage(image, [0, 0, width, image.height]);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < overlap; x++) {
    const t = (x + 0.5) / overlap, d = (y * width + x) * 4, a = (y * image.width + width + x) * 4, b = (y * image.width + x) * 4;
    for (let c = 0; c < 3; c++) out.data[d + c] = Math.round(image.data[a + c] * (1 - t) + image.data[b + c] * t);
  }
  return out;
}

/** RGB triples of the pixels for which `filter(x, y)` holds. */
export function pixelsOf(image, filter = () => true) {
  const out = [];
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (!filter(x, y)) continue;
    const i = (y * image.width + x) * 4; out.push([image.data[i], image.data[i + 1], image.data[i + 2]]);
  }
  return out;
}

/** Weighted k-means over RGB555 colors (k-means++ seeding, deterministic). */
export function kmeans(pixels, k, iterations = 12) {
  const hist = new Map();
  for (const p of pixels) { const v = rgba5551FromRgba(p[0], p[1], p[2], 255); hist.set(v, (hist.get(v) ?? 0) + 1); }
  const points = [...hist].map(([v, n]) => ({ c: rgbaFrom5551(v), n }));
  if (points.length <= k) return points.map(p => p.c.slice(0, 3));
  let seed = 12345; const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const centers = [points.reduce((a, b) => (b.n > a.n ? b : a)).c.slice(0, 3)];
  const nearest = points.map(p => d2(p.c, centers[0]));
  while (centers.length < k) {
    let total = 0; for (let i = 0; i < points.length; i++) total += nearest[i] * points[i].n;
    let r = rand() * total, pick = 0;
    for (; pick < points.length - 1; pick++) { r -= nearest[pick] * points[pick].n; if (r <= 0) break; }
    centers.push(points[pick].c.slice(0, 3));
    for (let i = 0; i < points.length; i++) nearest[i] = Math.min(nearest[i], d2(points[i].c, centers[centers.length - 1]));
  }
  for (let it = 0; it < iterations; it++) {
    const sum = centers.map(() => [0, 0, 0, 0]);
    for (const p of points) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < centers.length; j++) { const d = d2(p.c, centers[j]); if (d < bd) { bd = d; best = j; } }
      const s = sum[best]; s[0] += p.c[0] * p.n; s[1] += p.c[1] * p.n; s[2] += p.c[2] * p.n; s[3] += p.n;
    }
    sum.forEach((s, j) => { if (s[3]) centers[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  return centers;
}

/** Index of the color in colors[start, start+count) nearest to `c`. */
export function nearestIndex(colors, start, count, c) {
  let best = start, bd = Infinity;
  for (let i = start; i < start + count; i++) {
    const p = colors[i], d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Gray index image: red = green = blue = palette index, as type 12 stores it. */
export function indexImage(width, height, indices) {
  const out = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (let p = 0; p < indices.length; p++) { const i = p * 4; out.data[i] = out.data[i + 1] = out.data[i + 2] = indices[p]; out.data[i + 3] = 255; }
  return out;
}

/** Colors of a gray index image under `colors`. */
export function colorizeIndexImage(image, colors) {
  const out = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data.length) };
  for (let i = 0; i < out.data.length; i += 4) { const c = colors[image.data[i]] ?? [0, 0, 0]; out.data[i] = c[0]; out.data[i + 1] = c[1]; out.data[i + 2] = c[2]; out.data[i + 3] = 255; }
  return out;
}

/** Quantize a painting to an indexed static image with `count` fixed colors. */
export function quantizeIndexed(image, count = 256) {
  const colors = kmeans(pixelsOf(image), count).map(consoleColor);
  const indices = new Uint8Array(image.width * image.height);
  for (let p = 0; p < indices.length; p++) indices[p] = nearestIndex(colors, 0, colors.length, image.data.subarray(p * 4, p * 4 + 3));
  return { image: indexImage(image.width, image.height, indices), colors };
}

/**
 * Make an image wrap horizontally without losing columns: each row's
 * left/right edge mismatch (vertically smoothed) is removed by a linear ramp
 * across the whole width, so column width-1 continues into column 0.
 */
export function wrapByRamp(image, edge = 3, smooth = 6) {
  const { width: w, height: h, data } = image, out = { width: w, height: h, data: new Uint8ClampedArray(data) };
  const diff = Array.from({ length: h }, () => [0, 0, 0]);
  for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) {
    let left = 0, right = 0;
    for (let k = 0; k < edge; k++) { left += data[(y * w + k) * 4 + c]; right += data[(y * w + w - 1 - k) * 4 + c]; }
    diff[y][c] = (right - left) / edge;
  }
  for (let y = 0; y < h; y++) {
    const d = [0, 0, 0]; let n = 0;
    for (let k = Math.max(0, y - smooth); k <= Math.min(h - 1, y + smooth); k++, n++) for (let c = 0; c < 3; c++) d[c] += diff[k][c];
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1) - 0.5, i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(data[i + c] - (d[c] / n) * t);
    }
  }
  return out;
}

/** Mean absolute RGB difference between an image's first and last columns. */
export function horizontalSeam(image) {
  let sum = 0;
  for (let y = 0; y < image.height; y++) for (let c = 0; c < 3; c++)
    sum += Math.abs(image.data[(y * image.width) * 4 + c] - image.data[(y * image.width + image.width - 1) * 4 + c]);
  return sum / (image.height * 3);
}
