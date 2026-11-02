// Bit-exact model of how the menu draws a static image, for both preview
// renderers. Verified against angrylion captures of the menu in ares.
//
// The menu (background.c) blits the image with rdpq_tex_blit: magnified
// images are filtered and split into 512-column slices, 1:1 images are drawn
// whole on whole pixels, and panned axes repeat. libdragon loads each slice
// in horizontal strips that fit TMEM (one row of overlap when filtering) and
// draws every strip as its own texture rectangle in 10.2 fixed point, with
// 10.5 texture coordinates and an integer per-pixel step. The RDP then
//  - draws columns from ceil(x0) and rows from ceil(y0) up to the partial last
//    row or column, so neighbouring rectangles never overlap;
//  - extrapolates the column coordinate back to the left pixel edge but
//    starts the row coordinate at the rectangle's first scanline;
//  - expands 5-bit texels to 8 bits, applies its 3-point filter in 1/32-texel
//    steps with +16 rounding, clamping neighbours to the texels loaded in
//    TMEM, and truncates the result to RGBA5551.
import { staticPlacement } from './renderer.mjs';

const SLICE = 512;

/** The blits the menu issues for a static image at `seconds`, in draw order. */
export function staticBlits(theme, seconds) {
  const im = theme.artwork.staticBackground, layout = theme.staticLayout;
  if (!layout) return [{ x: 0, y: 0, sx: 640 / im.width, sy: 480 / im.height, filter: true, slice: im.width }];
  const place = staticPlacement(layout, im.width, im.height, seconds), blits = [];
  for (let y = place.y0; y < 480; y += place.H) {
    for (let x = place.x0; x < 640; x += place.W) {
      if (x + place.W > 0 && y + place.H > 0)
        blits.push({ x, y, sx: place.scale, sy: place.scale, filter: place.filter, slice: place.filter ? SLICE : im.width });
      if (!place.wrapX) break;
    }
    if (!place.wrapY) break;
  }
  return blits;
}

/** libdragon ltd_texloader strips: [first, last) texel rows drawn by each rectangle. */
function strips(height, rowsPerLoad, filter) {
  const out = [];
  for (let t0 = 0; t0 < height;) {
    const tm = filter ? Math.max(t0 - 1, 0) : t0, tn = Math.min(tm + rowsPerLoad, height);
    const tx = !filter || tn === height ? tn : tn - 1;
    out.push([t0, tx, tm, tn]);
    t0 = tx;
  }
  return out;
}

/**
 * One rectangle edge along an axis: the first and last screen pixel it
 * draws, and the texture coordinate (1/1024 texel) at each, as the RDP does.
 */
function axis(pos, a, b, scale, limit, extrapolate) {
  let e0 = Math.trunc((pos + a * scale) * 4), e1 = Math.trunc((pos + b * scale) * 4), c0 = a * 32;
  if (e1 === e0) return null;
  const step = Math.trunc(((b - a) * 32 * 128) / (e1 - e0));
  if (e0 < 0) { c0 -= (e0 * step) >> 7; e0 = 0; }
  const first = Math.max(0, (e0 + 3) >> 2), last = Math.min(limit, (e1 + 3) >> 2);
  if (first >= last) return null;
  return { first, last, coord: p => extrapolate ? c0 * 32 + (((p * 4 - e0) * step) >> 2) : c0 * 32 + (p - (e0 >> 2)) * step };
}

// 8-bit filter result -> the 5-bit value the framebuffer keeps -> preview RGBA8.
const SHOWN = Uint8Array.from({ length: 256 }, (_, v) => Math.round((v >> 3) * 255 / 31));
const expand5 = v => (v << 3) | (v >> 2);
// angrylion's magic-square dither thresholds, indexed by (y & 3) * 4 + (x & 3).
const MAGIC = [0, 6, 1, 7, 4, 2, 5, 3, 3, 5, 2, 4, 7, 1, 6, 0];

/**
 * Render the static layer exactly as the console does. `texels` gives the
 * 8-bit-expanded RGB of each texel: `{ indices, palette }` for CI8 (palette
 * as 256x3 bytes) or `{ rgb }` (width x height x 3 bytes) for RGBA5551.
 * Returns 640x480 RGBA8; pixels no blit touches have alpha 0.
 */
