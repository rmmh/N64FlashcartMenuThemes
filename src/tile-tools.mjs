import { assert, clamp, cropImage } from './utils.mjs';
import { quantizeImage, makePalette, mapCi4, directTexture, texel } from './texture.mjs';

function sinc(x) {
  if (Math.abs(x) < 1e-9) return 1;
  const p = Math.PI * x;
  return Math.sin(p) / p;
}
function lanczos(x, a = 3) {
  x = Math.abs(x);
  return x >= a ? 0 : sinc(x) * sinc(x / a);
}

/** High-quality separable Lanczos3 resize. */
export function resizeImage(image, width, height) {
  assert(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0, 'resize dimensions must be positive integers');
  const tmp = new Float64Array(width * image.height * 4);
  const sx = image.width / width;
  const sy = image.height / height;
  const radiusX = 3 * Math.max(1, sx);
  const radiusY = 3 * Math.max(1, sy);

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < width; x++) {
      const center = (x + 0.5) * sx - 0.5;
      const lo = Math.max(0, Math.ceil(center - radiusX));
      const hi = Math.min(image.width - 1, Math.floor(center + radiusX));
      let total = 0;
      const acc = [0, 0, 0, 0];
      for (let ix = lo; ix <= hi; ix++) {
        const w = lanczos((center - ix) / Math.max(1, sx));
        if (!w) continue;
        total += w;
        const i = (y * image.width + ix) * 4;
        for (let c = 0; c < 4; c++) acc[c] += image.data[i + c] * w;
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) tmp[o + c] = total ? acc[c] / total : 0;
    }
  }

  const out = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (let y = 0; y < height; y++) {
    const center = (y + 0.5) * sy - 0.5;
    const lo = Math.max(0, Math.ceil(center - radiusY));
    const hi = Math.min(image.height - 1, Math.floor(center + radiusY));
    for (let x = 0; x < width; x++) {
      let total = 0;
      const acc = [0, 0, 0, 0];
      for (let iy = lo; iy <= hi; iy++) {
        const w = lanczos((center - iy) / Math.max(1, sy));
        if (!w) continue;
        total += w;
        const i = (iy * width + x) * 4;
        for (let c = 0; c < 4; c++) acc[c] += tmp[i + c] * w;
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = clamp(Math.round(total ? acc[c] / total : 0), 0, 255);
    }
  }
  return out;
}

export function centerCropToAspect(image, aspect = 1, scale = 1) {
  assert(aspect > 0 && scale > 0 && scale <= 1, 'invalid crop aspect/scale');
  let w = image.width, h = Math.round(w / aspect);
  if (h > image.height) { h = image.height; w = Math.round(h * aspect); }
  w = Math.max(1, Math.floor(w * scale));
  h = Math.max(1, Math.floor(h * scale));
  const x = Math.floor((image.width - w) / 2), y = Math.floor((image.height - h) / 2);
  return cropImage(image, [x, y, w, h]);
}

