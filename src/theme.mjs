import { crc32 } from './crc32.mjs';
import {
  WIDTH, MAX_HEIGHT, METADATA_BYTES_PER_ROW, FAMILIES, BORDER_NAMES, INTERNAL_BORDER_GEOMETRY,
  assert, cropImage, blitImage, isPow2, isFiniteNumber,
  readU16LE, readU32LE, readF32LE, writeU16LE, writeU32LE, writeF32LE
} from './utils.mjs';

const TD = new TextDecoder('utf-8', { fatal: false });
const TE = new TextEncoder();

export function rgba5551FromRgba(r, g, b, a) {
  return ((r >> 3) << 11) | ((g >> 3) << 6) | ((b >> 3) << 1) | (a >= 128 ? 1 : 0);
}

export function rgbaFrom5551(v) {
  const r5 = (v >>> 11) & 31, g5 = (v >>> 6) & 31, b5 = (v >>> 1) & 31;
  return [Math.round(r5 * 255 / 31), Math.round(g5 * 255 / 31), Math.round(b5 * 255 / 31), (v & 1) ? 255 : 0];
}

function metadataBytesFromImage(image, rows) {
  const out = new Uint8Array(rows * METADATA_BYTES_PER_ROW);
  let p = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * image.width + x) * 4;
      assert(image.data[i + 3] === 255, `metadata alpha must be 255 at (${x},${y})`);
      out[p++] = image.data[i]; out[p++] = image.data[i + 1]; out[p++] = image.data[i + 2];
    }
  }
  return out;
}

// Packages with a type-11 static layout may be larger; others keep the
// original 640x484 limit, enforced once the records are known.
export const STATIC_MAX_WIDTH = 2048, STATIC_MAX_HEIGHT = 1024;
function metadataRowsProbe(image) {
  assert(image.width >= WIDTH && image.width <= STATIC_MAX_WIDTH, `theme width must be 64..${STATIC_MAX_WIDTH}, got ${image.width}`);
  assert(image.height >= 1 && image.height <= STATIC_MAX_HEIGHT, `theme height must be 1..${STATIC_MAX_HEIGHT}, got ${image.height}`);
  const b = metadataBytesFromImage(image, 1);
  assert(String.fromCharCode(...b.subarray(0,4)) === 'N64T', 'bad theme magic; expected N64T');
  assert(b[4] === 1, `unsupported theme version ${b[4]}`);
  const rows = b[5];
  assert(rows >= 1 && rows <= 4 && rows <= image.height, `invalid metadata row count ${rows}`);
  return rows;
}

function readRect(v, o) { return [v[o], v[o+1], v[o+2], v[o+3]]; }
function zeroRect(r) { return r.every(v => v === 0); }
function sameRect(a,b) { return a.every((v,i) => v === b[i]); }
function rectFits(r, image) { return r[0] + r[2] <= image.width && r[1] + r[3] <= image.height; }
function rectIntersectsMetadata(r, rows) { return !zeroRect(r) && r[1] < rows; }

function validateTextureRect(r, image, label) {
  if (zeroRect(r)) return;
  assert(r[2] > 0 && r[3] > 0 && r[2] <= 64 && r[3] <= 64, `${label} must be 1..64 pixels in each dimension`);
  assert(isPow2(r[2]) && isPow2(r[3]), `${label} width and height must be powers of two`);
  assert(rectFits(r, image), `${label} lies outside PNG`);
}

function textureFormat(r) { return r[2] <= 32 && r[3] <= 32 ? 'RGBA16' : 'CI4'; }
function encodedFootprint(r, format) {
  const rowBytes = format === 'RGBA16' ? r[2] * 2 : Math.ceil(r[2] / 2);
  return Math.ceil(rowBytes / 8) * 8 * r[3];
}

function parseAnimationRecord(v,o,label,allowStatic=true) {
  const frameCount=v[o],columns=v[o+1],frameTicks=readU16LE(v,o+2),flags=v[o+4];
  assert((flags&0xf0)===0&&((flags&3)!==3),`${label} has invalid animation flags`);
  if(frameCount<=1&&allowStatic){assert(columns===0&&frameTicks===0&&flags===0,`${label} static record must be zeroed`);return {frameCount,columns:0,frameTicks:0,flags:0};}
  assert(columns>0&&frameTicks>0,`${label} animation columns and frame ticks must be nonzero`);
  return {frameCount,columns,frameTicks,flags};
}
function animationRects(base,a,image,rows,label) {
  if(a.frameCount<=1)return zeroRect(base)?[]:[base];
  const out=[];
  for(let i=0;i<a.frameCount;i++){const r=[base[0]+(i%a.columns)*base[2],base[1]+Math.floor(i/a.columns)*base[3],base[2],base[3]];assert(rectFits(r,image)&&!rectIntersectsMetadata(r,rows),`${label} frame ${i} lies outside artwork`);out.push(r);}
  return out;
}