export function rdpStaticFrame(width, height, texels, blits, out = new Uint8ClampedArray(640 * 480 * 4)) {
  out.fill(0);
  const { indices, palette, rgb } = texels, ci8 = !!indices;
  const R = new Uint8Array(4), G = new Uint8Array(4), B = new Uint8Array(4);
  const load = (k, i) => { const o = ci8 ? indices[i] * 3 : i * 3, src = ci8 ? palette : rgb; R[k] = src[o]; G[k] = src[o + 1]; B[k] = src[o + 2]; };
  for (const blit of blits) {
    for (let sa = 0; sa < width; sa += blit.slice) {
      const sb = Math.min(width, sa + blit.slice), sliceWidth = sb - sa;
      const pitch = Math.ceil((sliceWidth * (ci8 ? 1 : 2)) / 8) * 8, rowsPerLoad = Math.floor((ci8 ? 2048 : 4096) / pitch);
      const cols = axis(blit.x, sa, sb, blit.sx, 640, true);
      if (!cols) continue;
      const n = cols.last - cols.first, S0 = new Int32Array(n), S1 = new Int32Array(n), FX = new Int32Array(n);
      for (let k = 0; k < n; k++) {
        const s = cols.coord(cols.first + k), sx = s >> 10;
        S0[k] = Math.min(sb - 1, Math.max(sa, sx)); S1[k] = Math.min(sb - 1, Math.max(sa, sx + 1)); FX[k] = (s & 1023) >> 5;
      }
      for (const [ta, tb, tm, tn] of strips(height, rowsPerLoad, blit.filter)) {
        const rows = axis(blit.y, ta, tb, blit.sy, 480, false);
        if (!rows) continue;
        for (let y = rows.first; y < rows.last; y++) {
          const t = rows.coord(y), ty = t >> 10, fy = (t & 1023) >> 5;
          const r0 = Math.min(tn - 1, Math.max(tm, ty)) * width, r1 = Math.min(tn - 1, Math.max(tm, ty + 1)) * width;
          let o = (y * 640 + cols.first) * 4;
          for (let k = 0; k < n; k++, o += 4) {
            if (!blit.filter) {
              load(0, r0 + S0[k]);
              out[o] = SHOWN[R[0]]; out[o + 1] = SHOWN[G[0]]; out[o + 2] = SHOWN[B[0]]; out[o + 3] = 255;
              continue;
            }
            const fx = FX[k], upper = fx + fy >= 32;
            load(0, upper ? r1 + S1[k] : r0 + S0[k]);   // base texel
            load(1, r0 + S1[k]);                          // right neighbour
            load(2, r1 + S0[k]);                          // lower neighbour
            const ax = upper ? 32 - fy : fx, ay = upper ? 32 - fx : fy;
            out[o] = SHOWN[(((R[1] - R[0]) * ax + (R[2] - R[0]) * ay + 16) >> 5) + R[0]];
            out[o + 1] = SHOWN[(((G[1] - G[0]) * ax + (G[2] - G[0]) * ay + 16) >> 5) + G[0]];
            out[o + 2] = SHOWN[(((B[1] - B[0]) * ax + (B[2] - B[0]) * ay + 16) >> 5) + B[0]];
            out[o + 3] = 255;
          }
        }
      }
    }
  }
  return out;
}

const texelCache = new WeakMap();
/** 8-bit-expanded texels of a static image under `palette` (cycled colors for CI8). */
function staticTexels(theme, palette) {
  const im = theme.artwork.staticBackground;
  let cached = texelCache.get(im);
  if (!cached) {
    if (palette) cached = { indices: Uint8Array.from({ length: im.width * im.height }, (_, p) => im.data[p * 4]) };
    else {
      const rgb = new Uint8Array(im.width * im.height * 3);
      for (let p = 0; p < im.width * im.height; p++) for (let c = 0; c < 3; c++) rgb[p * 3 + c] = expand5(im.data[p * 4 + c] >> 3);
      cached = { rgb };
    }
    texelCache.set(im, cached);
  }
  if (!palette) return cached;
  const pal = new Uint8Array(256 * 3);
  palette.forEach((c, i) => { for (let k = 0; k < 3; k++) pal[i * 3 + k] = expand5(c[k] >> 3); });
  return { indices: cached.indices, palette: pal };
}

/**
 * The static background for a theme at `seconds` as the console draws it, as
 * 640x480 RGBA8: the image, then its overlay layer when `overlay` (a prepared
 * layer-0 texture) is given. Overlay motion integrates the current velocity
 * from the theme's texture origin, as the menu does for constant velocities.
 */
export function staticLayer(theme, seconds, palette, out, overlay = null) {
  const im = theme.artwork.staticBackground;
  const frame = rdpStaticFrame(im.width, im.height, staticTexels(theme, palette), staticBlits(theme, seconds), out);
  const bg = theme.background;
  if (overlay && bg.overlay && !bg.rotation) overlayRdp(frame, overlay, overlayParams(theme, seconds, overlay));
  return frame;
}

/**
 * Draw a static overlay (layer 0) over `frame` exactly as the menu does: a
 * full-screen texture rectangle sampling the 64-texel wrapping tile shifted
 * by (u, v) texels, 3-point filtered, multiplied by PRIM (white, overlay
 * alpha) in the combiner and force-blended over the framebuffer.
 * `texture` is a prepared CI4 or RGBA16 texture (see texture.mjs).
 */