function fft1d(re, im, inverse = false) {
  const n = re.length;
  assert(n > 0 && (n & (n - 1)) === 0, 'FFT length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wlenR = Math.cos(ang), wlenI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const uR = re[i + j], uI = im[i + j];
        const vr0 = re[i + j + len / 2], vi0 = im[i + j + len / 2];
        const vR = vr0 * wr - vi0 * wi, vI = vr0 * wi + vi0 * wr;
        re[i + j] = uR + vR; im[i + j] = uI + vI;
        re[i + j + len / 2] = uR - vR; im[i + j + len / 2] = uI - vI;
        const nwr = wr * wlenR - wi * wlenI;
        wi = wr * wlenI + wi * wlenR; wr = nwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function fft2d(re, im, width, height, inverse = false) {
  const rr = new Float64Array(Math.max(width, height)), ii = new Float64Array(Math.max(width, height));
  for (let y = 0; y < height; y++) {
    const o = y * width;
    for (let x = 0; x < width; x++) { rr[x] = re[o + x]; ii[x] = im[o + x]; }
    fft1d(rr.subarray(0, width), ii.subarray(0, width), inverse);
    for (let x = 0; x < width; x++) { re[o + x] = rr[x]; im[o + x] = ii[x]; }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) { rr[y] = re[y * width + x]; ii[y] = im[y * width + x]; }
    fft1d(rr.subarray(0, height), ii.subarray(0, height), inverse);
    for (let y = 0; y < height; y++) { re[y * width + x] = rr[y]; im[y * width + x] = ii[y]; }
  }
}

/**
 * Periodic-plus-smooth decomposition (Moisan-style): removes the low-frequency
 * component caused by opposite-edge disagreement while retaining texture detail.
 * Input dimensions must be powers of two (all NFMT artwork sizes are).
 */
export function periodicizeImage(image) {
  const { width: w, height: h } = image;
  assert((w & (w - 1)) === 0 && (h & (h - 1)) === 0, 'periodicizer requires power-of-two dimensions');
  const n = w * h;
  const channels = [];
  for (let c = 0; c < 4; c++) {
    const u = new Float64Array(n);
    for (let i = 0; i < n; i++) u[i] = image.data[i * 4 + c];
    const vR = new Float64Array(n), vI = new Float64Array(n);
    for (let y = 0; y < h; y++) {
      const a = y * w, b = y * w + w - 1, d = u[b] - u[a];
      vR[a] += d; vR[b] -= d;
    }
    for (let x = 0; x < w; x++) {
      const a = x, b = (h - 1) * w + x, d = u[b] - u[a];
      vR[a] += d; vR[b] -= d;
    }
    fft2d(vR, vI, w, h, false);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const den = 2 * Math.cos(2 * Math.PI * x / w) + 2 * Math.cos(2 * Math.PI * y / h) - 4;
      if (Math.abs(den) < 1e-12) { vR[i] = 0; vI[i] = 0; }
      else { vR[i] /= den; vI[i] /= den; }
    }
    fft2d(vR, vI, w, h, true);
    const p = new Float64Array(n);
    for (let i = 0; i < n; i++) p[i] = u[i] - vR[i];
    channels.push(p);
  }
  const out = { width: w, height: h, data: new Uint8ClampedArray(n * 4) };
  for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) out.data[i * 4 + c] = clamp(Math.round(channels[c][i]), 0, 255);
  return out;
}

export function alphaFromLuma(image, threshold = 0.55, softness = 0) {
  const out = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  const t = threshold * 255, s = softness * 255;
  for (let i = 0; i < out.data.length; i += 4) {
    const y = 0.2126 * out.data[i] + 0.7152 * out.data[i + 1] + 0.0722 * out.data[i + 2];
    let a;
    if (s <= 0) a = y >= t ? 255 : 0;
    else a = clamp((y - (t - s)) / (2 * s), 0, 1) * 255;
    out.data[i + 3] = Math.round(a);
  }
  return out;
}

export function decodePreparedTexture(texture) {
  const out = { width: texture.width, height: texture.height, data: new Uint8ClampedArray(texture.width * texture.height * 4) };
  for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) {
    const c = texel(texture, x, y), i = (y * texture.width + x) * 4;
    out.data.set(c, i);
  }
  return out;
}

/** Quantize exactly as the NFMT renderer will for a single texture. */
export function quantizeForNfmt(image) {
  const q = quantizeImage(image);
  const texture = image.width <= 32 && image.height <= 32 ? directTexture(q) : mapCi4(q, makePalette([q]));
  return { texture, image: decodePreparedTexture(texture) };
}

function rgbDiff2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return (dr * dr + dg * dg + db * db) / 3;
}
function pixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