function parseTextureAnimations(v,background,regions,image,rows) {
  assert(v.length===10,'texture animation TLV must be 10 bytes');
  const layer0=parseAnimationRecord(v,0,'layer 0'),layer1=parseAnimationRecord(v,5,'layer 1');
  if(background.mode==='single')assert(layer1.frameCount===0,'single texture layer-1 animation must be zero');
  for(const [a,r,label] of [[layer0,regions?.layer0,'layer 0'],[layer1,regions?.layer1,'layer 1']]){
    if(a.frameCount>1){assert(r&&!zeroRect(r),`${label} animation requires artwork`);assert(!(a.flags&8)||textureFormat(r)==='RGBA16',`${label} interpolation requires RGBA16`);animationRects(r,a,image,rows,label);}
  }
  return {layer0,layer1};
}

const PARAM_SIZES=Array.from({length:29},(_,i)=>i<25?4:1);
function parseParameterAnimation(v,image,rows) {
  assert(v.length===13,'parameter animation TLV must be 13 bytes');
  const mask=readU32LE(v,0),rect=readRect(v,4),animation=parseAnimationRecord(v,8,'parameter',false);
  assert(mask!==0&&(mask&0xe0000000)===0,'invalid parameter channel mask');
  assert(animation.frameCount>=1,'parameter animation requires at least one frame');
  const byteLength=PARAM_SIZES.reduce((n,size,i)=>n+((mask>>>i)&1?size:0),0);
  assert(rect[2]===Math.ceil(byteLength/3)&&rect[3]===1,'parameter frame rectangle has wrong dimensions');
  const rects=animationRects(rect,animation,image,rows,'parameter');
  const frames=rects.map((r,index)=>{const bytes=[];for(let x=0;x<r[2];x++){const p=(r[1]*image.width+r[0]+x)*4;assert(image.data[p+3]===255,`parameter frame ${index} alpha must be 255`);bytes.push(image.data[p],image.data[p+1],image.data[p+2]);}assert(bytes.slice(byteLength).every(n=>n===0),`parameter frame ${index} padding must be zero`);return new Uint8Array(bytes.slice(0,byteLength));});
  for(const [index,frame] of frames.entries()){let o=0;for(let channel=0;channel<29;channel++)if((mask>>>channel)&1){if(channel>=16&&channel<25){const value=readF32LE(frame,o);assert(isFiniteNumber(value),`parameter frame ${index} channel ${channel} must be finite`);if(channel===16)assert(value>=0&&value<=2,'animated gradient speed out of range');else if(channel===17)assert(value>=0&&value<=1,'animated gradient warp out of range');else if(channel===18||channel===19)assert(value>=1/64&&value<=16,'animated texture scale out of range');else if(channel>=20&&channel<=23)assert(value>=-4&&value<=4,'animated texture velocity out of range');else assert(value>=-.25&&value<=.25,'animated rotation out of range');}o+=PARAM_SIZES[channel];}}
  return {mask,rect,animation,frames};
}

function parseBackground(v) {
  const mode = v[0];
  if (mode === 5) {
    if (v.length === 1) return {mode:'static'};
    assert(v.length === 18, 'static image background TLV must have length 1 or 18');
    const scale = readF32LE(v,1), velocityX = readF32LE(v,5), velocityY = readF32LE(v,9), rotation = readF32LE(v,13), alpha = v[17];
    validateMotion(scale, velocityX, velocityY, rotation);
    return { mode: 'static', overlay: true, scale, velocityX, velocityY, rotation, alpha };
  }
  if (mode === 3) {
    assert(v.length === 9, 'gradient background TLV must have length 9');
    const speed = readF32LE(v,1), warp = readF32LE(v,5);
    assert(isFiniteNumber(speed) && speed >= 0 && speed <= 2, `gradient speed out of range: ${speed}`);
    assert(isFiniteNumber(warp) && warp >= 0 && warp <= 1, `gradient warp out of range: ${warp}`);
    return { mode: 'gradient', speed, warp };
  }
  if (mode === 2) {
    assert(v.length === 18, 'single texture background TLV must have length 18');
    const scale = readF32LE(v,1), velocityX = readF32LE(v,5), velocityY = readF32LE(v,9), rotation = readF32LE(v,13), alpha = v[17];
    validateMotion(scale, velocityX, velocityY, rotation);
    return { mode: 'single', scale, velocityX, velocityY, rotation, alpha };
  }
  if (mode === 1) {
    assert(v.length === 31, 'dual texture background TLV must have length 31');
    const scale0 = readF32LE(v,1), scale1 = readF32LE(v,5), velocityX0 = readF32LE(v,9), velocityY0 = readF32LE(v,13), velocityX1 = readF32LE(v,17), velocityY1 = readF32LE(v,21), rotation = readF32LE(v,25), alpha0 = v[29], alpha1 = v[30];
    validateMotion(scale0, velocityX0, velocityY0, rotation);
    validateMotion(scale1, velocityX1, velocityY1, rotation);
    return { mode: 'dual', scale0, scale1, velocityX0, velocityY0, velocityX1, velocityY1, rotation, alpha0, alpha1 };
  }
  throw new Error(`unknown background mode ${mode}`);
}

function validateMotion(scale, vx, vy, rotation) {
  assert(isFiniteNumber(scale) && scale >= 1/64 && scale <= 16, `texture scale out of range: ${scale}`);
  for (const [n,v] of [['velocity X',vx],['velocity Y',vy]]) assert(isFiniteNumber(v) && v >= -4 && v <= 4, `${n} out of range: ${v}`);
  assert(isFiniteNumber(rotation) && rotation >= -0.25 && rotation <= 0.25, `rotation out of range: ${rotation}`);
}

