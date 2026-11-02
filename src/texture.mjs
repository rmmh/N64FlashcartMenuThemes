import { mod } from './utils.mjs';
import { rgba5551FromRgba, rgbaFrom5551 } from './theme.mjs';

export function quantizeImage(image) {
  const values = new Uint16Array(image.width * image.height);
  for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
    values[p] = rgba5551FromRgba(image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]);
  }
  return { width: image.width, height: image.height, values };
}

export function makePalette(images) {
  const seen = new Map();
  for (const image of images) {
    for (const value of image.values) {
      if (seen.has(value)) seen.get(value).count++;
      else if (seen.size < 4096) seen.set(value, { value, count: 1 });
    }
  }
  let entries = [...seen.values()].sort((a, b) => b.count - a.count || a.value - b.value).slice(0, 16);
  const alphaClasses = new Map();
  for (const entry of seen.values()) {
    const alpha = entry.value & 1;
    if (!alphaClasses.has(alpha) || entry.count > alphaClasses.get(alpha).count || (entry.count===alphaClasses.get(alpha).count&&entry.value<alphaClasses.get(alpha).value)) alphaClasses.set(alpha, entry);
  }
  for (const [alpha, best] of alphaClasses) {
    if (!entries.some(entry => (entry.value & 1) === alpha)) {
      if (entries.length < 16) entries.push(best);
      else entries[entries.length - 1] = best;
    }
  }
  return entries.map(entry => entry.value);
}

export function mapCi4(image, palette) {
  const indices = new Uint8Array(image.values.length);
  for (let p = 0; p < image.values.length; p++) {
    const value = image.values[p];
    const alpha = value & 1;
    const r = (value >>> 11) & 31;
    const g = (value >>> 6) & 31;
    const b = (value >>> 1) & 31;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const candidate = palette[i];
      if ((candidate & 1) !== alpha) continue;
      const dr = r - ((candidate >>> 11) & 31);
      const dg = g - ((candidate >>> 6) & 31);
      const db = b - ((candidate >>> 1) & 31);
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    indices[p] = best;
  }
  return { width: image.width, height: image.height, kind: 'ci4', indices, palette };
}

export function directTexture(image) {
  return { width: image.width, height: image.height, kind: 'rgba16', values: image.values };
}

export function prepareArtworkTextures(theme) {
  const artwork = theme.artwork ?? {};
  const sources=[...(artwork.layer0Frames?.length?artwork.layer0Frames:artwork.layer0?[artwork.layer0]:[]),...(artwork.layer1Frames?.length?artwork.layer1Frames:artwork.layer1?[artwork.layer1]:[])];
  const images = [...new Set(sources)].map(quantizeImage);
  let tex0 = null;
  let tex1 = null;
  if (images.length) {
    const anyLarge = images.some(image => image.width > 32 || image.height > 32);
    if (anyLarge) {
      const palette = makePalette(images);
      tex0 = artwork.layer0 ? mapCi4(quantizeImage(artwork.layer0), palette) : null;
      tex1 = artwork.layer1
        ? (artwork.layer1 === artwork.layer0 ? tex0 : mapCi4(quantizeImage(artwork.layer1), palette))
        : null;
    } else {
      tex0 = artwork.layer0 ? directTexture(quantizeImage(artwork.layer0)) : null;
      tex1 = artwork.layer1
        ? (artwork.layer1 === artwork.layer0 ? tex0 : directTexture(quantizeImage(artwork.layer1)))
        : null;
    }
  }
  let border = null;
  if (artwork.border) {
    const quantized = quantizeImage(artwork.border);
    border = mapCi4(quantized, makePalette([quantized]));
  }
  return { tex0, tex1, border };
}

export function texel(texture, x, y) {
  x = mod(x, texture.width);
  y = mod(y, texture.height);
  const value = texture.kind === 'ci4'
    ? texture.palette[texture.indices[y * texture.width + x]]
    : texture.values[y * texture.width + x];
  return rgbaFrom5551(value);
}