export function overlayRdp(frame, texture, { dsdx, dtdy, su, tv, alpha }) {
  const W = texture.width, H = texture.height, n = W * H;
  // 8-bit replicated RGBA of each texel (alpha 0 or 255).
  const tex = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = texture.kind === 'ci4' ? texture.palette[texture.indices[i]] : texture.values[i];
    tex.set([expand5((c >>> 11) & 31), expand5((c >>> 6) & 31), expand5((c >>> 1) & 31), c & 1 ? 255 : 0], i * 4);
  }
  const px = new Int32Array(4 * 4);
  for (let y = 0; y < 480; y++) {
    const t = y * dtdy - tv, ty = t >> 10, fy = (t & 1023) >> 5;
    const r0 = (((ty % H) + H) % H) * W, r1 = ((((ty + 1) % H) + H) % H) * W;
    for (let x = 0; x < 640; x++) {
      const s = x * dsdx - su, sx = s >> 10, fx = (s & 1023) >> 5;
      const c0 = ((sx % W) + W) % W, c1 = (((sx + 1) % W) + W) % W, upper = fx + fy >= 32;
      const base = (upper ? r1 + c1 : r0 + c0) * 4, right = (r0 + c1) * 4, down = (r1 + c0) * 4;
      const ax = upper ? 32 - fy : fx, ay = upper ? 32 - fx : fy;
      for (let k = 0; k < 4; k++) px[k] = (((tex[right + k] - tex[base + k]) * ax + (tex[down + k] - tex[base + k]) * ay + 16) >> 5) + tex[base + k];
      // Combiner TEX * PRIM, round to nearest.
      const a = (px[3] * alpha + 0x80) >> 8;
      if (!a) continue;
      const b1 = a >> 3, mulb = ((~a & 0xff) >> 3) + 1, o = (y * 640 + x) * 4;
      for (let k = 0; k < 3; k++) {
        const inColor = (px[k] * 255 + 0x80) >> 8, mem = Math.round(frame[o + k] * 31 / 255) << 3;
        let c = ((inColor * b1 + mem * mulb) >> 5) & 0xff;
        // The textured path enables magic-square RGB dither before the 5-bit write.
        if ((c & 7) > MAGIC[((y & 3) << 2) | (x & 3)]) c = c > 247 ? 255 : (c & 0xf8) + 8;
        frame[o + k] = SHOWN[c];
      }
    }
  }
  return frame;
}

/**
 * Per-column and per-row tables for drawing the static image on the GPU with
 * the same arithmetic as rdpStaticFrame. The model is separable: a column's
 * slice and texture coordinate do not depend on the row, and a row's strip
 * depends only on the slice's width ("class": full slices, or a narrower last
 * one). Columns: (s, slice first, slice last, class or -1). Rows, one row of
 * entries per class: (t, strip first loaded row, last loaded row, covered).
 */
export function staticTables(theme, seconds) {
  const im = theme.artwork.staticBackground, width = im.width, height = im.height, ci8 = !!theme.artwork.staticPalette;
  const blits = staticBlits(theme, seconds), filter = blits[0]?.filter ?? true, slice = blits[0]?.slice ?? width;
  const widths = [Math.min(slice, width)];
  if (width % slice && width > slice) widths.push(width % slice);
  const cols = new Int32Array(640 * 4), rows = new Int32Array(480 * 4 * widths.length);
  for (let i = 0; i < 640; i++) cols[i * 4 + 3] = -1;
  const xs = [...new Set(blits.map(b => b.x))], ys = [...new Set(blits.map(b => b.y))], scale = blits[0]?.sx ?? 1, scaleY = blits[0]?.sy ?? 1;
  for (const x of xs) for (let sa = 0; sa < width; sa += slice) {
    const sb = Math.min(width, sa + slice), cols1 = axis(x, sa, sb, scale, 640, true);
    if (!cols1) continue;
    for (let p = cols1.first; p < cols1.last; p++) cols.set([cols1.coord(p), sa, sb - 1, widths.indexOf(sb - sa)], p * 4);
  }
  widths.forEach((w, cls) => {
    const pitch = Math.ceil((w * (ci8 ? 1 : 2)) / 8) * 8, rowsPerLoad = Math.floor((ci8 ? 2048 : 4096) / pitch);
    for (const y of ys) for (const [ta, tb, tm, tn] of strips(height, rowsPerLoad, filter)) {
      const r = axis(y, ta, tb, scaleY, 480, false);
      if (!r) continue;
      for (let p = r.first; p < r.last; p++) rows.set([r.coord(p), tm, tn - 1, 1], (cls * 480 + p) * 4);
    }
  });
  return { cols, rows, classes: widths.length, filter };
}

/**
 * Integer parameters of the overlay rectangle at `seconds`: per-pixel texture
 * steps and the tile origin, all in 1/1024 texel units, as overlayRdp uses.
 */
export function overlayParams(theme, seconds, overlay) {
  const bg = theme.background, F = seconds * 60, wrap = (v, n) => ((v % n) + n) % n;
  const u = wrap((theme.textureOrigin?.[0] ?? 0) + bg.velocityX * 8 * F, overlay.width);
  const v = wrap((theme.textureOrigin?.[1] ?? 0) + bg.velocityY * 8 * F, overlay.height);
  return {
    dsdx: Math.trunc((Math.round(640 * bg.scale * 32) * 128) / 2560), dtdy: Math.trunc((Math.round(480 * bg.scale * 32) * 128) / 1920),
    su: Math.trunc(u * 4) * 256, tv: Math.trunc(v * 4) * 256, alpha: bg.alpha,
  };
}