function decodeColors(v) {
  assert(v.length === 64, `colors TLV must be 64 bytes, got ${v.length}`);
  return Array.from({length:16}, (_, i) => Array.from(v.subarray(i*4, i*4+4)));
}

function normalizeFamily(family) {
  const found = FAMILIES.filter(v=>v!=='Custom').find(v => v.toLowerCase() === family.toLowerCase());
  return found ?? 'External';
}

/** Type 11: static rectangle and pan rates in output pixels per nominal frame. */
function parseStaticLayout(v) {
  assert(v.length === 16, 'static layout TLV must be 16 bytes');
  const rect = [readU16LE(v,0), readU16LE(v,2), readU16LE(v,4), readU16LE(v,6)];
  const panX = readF32LE(v,8), panY = readF32LE(v,12);
  assert(rect[2] >= 1 && rect[2] <= STATIC_MAX_WIDTH && rect[3] >= 1 && rect[3] <= STATIC_MAX_HEIGHT, 'static layout rectangle size out of range');
  for (const [n,value] of [['pan X',panX],['pan Y',panY]]) assert(isFiniteNumber(value) && value >= -8 && value <= 8, `static ${n} out of range: ${value}`);
  return { rect, panX, panY };
}

export const STATIC_RANGE_REVERSE = 1, STATIC_RANGE_BLEND = 2;
/** Type 12: CI8 palette strip and color-cycling ranges. */
function parseStaticPalette(v) {
  assert(v.length >= 7 && (v.length - 7) % 5 === 0, 'static palette TLV has invalid length');
  const strip = [readU16LE(v,0), readU16LE(v,2), readU16LE(v,4), 1], rangeCount = v[6];
  assert(v.length === 7 + rangeCount * 5, 'static palette range count does not match length');
  assert(strip[2] >= 1 && strip[2] <= 256, 'static palette must have 1..256 colors');
  assert(rangeCount <= 16, 'static palette allows at most 16 ranges');
  const ranges = [], used = new Uint8Array(256);
  for (let i = 0; i < rangeCount; i++) {
    const o = 7 + i * 5, range = { start: v[o], length: v[o+1], stepTicks: readU16LE(v,o+2), flags: v[o+4] };
    assert(range.length >= 2 && range.start + range.length <= strip[2], `static palette range ${i} exceeds the palette`);
    assert(range.stepTicks >= 1, `static palette range ${i} needs step_ticks >= 1`);
    assert((range.flags & ~3) === 0, `static palette range ${i} has invalid flags`);
    for (let j = range.start; j < range.start + range.length; j++) { assert(!used[j], `static palette range ${i} overlaps another`); used[j] = 1; }
    ranges.push(range);
  }
  return { strip, ranges };
}

function rectBottom(r) { return zeroRect(r) ? 0 : r[1] + r[3]; }