export function tileQuality(image) {
  const { width: w, height: h } = image;
  let seamSum = 0, seamN = 0, seamMax = 0, interiorSum = 0, interiorN = 0;
  let gradSum = 0, gradN = 0;
  const addSeam = (a, b) => { const d2 = rgbDiff2(a, b); seamSum += d2; seamN++; seamMax = Math.max(seamMax, Math.sqrt(d2)); };
  const addInterior = (a, b) => { interiorSum += rgbDiff2(a, b); interiorN++; };
  for (let y = 0; y < h; y++) {
    addSeam(pixel(image, w - 1, y), pixel(image, 0, y));
    for (let x = 0; x < w - 1; x++) addInterior(pixel(image, x, y), pixel(image, x + 1, y));
    if (w >= 3) {
      const pM2 = pixel(image, w - 2, y), pM1 = pixel(image, w - 1, y), p0 = pixel(image, 0, y), p1 = pixel(image, 1, y);
      for (let c = 0; c < 3; c++) {
        const leftGrad = pM1[c] - pM2[c], wrapGrad = p0[c] - pM1[c], rightGrad = p1[c] - p0[c];
        gradSum += (leftGrad - wrapGrad) ** 2 + (wrapGrad - rightGrad) ** 2; gradN += 2;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    addSeam(pixel(image, x, h - 1), pixel(image, x, 0));
    for (let y = 0; y < h - 1; y++) addInterior(pixel(image, x, y), pixel(image, x, y + 1));
    if (h >= 3) {
      const pM2 = pixel(image, x, h - 2), pM1 = pixel(image, x, h - 1), p0 = pixel(image, x, 0), p1 = pixel(image, x, 1);
      for (let c = 0; c < 3; c++) {
        const topGrad = pM1[c] - pM2[c], wrapGrad = p0[c] - pM1[c], bottomGrad = p1[c] - p0[c];
        gradSum += (topGrad - wrapGrad) ** 2 + (wrapGrad - bottomGrad) ** 2; gradN += 2;
      }
    }
  }
  const seamRms = Math.sqrt(seamSum / Math.max(1, seamN));
  const interiorRms = Math.sqrt(interiorSum / Math.max(1, interiorN));
  const gradientJumpRms = Math.sqrt(gradSum / Math.max(1, gradN));
  const seamRatio = seamRms / Math.max(1, interiorRms);
  const pass = seamRms <= Math.max(12, interiorRms * 1.35) && seamMax <= Math.max(40, interiorRms * 3) && gradientJumpRms <= Math.max(36, interiorRms * 3.0);
  return { seamRms, seamMax, interiorRms, seamRatio, gradientJumpRms, pass };
}

export function tilePreview(image, cols = 3, rows = 3) {
  const out = { width: image.width * cols, height: image.height * rows, data: new Uint8ClampedArray(image.width * cols * image.height * rows * 4) };
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    for (let y = 0; y < image.height; y++) {
      const src = y * image.width * 4;
      const dst = ((ty * image.height + y) * out.width + tx * image.width) * 4;
      out.data.set(image.data.subarray(src, src + image.width * 4), dst);
    }
  }
  return out;
}

function luma(image) {
  const out = new Float64Array(image.width * image.height);
  for (let i = 0; i < out.length; i++) out[i] = 0.2126 * image.data[i * 4] + 0.7152 * image.data[i * 4 + 1] + 0.0722 * image.data[i * 4 + 2];
  return out;
}

/** Sub-pixel position of a peak from its neighbours (parabolic fit). */
function refinePeak(values, i) {
  const a = values[i - 1], b = values[i], c = values[i + 1], den = a - 2 * b + c;
  return Math.abs(den) < 1e-12 ? i : i + 0.5 * (a - c) / den;
}

/**
 * Find a generated texture's own repeat. Source art that "tiles" usually
 * repeats a motif several times; cropping exactly one period (or a small
 * group of periods) keeps far more detail at 64x64 than shrinking the whole
 * plate, and the crop is seamless by construction.
 *
 * Returns the horizontal/vertical periods (sub-pixel), their autocorrelation
 * strength, and a crop rectangle covering nx by ny periods, placed where the
 * image best matches itself across the wrap.
 */
export function findPeriod(image, { aspect = 1, minPeriod = 24, periods = null, maxAspectError = 0.15 } = {}) {
  let size = 1;
  while (size * 2 <= Math.min(image.width, image.height)) size *= 2;
  const x0 = Math.floor((image.width - size) / 2), y0 = Math.floor((image.height - size) / 2);
  const square = cropImage(image, [x0, y0, size, size]), l = boxBlur(luma(square), size, Math.max(1, size >> 7));
  minPeriod = Math.max(minPeriod, size >> 4);
  let mean = 0; for (const v of l) mean += v; mean /= l.length;
  const re = new Float64Array(l.length), im = new Float64Array(l.length);
  for (let i = 0; i < l.length; i++) re[i] = l[i] - mean;
  fft2d(re, im, size, size, false);
  for (let i = 0; i < re.length; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft2d(re, im, size, size, true);
  const zero = re[0] || 1, row = new Float64Array(size), column = new Float64Array(size);
  for (let i = 0; i < size; i++) { row[i] = re[i] / zero; column[i] = re[i * size] / zero; }
  const axis = values => {
    // The fundamental is the smallest local maximum close to the strongest
    // one; later peaks are its multiples.
    const peaks = [];
    for (let i = Math.max(2, minPeriod); i < size / 2; i++) if (values[i] > values[i - 1] && values[i] >= values[i + 1]) peaks.push(i);
    assert(peaks.length, 'no repeat found; source is not periodic enough');
    const best = Math.max(...peaks.map(i => values[i]));
    // Staggered layouts (brick, slate) show a weaker peak at one course; only
    // a near-equal peak is a true repeat of the whole pattern.
    const i = peaks.find(p => values[p] >= best * 0.92);
    return { period: refinePeak(values, i), strength: values[i] };
  };
  const x = axis(row), y = axis(column);
  let nx = 1, ny = 1;
  if (periods) [nx, ny] = periods;
  else {
    let best = null;
    for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) {
      const w = a * x.period, h = b * y.period;
      if (w > image.width || h > image.height) continue;
      const error = Math.abs(Math.log((w / h) / aspect));
      const candidate = { a, b, error, cells: a * b };
      if (!best || (error <= maxAspectError) > (best.error <= maxAspectError)
          || ((error <= maxAspectError) === (best.error <= maxAspectError)
              && (error <= maxAspectError ? cells(candidate) < cells(best) : error < best.error))) best = candidate;
    }
    assert(best, 'source is smaller than one period');
    [nx, ny] = [best.a, best.b];
  }
  const w = Math.round(nx * x.period), h = Math.round(ny * y.period);
  assert(w <= image.width && h <= image.height, `${nx}x${ny} periods do not fit the source`);
  // Place the crop where columns/rows one period apart agree best.
  const full = luma(image), step = 4;
  let origin = [0, 0], bestError = Infinity;
  for (let oy = 0; oy + h < image.height && oy < y.period; oy += step) for (let ox = 0; ox + w < image.width && ox < x.period; ox += step) {
    let error = 0;
    for (let t = 0; t < h; t += 2) error += Math.abs(full[(oy + t) * image.width + ox] - full[(oy + t) * image.width + ox + w]);
    for (let t = 0; t < w; t += 2) error += Math.abs(full[oy * image.width + ox + t] - full[(oy + h) * image.width + ox + t]);
    if (error < bestError) { bestError = error; origin = [ox, oy]; }
  }
  return { periodX: x.period, periodY: y.period, strengthX: x.strength, strengthY: y.strength, periods: [nx, ny], rect: [origin[0], origin[1], w, h] };
}
function cells(c) { return c.cells; }

/** Separable wrap-around box blur; suppresses grain before autocorrelation. */
function boxBlur(values, size, radius) {
  const out = new Float64Array(values.length), tmp = new Float64Array(values.length), n = radius * 2 + 1;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let sum = 0; for (let k = -radius; k <= radius; k++) sum += values[y * size + ((x + k + size) % size)];
    tmp[y * size + x] = sum / n;
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let sum = 0; for (let k = -radius; k <= radius; k++) sum += tmp[((y + k + size) % size) * size + x];
    out[y * size + x] = sum / n;
  }
  return out;
}

export function makeTile(source, { width = 64, height = 64, cropScale = 1, alphaLuma = null, sourceRect = null, stretch = false } = {}) {
  const selected = sourceRect ? cropImage(source, sourceRect) : source;
  // A period crop must be resized whole; trimming it would break the repeat.
  const crop = stretch ? selected : centerCropToAspect(selected, width / height, cropScale);
  const resized = resizeImage(crop, width, height);
  const beforeAlpha = alphaLuma == null ? resized : alphaFromLuma(resized, alphaLuma);
  const beforeQuantized = quantizeForNfmt(beforeAlpha).image;
  const beforeQuality = tileQuality(beforeQuantized);
  const periodic = periodicizeImage(resized);
  const withAlpha = alphaLuma == null ? periodic : alphaFromLuma(periodic, alphaLuma);
  const { texture, image } = quantizeForNfmt(withAlpha);
  const quality = tileQuality(image);
  return { crop, resized, periodic: withAlpha, texture, image, beforeQuality, quality };
}
