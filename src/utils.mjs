export const WIDTH = 64;
// Region origins are bytes; a 32px texture can start at row 255 and extend
// through row 286.
export const MAX_HEIGHT = 287;
export const METADATA_BYTES_PER_ROW = WIDTH * 3;
export const COLOR_NAMES = [
  'Background', 'Panel', 'Border', 'Text', 'Muted text', 'Accent', 'Highlight',
  'Inactive tab', 'Active tab', 'Shadow', 'Success', 'Warning',
  'Gradient TL', 'Gradient TR', 'Gradient BL', 'Gradient BR'
];
export const LEGACY_FAMILIES = ['Simple', 'Hardware', 'Nature', 'Texture', 'Extra'];
// In the menu's order. Families may have any name; these are the ones offered in the editor.
export const CATEGORY_FAMILIES = [
  'Space', 'Electronics', 'Life', 'Materials', 'Machines', 'Ornament', 'Water',
  'Retro', 'Abstract', 'Fantasy', 'Panorama', 'Particle', 'Cycling'
];
export const FAMILIES = [
  ...LEGACY_FAMILIES,
  ...CATEGORY_FAMILIES.filter(name => !LEGACY_FAMILIES.includes(name)),
  'Custom'
];
const knownFamily = family => FAMILIES.find(name => name.toLowerCase() === family.toLowerCase());
/** The family a theme is listed under: known names match case-insensitively, `Custom` is reserved. */
export function normalizeFamily(family) {
  const known = knownFamily(family);
  return known === 'Custom' ? 'External' : known ?? family;
}
/** The six-row menu page holding a family; other families are listed before `Custom`. */
export function familyPage(family, pageSize=6) {
  const families = knownFamily(family) ? FAMILIES : [...FAMILIES.slice(0, -1), family, 'Custom'];
  const index=families.findIndex(name => name.toLowerCase() === family.toLowerCase());
  const start=Math.floor(index/pageSize)*pageSize;
  const names=families.slice(start,start+pageSize);
  return {names,index:index-start,start};
}
export const BORDER_NAMES = ['Plain', 'Double', 'Facets', 'Beads', 'Brackets', 'Stitches', 'Nodes', 'Scallops', 'Soft'];
export const INTERNAL_BORDER_GEOMETRY = BORDER_NAMES.map((_, id) => id === 4 ? [2, 3, 4] : [2, 3, 1]);

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function clamp(v, lo = 0, hi = 1) { return Math.min(hi, Math.max(lo, v)); }
export function mod(v, m) { return ((v % m) + m) % m; }
export function isPow2(v) { return v > 0 && (v & (v - 1)) === 0; }
export function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

export function readU16LE(bytes, o) { return bytes[o] | (bytes[o + 1] << 8); }
export function readU32LE(bytes, o) { return (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0; }
export function writeU16LE(bytes, o, v) { bytes[o] = v & 255; bytes[o + 1] = (v >>> 8) & 255; }
export function writeU32LE(bytes, o, v) { bytes[o] = v & 255; bytes[o + 1] = (v >>> 8) & 255; bytes[o + 2] = (v >>> 16) & 255; bytes[o + 3] = (v >>> 24) & 255; }

const fbuf = new ArrayBuffer(4);
const fview = new DataView(fbuf);
export function readF32LE(bytes, o) { fview.setUint8(0, bytes[o]); fview.setUint8(1, bytes[o+1]); fview.setUint8(2, bytes[o+2]); fview.setUint8(3, bytes[o+3]); return fview.getFloat32(0, true); }
export function writeF32LE(bytes, o, v) { fview.setFloat32(0, v, true); bytes[o]=fview.getUint8(0); bytes[o+1]=fview.getUint8(1); bytes[o+2]=fview.getUint8(2); bytes[o+3]=fview.getUint8(3); }

export function rgbaToCss(c) { return `rgb(${c[0]} ${c[1]} ${c[2]})`; }
export function cloneImage(image) { return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }; }

export function cropImage(image, rect) {
  const [x, y, w, h] = rect;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    const src = ((y + yy) * image.width + x) * 4;
    out.set(image.data.subarray(src, src + w * 4), yy * w * 4);
  }
  return { width: w, height: h, data: out };
}

export function blitImage(dst, src, x, y) {
  assert(x >= 0 && y >= 0 && x + src.width <= dst.width && y + src.height <= dst.height, 'blit out of bounds');
  for (let yy = 0; yy < src.height; yy++) {
    const so = yy * src.width * 4;
    const d = ((y + yy) * dst.width + x) * 4;
    dst.data.set(src.data.subarray(so, so + src.width * 4), d);
  }
}