export function parseThemeImage(image, { extractArtwork = true } = {}) {
  const rows = metadataRowsProbe(image);
  const bytes = metadataBytesFromImage(image, rows);
  const headerSize = readU16LE(bytes,6);
  assert(headerSize >= 16 && headerSize <= rows * METADATA_BYTES_PER_ROW, `invalid header size ${headerSize}`);
  assert(readU32LE(bytes,8) === 0, 'version 1 feature flags must be zero');
  const expectedCrc = readU32LE(bytes,12), actualCrc = crc32(bytes,16,headerSize);
  assert(expectedCrc === actualCrc, `metadata CRC mismatch: file ${expectedCrc.toString(16)}, computed ${actualCrc.toString(16)}`);

  const records = new Map();
  const unknownRecords = [];
  let o = 16, sawEnd = false;
  while (o < headerSize) {
    assert(o + 3 <= headerSize, 'truncated TLV header');
    const type = bytes[o], len = readU16LE(bytes,o+1); o += 3;
    assert(o + len <= headerSize, `truncated TLV type ${type}`);
    const value = bytes.slice(o, o + len); o += len;
    if (type === 0) {
      assert(len === 0, 'end TLV must have zero length');
      assert(o === headerSize, 'end TLV must terminate the body');
      sawEnd = true; break;
    }
    if ((type >= 1 && type <= 9) || type === 11 || type === 12) {
      assert(!records.has(type), `known TLV type ${type} occurs more than once`);
      records.set(type, value);
    } else unknownRecords.push({ type, value });
  }
  assert(sawEnd, 'theme body does not end with type 0');
  for (const required of [1,2,3]) assert(records.has(required), `missing required TLV type ${required}`);

  const nameBytes = records.get(1), familyBytes = records.get(2);
  for (const [n,v] of [['theme name',nameBytes],['picker family',familyBytes]]) {
    assert(v.length >= 1 && v.length <= 63, `${n} must be 1..63 bytes`);
    assert(!v.includes(0), `${n} must not contain NUL`);
  }
  const name = TD.decode(nameBytes), family = TD.decode(familyBytes), colors = decodeColors(records.get(3));
  assert(name.toLowerCase()!=='custom','theme name Custom is reserved');
  const background = records.has(4) ? parseBackground(records.get(4)) : { mode: 'solid' };

  let regions = null;
  if (records.has(5)) {
    const v = records.get(5); assert(v.length === 12, 'artwork regions TLV must be 12 bytes');
    regions = { layer0: readRect(v,0), layer1: readRect(v,4), border: readRect(v,8) };
    validateTextureRect(regions.layer0,image,'layer 0');
    validateTextureRect(regions.layer1,image,'layer 1');
    for (const r of [regions.layer0,regions.layer1,regions.border]) assert(!rectIntersectsMetadata(r,rows), 'metadata pixels must not be used by artwork');
    if (!zeroRect(regions.border)) {
      assert(regions.border[2] === 24 && regions.border[3] === 24, 'embedded border must be exactly 24x24');
      assert(rectFits(regions.border,image), 'embedded border lies outside PNG');
    }
  }

  if (background.mode === 'single') {
    assert(regions && !zeroRect(regions.layer0), 'single texture mode requires layer 0 artwork');
  } else if (background.mode === 'dual') {
    assert(regions && !zeroRect(regions.layer0) && !zeroRect(regions.layer1), 'dual texture mode requires both texture layers');
    const f0 = textureFormat(regions.layer0), f1 = textureFormat(regions.layer1);
    assert(f0 === f1, 'mixed CI4/RGBA16 dual backgrounds are invalid');
    let footprint = encodedFootprint(regions.layer0,f0);
    const sameAnimation=!records.has(8)||Array.from(records.get(8).subarray(0,5)).every((v,i)=>v===records.get(8)[i+5]);
    if (!sameRect(regions.layer0,regions.layer1)||!sameAnimation) footprint += encodedFootprint(regions.layer1,f1);
    assert(footprint <= (f0 === 'CI4' ? 2048 : 4096), `${f0} dual texture TMEM footprint ${footprint} exceeds limit`);
  }

  if (background.overlay) {
    assert(regions && !zeroRect(regions.layer0) && zeroRect(regions.layer1), 'static overlay requires layer 0 artwork and no layer 1');
  }
  const textureAnimations=records.has(8)?parseTextureAnimations(records.get(8),background.overlay?{mode:'single'}:background,regions,image,rows):null;
  const parameterAnimation=records.has(9)?parseParameterAnimation(records.get(9),image,rows):null;
  const staticLayout = records.has(11) ? parseStaticLayout(records.get(11)) : null;
  const staticPalette = records.has(12) ? parseStaticPalette(records.get(12)) : null;
  if (!staticLayout) assert(image.width <= 640 && image.height <= 484, 'packages without a static layout are at most 640x484');
  if (background.mode === 'static' && !staticLayout) {
    assert(!background.overlay && !regions && !textureAnimations && !parameterAnimation,
      'static image backgrounds without a layout cannot contain textures or animations');
  }
  if (staticLayout) {
    assert(background.mode === 'static', 'static layout requires a static background');
    const r = staticLayout.rect;
    assert(rectFits(r, image) && r[1] >= rows, 'static layout rectangle must fit below the metadata');
    assert(r[2] * r[3] <= (staticPalette ? 1280 * 480 : 640 * 480), 'static image area exceeds its format limit');
    const above = [rows];
    if (regions) for (const [r0, a] of [[regions.layer0, textureAnimations?.layer0], [regions.layer1, textureAnimations?.layer1], [regions.border, null]])
      for (const f of (a && a.frameCount > 1 ? animationRects(r0, a, image, rows, 'texture') : [r0])) above.push(rectBottom(f));
    if (parameterAnimation) for (const f of animationRects(parameterAnimation.rect, parameterAnimation.animation, image, rows, 'parameter')) above.push(rectBottom(f));
    if (staticPalette) {
      assert(rectFits(staticPalette.strip, image) && staticPalette.strip[1] >= rows, 'static palette strip must fit below the metadata');
      above.push(rectBottom(staticPalette.strip));
    }
    assert(r[1] >= Math.max(...above), 'static layout rectangle must start below all other artwork');
  }
  if (staticPalette) assert(staticLayout, 'static palette requires a static layout');

  const hasEmbeddedBorder = !!(regions && !zeroRect(regions.border));
  const hasInternalBorder = records.has(7);
  assert(hasEmbeddedBorder !== hasInternalBorder, 'exactly one border source is required');
  let border;
  if (hasEmbeddedBorder) {
    assert(records.has(6), 'embedded border requires type 6 geometry');
    const v = records.get(6); assert(v.length === 3, 'border geometry TLV must be 3 bytes');
    border = { source: 'embedded', tabOverlap: v[0], tabJoinDepth: v[1], selectedExpansion: v[2] };
  } else {
    assert(!records.has(6), 'internal border must not include type 6 geometry');
    const v = records.get(7); assert(v.length === 1, 'internal border TLV must be 1 byte');
    assert(v[0] < BORDER_NAMES.length, `unknown internal border ID ${v[0]}`);
    const [tabOverlap,tabJoinDepth,selectedExpansion] = INTERNAL_BORDER_GEOMETRY[v[0]];
    border = { source: 'internal', id: v[0], name: BORDER_NAMES[v[0]], tabOverlap, tabJoinDepth, selectedExpansion };
  }

  const artwork = {};
  if (staticPalette) {
    // Checked on every parse so packing validates what readers rely on: the
    // static rectangle holds gray index pixels below the palette size.
    const [sx, sy, count] = staticPalette.strip, colors = [];
    for (let i = 0; i < count; i++) {
      const p = (sy * image.width + sx + i) * 4, c = Array.from(image.data.subarray(p, p + 4));
      assert(c[3] === 255, `static palette color ${i} must be opaque`);
      colors.push(c);
    }
    const [x0, y0, w, h] = staticLayout.rect;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const p = (y * image.width + x) * 4, d = image.data;
      if (d[p] >= count || d[p+1] !== d[p] || d[p+2] !== d[p] || d[p+3] !== 255)
        throw new Error(`static pixel (${x - x0},${y - y0}) is not an opaque gray palette index below ${count}`);
    }
    artwork.staticPalette = colors;
  }
  if (extractArtwork && staticLayout) artwork.staticBackground = cropImage(image, staticLayout.rect);
  else if (extractArtwork && background.mode === 'static') {
    assert(image.width <= 640 && image.height-rows >= 1 && image.height-rows <= 480,
      'static background artwork must be at most 640x480');
    artwork.staticBackground=cropImage(image,[0,rows,image.width,image.height-rows]);
  }
  if (extractArtwork && regions) {
    const a0=textureAnimations?.layer0??{frameCount:0},a1=textureAnimations?.layer1??{frameCount:0};
    if (!zeroRect(regions.layer0)){artwork.layer0Frames=animationRects(regions.layer0,a0,image,rows,'layer 0').map(r=>cropImage(image,r));artwork.layer0=artwork.layer0Frames[0];}
    if (!zeroRect(regions.layer1)){if(sameRect(regions.layer0,regions.layer1)&&JSON.stringify(a0)===JSON.stringify(a1)&&artwork.layer0){artwork.layer1=artwork.layer0;artwork.layer1Frames=artwork.layer0Frames;}else{artwork.layer1Frames=animationRects(regions.layer1,a1,image,rows,'layer 1').map(r=>cropImage(image,r));artwork.layer1=artwork.layer1Frames[0];}}
    if (!zeroRect(regions.border)) artwork.border = cropImage(image, regions.border);
  }

  return {
    version: 1, metadataRows: rows, headerSize, name, family, nameBytes, familyBytes, displayFamily: normalizeFamily(family), colors,
    background, regions, border, artwork, textureAnimations, parameterAnimation, staticLayout, staticPalette, unknownRecords
  };
}

function tlv(type, value) {
  const out = new Uint8Array(3 + value.length); out[0] = type; writeU16LE(out,1,value.length); out.set(value,3); return out;
}
function concat(parts) { const n=parts.reduce((s,p)=>s+p.length,0), out=new Uint8Array(n); let o=0; for(const p of parts){out.set(p,o);o+=p.length;} return out; }
function encodeStringRecord(type, value, label, rawBytes = null) {
  let b;
  if (rawBytes && TD.decode(rawBytes) === (value ?? '')) b = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  else b = TE.encode(value ?? '');
  assert(b.length >= 1 && b.length <= 63, `${label} must encode to 1..63 bytes`); assert(!b.includes(0), `${label} must not contain NUL`); return tlv(type,b);
}
function encodeColors(colors) {
  assert(Array.isArray(colors) && colors.length === 16, 'theme.colors must contain 16 RGBA colors');
  const v = new Uint8Array(64);
  colors.forEach((c,i) => { assert(Array.isArray(c) && c.length === 4, `color ${i} must be RGBA`); c.forEach((n,j)=>{ assert(Number.isInteger(n)&&n>=0&&n<=255,`color ${i}[${j}] must be 0..255`); v[i*4+j]=n; }); });
  return tlv(3,v);
}
function encodeBackground(bg) {
  if (!bg || bg.mode === 'solid') return null;
  if (bg.mode === 'static' && !bg.overlay) return tlv(4,new Uint8Array([5]));
  if (bg.mode === 'static') {
    validateMotion(bg.scale,bg.velocityX,bg.velocityY,bg.rotation); const v=new Uint8Array(18); v[0]=5; writeF32LE(v,1,bg.scale); writeF32LE(v,5,bg.velocityX); writeF32LE(v,9,bg.velocityY); writeF32LE(v,13,bg.rotation); v[17]=byte(bg.alpha,'alpha'); return tlv(4,v);
  }
  if (bg.mode === 'gradient') {
    validateMotionLikeGradient(bg); const v=new Uint8Array(9); v[0]=3; writeF32LE(v,1,bg.speed); writeF32LE(v,5,bg.warp); return tlv(4,v);
  }
  if (bg.mode === 'single') {
    validateMotion(bg.scale,bg.velocityX,bg.velocityY,bg.rotation); const v=new Uint8Array(18); v[0]=2; writeF32LE(v,1,bg.scale); writeF32LE(v,5,bg.velocityX); writeF32LE(v,9,bg.velocityY); writeF32LE(v,13,bg.rotation); v[17]=byte(bg.alpha,'alpha'); return tlv(4,v);
  }
  if (bg.mode === 'dual') {
    validateMotion(bg.scale0,bg.velocityX0,bg.velocityY0,bg.rotation); validateMotion(bg.scale1,bg.velocityX1,bg.velocityY1,bg.rotation); const v=new Uint8Array(31); v[0]=1; writeF32LE(v,1,bg.scale0); writeF32LE(v,5,bg.scale1); writeF32LE(v,9,bg.velocityX0); writeF32LE(v,13,bg.velocityY0); writeF32LE(v,17,bg.velocityX1); writeF32LE(v,21,bg.velocityY1); writeF32LE(v,25,bg.rotation); v[29]=byte(bg.alpha0,'alpha0'); v[30]=byte(bg.alpha1,'alpha1'); return tlv(4,v);
  }
  throw new Error(`unknown background mode ${bg.mode}`);
}
function validateMotionLikeGradient(bg){ assert(isFiniteNumber(bg.speed)&&bg.speed>=0&&bg.speed<=2,'gradient speed out of range'); assert(isFiniteNumber(bg.warp)&&bg.warp>=0&&bg.warp<=1,'gradient warp out of range'); }
function byte(v,n){ assert(Number.isInteger(v)&&v>=0&&v<=255,`${n} must be 0..255`); return v; }

function animationBytes(a={frameCount:0,columns:0,frameTicks:0,flags:0}){const v=new Uint8Array(5);v[0]=a.frameCount??0;v[1]=a.columns??0;writeU16LE(v,2,a.frameTicks??0);v[4]=a.flags??0;return v;}
function encodeTextureAnimations(value){if(!value)return null;const v=new Uint8Array(10);v.set(animationBytes(value.layer0),0);v.set(animationBytes(value.layer1),5);return tlv(8,v);}
function parameterSheet(parameter,rows){
  if(!parameter)return null;const a=parameter.animation,frames=parameter.frames,width=Math.ceil(PARAM_SIZES.reduce((n,size,i)=>n+((parameter.mask>>>i)&1?size:0),0)/3),columns=a.columns,height=Math.ceil(a.frameCount/columns),image={width:64,height,data:new Uint8ClampedArray(64*height*4)};
  for(let i=0;i<a.frameCount;i++){const payload=frames[i];assert(payload&&payload.length<=width*3,`parameter frame ${i} payload is invalid`);const x0=(i%columns)*width,y=Math.floor(i/columns);assert(x0+width<=64,'parameter animation columns exceed PNG width');for(let x=0;x<width;x++){const p=(y*64+x0+x)*4;image.data[p]=payload[x*3]??0;image.data[p+1]=payload[x*3+1]??0;image.data[p+2]=payload[x*3+2]??0;image.data[p+3]=255;}}
  return {image,rect:[0,rows,width,1]};
}
function encodeParameterAnimation(parameter,rect){if(!parameter)return null;const v=new Uint8Array(13);writeU32LE(v,0,parameter.mask);v.set(rect,4);v.set(animationBytes(parameter.animation),8);return tlv(9,v);}

function canonicalRegions(theme, artwork, rows, parameterPacked=null) {
  let y = rows+(parameterPacked?.image.height??0);
  const regions = { layer0:[0,0,0,0], layer1:[0,0,0,0], border:[0,0,0,0] };
  const placements = [];
  const bg = theme.background ?? {mode:'solid'};
  if (bg.mode === 'single' || bg.mode === 'dual' || bg.overlay) {
    assert(artwork.layer0, `${bg.mode} background requires artwork.layer0`);
    assert(artwork.layer0.width <= 64 && artwork.layer0.height <= 64 && isPow2(artwork.layer0.width) && isPow2(artwork.layer0.height), 'layer0 dimensions must be powers of two <=64');
    const frames0=artwork.layer0Frames?.length?artwork.layer0Frames:[artwork.layer0],a0=theme.textureAnimations?.layer0;
    const cols0=a0?.frameCount>1?a0.columns:1,rows0=Math.ceil(frames0.length/cols0);assert(cols0*artwork.layer0.width<=64,'layer0 animation columns exceed PNG width');regions.layer0=[0,y,artwork.layer0.width,artwork.layer0.height];frames0.forEach((im,i)=>{assert(im.width===artwork.layer0.width&&im.height===artwork.layer0.height,'layer0 animation frame dimensions differ');placements.push([im,(i%cols0)*im.width,y+Math.floor(i/cols0)*im.height]);});y+=rows0*artwork.layer0.height;
    if (bg.mode === 'dual') {
      assert(artwork.layer1, 'dual background requires artwork.layer1');
      const sameAnimation=JSON.stringify(theme.textureAnimations?.layer0??null)===JSON.stringify(theme.textureAnimations?.layer1??null);
      const shared = (artwork.layer1 === artwork.layer0 || artwork.layer1Frames===artwork.layer0Frames || theme.sharedLayer === true)&&sameAnimation;
      if (shared) regions.layer1 = [...regions.layer0];
      else {
        assert(artwork.layer1.width <= 64 && artwork.layer1.height <= 64 && isPow2(artwork.layer1.width) && isPow2(artwork.layer1.height), 'layer1 dimensions must be powers of two <=64');
        const frames1=artwork.layer1Frames?.length?artwork.layer1Frames:[artwork.layer1],a1=theme.textureAnimations?.layer1,cols1=a1?.frameCount>1?a1.columns:1,rows1=Math.ceil(frames1.length/cols1);assert(cols1*artwork.layer1.width<=64,'layer1 animation columns exceed PNG width');regions.layer1=[0,y,artwork.layer1.width,artwork.layer1.height];frames1.forEach((im,i)=>{assert(im.width===artwork.layer1.width&&im.height===artwork.layer1.height,'layer1 animation frame dimensions differ');placements.push([im,(i%cols1)*im.width,y+Math.floor(i/cols1)*im.height]);});y+=rows1*artwork.layer1.height;
      }
    }
  }
  if ((theme.border?.source ?? 'internal') === 'embedded') {
    assert(artwork.border && artwork.border.width===24 && artwork.border.height===24, 'embedded border requires 24x24 artwork.border');
    regions.border=[0,y,24,24]; placements.push([artwork.border,0,y]); y+=24;
  }
  assert(y <= MAX_HEIGHT, `canonical packed PNG would be ${y}px high; max is ${MAX_HEIGHT}`);
  if(parameterPacked)placements.unshift([parameterPacked.image,0,rows]);
  return { regions, placements, height: Math.max(rows,y) };
}

function encodeRegions(regions) {
  const v=new Uint8Array(12); let o=0; for(const r of [regions.layer0,regions.layer1,regions.border]) for(const n of r) v[o++]=byte(n,'region byte'); return tlv(5,v);
}
function needsRegions(theme){ const m=theme.background?.mode??'solid'; return m==='single'||m==='dual'||!!theme.background?.overlay||theme.border?.source==='embedded'; }
/** Static packages with an overlay, palette or pan use the type-11 layout. */
function usesStaticLayout(theme){ return theme.background?.mode==='static'&&!!(theme.staticLayout||theme.staticPalette||theme.background.overlay); }
function encodeStaticLayout(rect,layout){ const v=new Uint8Array(16); rect.forEach((n,i)=>writeU16LE(v,i*2,n)); writeF32LE(v,8,layout?.panX??0); writeF32LE(v,12,layout?.panY??0); return tlv(11,v); }
function encodeStaticPalette(strip,palette){ const ranges=palette.ranges??[],v=new Uint8Array(7+ranges.length*5); writeU16LE(v,0,strip[0]); writeU16LE(v,2,strip[1]); writeU16LE(v,4,strip[2]); v[6]=ranges.length; ranges.forEach((r,i)=>{const o=7+i*5;v[o]=r.start;v[o+1]=r.length;writeU16LE(v,o+2,r.stepTicks);v[o+4]=r.flags??0;}); return tlv(12,v); }
function headerLength(theme) {
  let n = 16 + encodeStringRecord(1,theme.name,'theme name',theme.nameBytes).length + encodeStringRecord(2,theme.family,'picker family',theme.familyBytes).length + encodeColors(theme.colors).length + 3;
  const bg=encodeBackground(theme.background); if(bg)n+=bg.length;
  if(needsRegions(theme)) n+=15;
  if(theme.border?.source==='embedded') n+=6; else n+=4;
  if(theme.textureAnimations)n+=13;
  if(theme.parameterAnimation)n+=16;
  if(usesStaticLayout(theme))n+=19;
  if(theme.background?.mode==='static'&&theme.staticPalette)n+=10+5*(theme.staticPalette.ranges?.length??0);
  for (const rec of theme.unknownRecords ?? []) n += 3 + rec.value.length;
  return n;
}

export function packThemeImage(theme, artwork = theme.artwork ?? {}) {
  const hlen=headerLength(theme), rows=Math.ceil(hlen/METADATA_BYTES_PER_ROW);
  assert(rows>=1&&rows<=4,`metadata needs ${rows} rows, maximum is 4`);
  const packedParameter=parameterSheet(theme.parameterAnimation,rows);
  const staticImage=theme.background?.mode==='static'?artwork.staticBackground:null;
  const extended=usesStaticLayout(theme);
  if(theme.background?.mode==='static'&&!extended)assert(staticImage&&staticImage.width>=64&&staticImage.width<=640&&staticImage.height>=1&&staticImage.height<=480,'static background artwork must be 64..640 by 1..480');
  let {regions,placements,height}=theme.background?.mode==='static'&&!extended
    ? {regions:{layer0:[0,0,0,0],layer1:[0,0,0,0],border:[0,0,0,0]},placements:[[staticImage,0,rows]],height:rows+staticImage.height}
    : canonicalRegions(theme,artwork,rows,packedParameter);
  // Extended static layout: optional palette strip, then the image last so
  // readers can stream it straight into its surface.
  let staticRect=null,strip=null,imageWidth=WIDTH;
  if(extended){
    assert(staticImage,'static background requires artwork.staticBackground');
    let y=height;
    if(theme.staticPalette){
      const colors=artwork.staticPalette;assert(Array.isArray(colors)&&colors.length>=1&&colors.length<=256,'static palette requires 1..256 artwork.staticPalette colors');
      const im={width:colors.length,height:1,data:new Uint8ClampedArray(colors.length*4)};colors.forEach((c,i)=>im.data.set([c[0],c[1],c[2],255],i*4));
      strip=[0,y,colors.length,1];placements.push([im,0,y]);y+=1;imageWidth=Math.max(imageWidth,colors.length);
    }
    staticRect=[0,y,staticImage.width,staticImage.height];placements.push([staticImage,0,y]);height=y+staticImage.height;imageWidth=Math.max(imageWidth,staticImage.width);
  }

  const parts=[encodeStringRecord(1,theme.name,'theme name',theme.nameBytes), encodeStringRecord(2,theme.family,'picker family',theme.familyBytes), encodeColors(theme.colors)];
  const bg=encodeBackground(theme.background); if(bg)parts.push(bg);
  if(needsRegions(theme))parts.push(encodeRegions(regions));
  if(theme.border?.source==='embedded') {
    const v=new Uint8Array([byte(theme.border.tabOverlap??2,'tabOverlap'),byte(theme.border.tabJoinDepth??3,'tabJoinDepth'),byte(theme.border.selectedExpansion??1,'selectedExpansion')]); parts.push(tlv(6,v));
  } else {
    const id=byte(theme.border?.id??0,'internal border ID'); assert(id<BORDER_NAMES.length,`unknown internal border ID ${id}`); parts.push(tlv(7,new Uint8Array([id])));
  }
  const textureAnimation=encodeTextureAnimations(theme.textureAnimations);if(textureAnimation)parts.push(textureAnimation);
  const parameterAnimation=encodeParameterAnimation(theme.parameterAnimation,packedParameter?.rect);if(parameterAnimation)parts.push(parameterAnimation);
  if(staticRect)parts.push(encodeStaticLayout(staticRect,theme.staticLayout));
  if(strip)parts.push(encodeStaticPalette(strip,theme.staticPalette));
  for(const rec of theme.unknownRecords??[]){ assert(Number.isInteger(rec.type)&&rec.type>=10&&rec.type<=255&&rec.type!==11&&rec.type!==12,'unknown TLV types must be 10 or 13..255'); const v=rec.value instanceof Uint8Array?rec.value:new Uint8Array(rec.value); parts.push(tlv(rec.type,v)); }
  parts.push(new Uint8Array([0,0,0]));
  const body=concat(parts), headerSize=16+body.length;
  assert(headerSize===hlen,'internal header size mismatch');
  const metadata=new Uint8Array(rows*METADATA_BYTES_PER_ROW);
  metadata.set([78,54,52,84,1,rows],0); writeU16LE(metadata,6,headerSize); writeU32LE(metadata,8,0); metadata.set(body,16); writeU32LE(metadata,12,crc32(metadata,16,headerSize));

  if(!extended&&staticImage)imageWidth=staticImage.width;
  const image={width:imageWidth,height,data:new Uint8ClampedArray(imageWidth*height*4)};
  for(let i=0;i<image.data.length;i+=4) image.data[i+3]=255;
  let p=0; for(let y=0;y<rows;y++)for(let x=0;x<WIDTH;x++){const i=(y*imageWidth+x)*4; image.data[i]=metadata[p++]; image.data[i+1]=metadata[p++]; image.data[i+2]=metadata[p++]; image.data[i+3]=255;}
  for(const [src,x,y] of placements)blitImage(image,src,x,y);
  // Parse once to validate every cross-field invariant and return canonical geometry.
  const parsed=parseThemeImage(image,{extractArtwork:false});
  return { image, theme: parsed };
}

export function themeToSerializable(theme, artworkFiles = {}) {
  return {
    format: 'N64T', version: 1, name: theme.name, family: theme.family, nameBytes: theme.nameBytes ? Array.from(theme.nameBytes) : undefined, familyBytes: theme.familyBytes ? Array.from(theme.familyBytes) : undefined, colors: theme.colors,
    background: theme.background,
    border: theme.border.source === 'internal' ? { source:'internal', id:theme.border.id } : { source:'embedded', tabOverlap:theme.border.tabOverlap, tabJoinDepth:theme.border.tabJoinDepth, selectedExpansion:theme.border.selectedExpansion },
    sharedLayer: !!(theme.regions && sameRect(theme.regions.layer0,theme.regions.layer1) && !zeroRect(theme.regions.layer0)),
    artwork: artworkFiles,
    staticLayout: theme.staticLayout ? { panX: theme.staticLayout.panX, panY: theme.staticLayout.panY } : undefined,
    staticPalette: theme.staticPalette ? { ranges: theme.staticPalette.ranges } : undefined,
    textureAnimations: theme.textureAnimations ?? undefined,
    parameterAnimation: theme.parameterAnimation ? {...theme.parameterAnimation,frames:theme.parameterAnimation.frames.map(v=>Array.from(v))} : undefined,
    unknownRecords: (theme.unknownRecords??[]).map(r=>({type:r.type,value:Array.from(r.value)}))
  };
}

export function themeFromSerializable(obj) {
  assert(obj && obj.format === 'N64T' && obj.version === 1,'JSON must describe N64T version 1');
  return { ...obj, nameBytes: obj.nameBytes ? new Uint8Array(obj.nameBytes) : null, familyBytes: obj.familyBytes ? new Uint8Array(obj.familyBytes) : null, parameterAnimation:obj.parameterAnimation?{...obj.parameterAnimation,frames:obj.parameterAnimation.frames.map(v=>new Uint8Array(v))}:null, unknownRecords:(obj.unknownRecords??[]).map(r=>({type:r.type,value:new Uint8Array(r.value)})) };
}
