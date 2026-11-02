const VERTEX = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const TEXT_VERTEX = `#version 300 es
in vec2 position;
in vec2 texcoord;
in vec4 color;
uniform vec2 resolution;
uniform vec2 uiOffset;
out vec2 textUv;
out vec4 textColor;
void main() {
  vec2 p=position+uiOffset;
  gl_Position = vec4(p.x/resolution.x*2.0-1.0,1.0-p.y/resolution.y*2.0,0.0,1.0);
  textUv = texcoord;
  textColor = color;
}
`;

const TEXT_FRAGMENT = `#version 300 es
precision mediump float;
in vec4 textColor;
in vec2 textUv;
uniform sampler2D fontAtlas;
uniform vec4 outlineColor;
out vec4 pixel;
void main() {
  vec4 glyph=texture(fontAtlas,textUv);
  pixel=vec4(mix(outlineColor.rgb,textColor.rgb,glyph.r),glyph.a*textColor.a);
}
`;

const FONT = {
  A:['01110','10001','10001','11111','10001','10001','10001'], B:['11110','10001','10001','11110','10001','10001','11110'],
  C:['01111','10000','10000','10000','10000','10000','01111'], D:['11110','10001','10001','10001','10001','10001','11110'],
  E:['11111','10000','10000','11110','10000','10000','11111'], F:['11111','10000','10000','11110','10000','10000','10000'],
  G:['01111','10000','10000','10111','10001','10001','01111'], H:['10001','10001','10001','11111','10001','10001','10001'],
  I:['11111','00100','00100','00100','00100','00100','11111'], J:['00111','00010','00010','00010','10010','10010','01100'],
  K:['10001','10010','10100','11000','10100','10010','10001'], L:['10000','10000','10000','10000','10000','10000','11111'],
  M:['10001','11011','10101','10101','10001','10001','10001'], N:['10001','11001','10101','10011','10001','10001','10001'],
  O:['01110','10001','10001','10001','10001','10001','01110'], P:['11110','10001','10001','11110','10000','10000','10000'],
  Q:['01110','10001','10001','10001','10101','10010','01101'], R:['11110','10001','10001','11110','10100','10010','10001'],
  S:['01111','10000','10000','01110','00001','00001','11110'], T:['11111','00100','00100','00100','00100','00100','00100'],
  U:['10001','10001','10001','10001','10001','10001','01110'], V:['10001','10001','10001','10001','10001','01010','00100'],
  W:['10001','10001','10001','10101','10101','10101','01010'], X:['10001','10001','01010','00100','01010','10001','10001'],
  Y:['10001','10001','01010','00100','00100','00100','00100'], Z:['11111','00001','00010','00100','01000','10000','11111'],
  0:['01110','10001','10011','10101','11001','10001','01110'], 1:['00100','01100','00100','00100','00100','00100','01110'],
  2:['01110','10001','00001','00010','00100','01000','11111'], 3:['11110','00001','00001','01110','00001','00001','11110'],
  4:['00010','00110','01010','10010','11111','00010','00010'], 5:['11111','10000','10000','11110','00001','00001','11110'],
  6:['01110','10000','10000','11110','10001','10001','01110'], 7:['11111','00001','00010','00100','01000','01000','01000'],
  8:['01110','10001','10001','01110','10001','10001','01110'], 9:['01110','10001','10001','01111','00001','00001','01110'],
  '-':['00000','00000','00000','11111','00000','00000','00000'], '.':['00000','00000','00000','00000','00000','00110','00110'],
  ':':['00000','00110','00110','00000','00110','00110','00000'], ' ':['00000','00000','00000','00000','00000','00000','00000']
};

const FRAGMENT = `#version 300 es
precision highp float;
// Console coordinates are 1/1024-texel integers well beyond mediump's 16 bits.
precision highp int;
uniform vec4 colors[16];
uniform sampler2D layer0;
uniform sampler2D layer1;
uniform sampler2D borderTexture;
// Static images, drawn with the console's arithmetic (see src/rdp-static.mjs).
uniform highp isampler2D staticCols;   // 640x1: s (1/1024 texel), slice first/last column, class (-1: not drawn)
uniform highp isampler2D staticRows;   // 480 x classes: t, strip first/last loaded row, covered
uniform highp usampler2D staticIndex;  // CI8 indices (R8UI), or 5-bit RGB (RGBA8UI)
uniform highp usampler2D staticPal;    // 256x1 5-bit palette for CI8 (cycled each frame)
uniform bool staticCi8;
uniform bool staticFiltered;
uniform highp usampler2D overlayTex;   // layer 0 as 5-bit RGB + alpha bit
uniform ivec4 overlayStep;             // dsdx, dtdy, tile origin s, t (1/1024 texel)
uniform int overlayAlpha;              // 0: no overlay
uniform bool overlayApprox;            // rotated overlays use the float path
uniform int mode;
uniform float time;
uniform vec4 params0;
uniform vec4 params1;
uniform vec2 velocity0;
uniform vec2 velocity1;
uniform vec3 borderGeometry;
uniform vec2 menuSelection;
uniform vec2 resolution;
uniform vec2 uiOffset;
uniform bool hideUi;
out vec4 pixel;

vec4 texturePixel(sampler2D tex, vec2 p, float scale, vec2 velocity, float rotation) {
  float a = rotation * time * 60.0;
  mat2 r = mat2(cos(a), sin(a), -sin(a), cos(a));
  vec2 uv = (r * (p - vec2(320.0, 240.0)) + vec2(320.0, 240.0)) * scale;
  // As on the console, positive velocity moves the texture right/down on
  // screen by 8 texels per nominal 60 Hz frame.
  uv -= velocity * (time * 480.0);
  vec2 size=vec2(textureSize(tex,0));
  uv=mod(mod(uv,size)+size,size);
  uv=floor(uv*32.0)/32.0;
  ivec2 sz=textureSize(tex,0),coord=ivec2(floor(uv));
  ivec2 ax=ivec2((coord.x+1)%sz.x,coord.y),ay=ivec2(coord.x,(coord.y+1)%sz.y),axy=ivec2((coord.x+1)%sz.x,(coord.y+1)%sz.y);
  ivec2 frac=ivec2(fract(uv)*32.0);
  ivec4 c0=ivec4(round(texelFetch(tex,coord,0)*255.0)),cx=ivec4(round(texelFetch(tex,ax,0)*255.0)),cy=ivec4(round(texelFetch(tex,ay,0)*255.0)),cxy=ivec4(round(texelFetch(tex,axy,0)*255.0));
  bool upper=frac.x+frac.y>=32;
  ivec4 base=upper?cxy:c0;
  ivec2 factor=upper?ivec2(32-frac.y,32-frac.x):frac;
  ivec4 value=(((cx-base)*factor.x+(cy-base)*factor.y+16)>>5)+base;
  return vec4(value)/255.0;
}

ivec3 replicate5(uvec3 v) { ivec3 i = ivec3(v); return (i << 3) | (i >> 2); }

ivec3 staticTexel(int x, int y) {
  if (staticCi8) return replicate5(texelFetch(staticPal, ivec2(int(texelFetch(staticIndex, ivec2(x, y), 0).r), 0), 0).rgb);
  return replicate5(texelFetch(staticIndex, ivec2(x, y), 0).rgb);
}

// RDP 3-point filter: 1/32-texel fractions, +16 rounding.
ivec4 threePoint(ivec4 base, ivec4 cx, ivec4 cy, int fx, int fy) {
  bool upper = fx + fy >= 32;
  int ax = upper ? 32 - fy : fx, ay = upper ? 32 - fx : fy;
  return (((cx - base) * ax + (cy - base) * ay + 16) >> 5) + base;
}

// The static image's 5-bit color at pixel q, or -1 where no rectangle draws.
ivec3 staticPixel(ivec2 q) {
  ivec4 col = texelFetch(staticCols, ivec2(q.x, 0), 0);
  if (col.w < 0) return ivec3(-1);
  ivec4 row = texelFetch(staticRows, ivec2(q.y, col.w), 0);
  if (row.w == 0) return ivec3(-1);
  int sx = col.x >> 10, ty = row.x >> 10, fx = (col.x & 1023) >> 5, fy = (row.x & 1023) >> 5;
  int s0 = clamp(sx, col.y, col.z), s1 = clamp(sx + 1, col.y, col.z);
  int t0 = clamp(ty, row.y, row.z), t1 = clamp(ty + 1, row.y, row.z);
  if (!staticFiltered) return staticTexel(s0, t0) >> 3;
  bool upper = fx + fy >= 32;
  ivec3 base = upper ? staticTexel(s1, t1) : staticTexel(s0, t0);
  return threePoint(ivec4(base, 0), ivec4(staticTexel(s1, t0), 0), ivec4(staticTexel(s0, t1), 0), fx, fy).rgb >> 3;
}

const int MAGIC[16] = int[16](0, 6, 1, 7, 4, 2, 5, 3, 3, 5, 2, 4, 7, 1, 6, 0);

ivec4 overlayTexel(int x, int y, ivec2 size) {
  uvec4 v = texelFetch(overlayTex, ivec2(((x % size.x) + size.x) % size.x, ((y % size.y) + size.y) % size.y), 0);
  return ivec4(replicate5(v.rgb), v.a != 0u ? 255 : 0);
}

// The overlay rectangle over a 5-bit framebuffer color: TEX x PRIM in the
// combiner, forced blend, magic-square dither, 5-bit write.
ivec3 overlayPixel(ivec3 fb, ivec2 q) {
  ivec2 size = textureSize(overlayTex, 0);
  int s = q.x * overlayStep.x - overlayStep.z, t = q.y * overlayStep.y - overlayStep.w;
  int sx = s >> 10, ty = t >> 10, fx = (s & 1023) >> 5, fy = (t & 1023) >> 5;
  bool upper = fx + fy >= 32;
  ivec4 px = threePoint(upper ? overlayTexel(sx + 1, ty + 1, size) : overlayTexel(sx, ty, size),
                        overlayTexel(sx + 1, ty, size), overlayTexel(sx, ty + 1, size), fx, fy);
  int a = (px.a * overlayAlpha + 0x80) >> 8;
  if (a == 0) return fb;
  int b1 = a >> 3, mulb = ((~a & 0xff) >> 3) + 1, dith = MAGIC[((q.y & 3) << 2) | (q.x & 3)];
  ivec3 c = (((px.rgb * 255 + 0x80) >> 8) * b1 + (fb << 3) * mulb) >> 5 & 0xff;
  ivec3 up = ivec3(c.r > 247 ? 255 : (c.r & 0xf8) + 8, c.g > 247 ? 255 : (c.g & 0xf8) + 8, c.b > 247 ? 255 : (c.b & 0xf8) + 8);
  c = ivec3((c.r & 7) > dith ? up.r : c.r, (c.g & 7) > dith ? up.g : c.g, (c.b & 7) > dith ? up.b : c.b);
  return c >> 3;
}

float box(vec2 p, vec4 r) {
  return step(r.x, p.x) * step(r.y, p.y) * step(p.x, r.x + r.z) * step(p.y, r.y + r.w);
}

int sign9(int value){int bits=value&511;return bits>=256?bits-512:bits;}
int specialExpand(int value){return sign9(value-128)+128;}
int clamp9(int value){return clamp(sign9(value-128)+128,0,255);}
ivec3 combine(ivec3 a,ivec3 b,ivec3 m,ivec3 d){
  a=ivec3(specialExpand(a.r),specialExpand(a.g),specialExpand(a.b));
  b=ivec3(specialExpand(b.r),specialExpand(b.g),specialExpand(b.b));
  d=ivec3(specialExpand(d.r),specialExpand(d.g),specialExpand(d.b));
  m=ivec3(sign9(m.r),sign9(m.g),sign9(m.b));
  return (((a-b)*m+128)>>8)+d;
}
int combineAlpha(int a,int b,int m,int d){return (((specialExpand(a)-specialExpand(b))*sign9(m)+128)>>8)+specialExpand(d);}
vec3 rgb16i(ivec3 c){return vec3(clamp(c,ivec3(0),ivec3(255))>>3)/31.0;}
vec3 rgb16(vec3 c){return rgb16i(ivec3(round(clamp(c,0.0,1.0)*255.0)));}
vec3 rgb16Bayer(vec3 c,vec2 p){
  const int d[16]=int[16](0,4,1,5,4,0,5,1,3,7,2,6,7,3,6,2);
  ivec3 v=ivec3(round(clamp(c,0.0,1.0)*255.0));int threshold=d[(int(p.y)&3)*4+(int(p.x)&3)];
  ivec3 rounded=min((v&ivec3(248))+8,ivec3(255));v=ivec3((v.r&7)>threshold?rounded.r:v.r,(v.g&7)>threshold?rounded.g:v.g,(v.b&7)>threshold?rounded.b:v.b);
  return rgb16i(v);
}
void over(inout vec4 dst, vec4 src, float mask) { dst.rgb=rgb16(mix(dst.rgb,src.rgb,mask*src.a));dst.a=1.0; }

vec2 patchUv(vec2 local, vec2 size) {
  float x = local.x < 8.0 ? local.x : local.x >= size.x-8.0 ? 16.0+local.x-(size.x-8.0) : 8.0+mod(local.x-8.0,8.0);
  float y = local.y < 8.0 ? local.y : local.y >= size.y-8.0 ? 16.0+local.y-(size.y-8.0) : 8.0+mod(local.y-8.0,8.0);
  // Fragment positions are already at pixel centers. Mapping local .5 to
  // texel center .5 preserves the RDP rectangle's complete eight-pixel patch.
  return vec2(x,y)/24.0;
}

void ninePatch(inout vec4 dst, vec2 p, vec4 rect, vec4 fill, vec4 tint, bool bottom) {
  if (box(p,rect)==0.0) return;
  vec2 local=p-rect.xy;
  vec2 uv=patchUv(local,rect.zw);
  if(!bottom&&local.y>=8.0)uv.y=(8.0+mod(local.y-8.0,8.0))/24.0;
  vec4 texel=texture(borderTexture,uv);
  if(!bottom&&local.y>=8.0&&local.x>=8.0&&local.x<rect.z-8.0)texel.a=0.0;
  over(dst,fill,1.0);
  over(dst,vec4(texel.rgb*tint.rgb,texel.a*tint.a),1.0);
}

void main() {
  vec2 screen = vec2(gl_FragCoord.x, resolution.y - gl_FragCoord.y);
  vec2 p = screen - uiOffset;
  vec4 c = colors[0];
  if (mode == 1) {
    float phase = params0.x * time * 6.2831853;
    vec2 uv = p / vec2(640.0, 480.0);
    uv += vec2(sin(phase + uv.y * 4.1), cos(phase * .83 + uv.x * 3.7)) * params0.y;
    vec4 top = mix(colors[12], colors[13], clamp(uv.x, 0.0, 1.0));
    vec4 bottom = mix(colors[14], colors[15], clamp(uv.x, 0.0, 1.0));
    c = mix(top, bottom, clamp(uv.y, 0.0, 1.0));
    c.rgb=rgb16Bayer(c.rgb,screen);
  } else if (mode == 2) {
    vec4 a = texturePixel(layer0, p, params0.x, velocity0, params0.y);
    ivec3 texel=ivec3(round(a.rgb*255.0));
    ivec3 result=combine(texel,ivec3(0),ivec3(255),ivec3(0));
    c.rgb=rgb16i(ivec3(clamp9(result.r),clamp9(result.g),clamp9(result.b)));
  } else if (mode == 4) {
    ivec2 q = ivec2(floor(p));
    ivec3 fb = staticPixel(q);
    if (fb.r < 0) fb = ivec3(round(colors[0].rgb * 31.0));
    if (overlayAlpha > 0 && !overlayApprox) fb = overlayPixel(fb, q);
    c = vec4(vec3(fb) / 31.0, 1.0);
    if (overlayAlpha > 0 && overlayApprox) {
      vec4 t = texturePixel(layer0, p, params0.x, velocity0, params0.y);
      c.rgb = rgb16(mix(c.rgb, t.rgb, t.a * params0.z));
    }
  } else if (mode == 3) {
    vec4 a = texturePixel(layer0, p, params0.x, velocity0, params0.z);
    vec4 b = texturePixel(layer1, p, params0.y, velocity1, params0.z);
    ivec3 t0=ivec3(round(a.rgb*255.0)),t1=ivec3(round(b.rgb*255.0)),env=ivec3(round(colors[0].rgb*255.0));
    ivec3 first=combine(t0,env,ivec3(int(round(params0.w*255.0))),env);
    int combinedAlpha=combineAlpha(int(round(b.a*255.0)),0,int(round(params1.x*255.0)),0);
    ivec3 result=combine(t1,first,ivec3(combinedAlpha),first);
    c.rgb=rgb16i(ivec3(clamp9(result.r),clamp9(result.g),clamp9(result.b)));
  }
  c.rgb=rgb16(c.rgb);

  if(hideUi){pixel=vec4(c.rgb,1.0);return;}

  float overlapLeft=floor(borderGeometry.x*.5), overlapRight=borderGeometry.x-overlapLeft;
  float tabTop=params1.y;
  for (int i = 0; i < 4; i++) {
    float x0=24.0+floor(592.0*float(i)/5.0), x1=24.0+floor(592.0*float(i+1)/5.0);
    float left=i>0?overlapLeft:0.0, right=i<4?overlapRight:0.0;
    ninePatch(c,p,vec4(x0-left,24.0-tabTop,x1-x0+left+right,28.0+borderGeometry.y+tabTop),colors[7],colors[4],false);
  }
  float selectedLeft=overlapLeft+borderGeometry.z, selectedX=24.0+floor(592.0*4.0/5.0);
  ninePatch(c,p,vec4(selectedX-selectedLeft,19.0-tabTop,616.0-selectedX+selectedLeft,33.0+borderGeometry.y+tabTop),colors[8],colors[2],false);
  ninePatch(c,p,vec4(24.0,52.0,592.0,404.0),colors[1],colors[2],true);
  ninePatch(c,p,vec4(24.0,400.0,592.0,56.0),colors[1],colors[2],true);
  over(c,colors[8],box(p,vec4(32.0,142.0,124.0,33.0)));
  over(c,colors[8],box(p,vec4(168.0,68.0+menuSelection.x*31.0,115.0,25.0)));
  over(c,colors[6],box(p,vec4(298.0,68.0+menuSelection.y*31.0,304.0,25.0)));
  over(c,colors[2],box(p,vec4(160.0,64.0,3.0,330.0)));
  over(c,colors[2],box(p,vec4(288.0,64.0,3.0,330.0)));
  pixel = vec4(c.rgb, 1.0);
}
`;

function shader(gl, type, source) {
  const value = gl.createShader(type);
  gl.shaderSource(value, source);
  gl.compileShader(value);
  if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value));
  return value;
}

function program(gl, vertex, fragment) {
  const value = gl.createProgram();
  gl.attachShader(value, shader(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(value, shader(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(value);
  if (!gl.getProgramParameter(value, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(value));
  return value;
}

const textureImages=new WeakMap();
function textureImage(texture) {
  if (textureImages.has(texture)) return textureImages.get(texture);
  const data=new Uint8Array(texture.width*texture.height*4);
  for(let p=0,i=0;p<texture.width*texture.height;p++,i+=4){const v=texture.kind==='ci4'?texture.palette[texture.indices[p]]:texture.values[p];data[i]=((v>>>11)&31)*255/31;data[i+1]=((v>>>6)&31)*255/31;data[i+2]=((v>>>1)&31)*255/31;data[i+3]=(v&1)*255;}
  const image={width:texture.width,height:texture.height,data};textureImages.set(texture,image);return image;
}

const preparedImages=new WeakMap();
function preparedArtwork(theme){const artwork=theme.artwork;if(!artwork)return prepareArtworkTextures(theme);const hit=preparedImages.get(artwork);if(hit&&hit.layer0===artwork.layer0&&hit.layer1===artwork.layer1&&hit.border===artwork.border)return hit.prepared;const prepared=prepareArtworkTextures(theme);preparedImages.set(artwork,{layer0:artwork.layer0,layer1:artwork.layer1,border:artwork.border,prepared});return prepared;}

export class WebGLThemeRenderer {
  constructor(canvas) {
    if(canvas.width!==640||canvas.height!==480)throw new Error(`Preview canvas must be 640×480, got ${canvas.width}×${canvas.height}`);
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
    if (!gl) throw new Error('This editor requires WebGL 2');
    this.gl = gl;
    this.framebuffer=gl.createFramebuffer();this.colorBuffer=gl.createRenderbuffer();this.targetWidth=0;this.targetHeight=0;
    this.program = program(gl, VERTEX, FRAGMENT);
    gl.useProgram(this.program);
    this.mainVao = gl.createVertexArray();
    gl.bindVertexArray(this.mainVao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.textProgram = program(gl, TEXT_VERTEX, TEXT_FRAGMENT);
    this.textVao = gl.createVertexArray();
    this.textBuffer = gl.createBuffer();
    gl.bindVertexArray(this.textVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.textBuffer);
    const textPosition = gl.getAttribLocation(this.textProgram, 'position');
    const textUv = gl.getAttribLocation(this.textProgram, 'texcoord');
    const textColor = gl.getAttribLocation(this.textProgram, 'color');
    gl.enableVertexAttribArray(textPosition);
    gl.vertexAttribPointer(textPosition, 2, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(textUv);
    gl.vertexAttribPointer(textUv, 2, gl.FLOAT, false, 32, 8);
    gl.enableVertexAttribArray(textColor);
    gl.vertexAttribPointer(textColor, 4, gl.FLOAT, false, 32, 16);
    this.fontTexture=gl.createTexture();
    this.font=null;
    this.loadFont();
    this.textures = [gl.createTexture(), gl.createTexture(), gl.createTexture()];
    this.images = [null, null, null];
    this.intTextures = Object.fromEntries(['staticIndex', 'staticPal', 'staticCols', 'staticRows', 'overlayTex'].map(n => [n, gl.createTexture()]));
    // Integer samplers must always be bound to integer textures, even when unused.
    for (const [unit, name] of [[5, 'staticIndex'], [6, 'staticPal'], [9, 'overlayTex']]) this.uploadInt(unit, name, gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, 1, 1, new Uint8Array(4));
    for (const [unit, name] of [[7, 'staticCols'], [8, 'staticRows']]) this.uploadInt(unit, name, gl.RGBA32I, gl.RGBA_INTEGER, gl.INT, 1, 1, new Int32Array(4));
    gl.uniform1i(this.location('layer0'), 0);
    gl.uniform1i(this.location('layer1'), 1);
    gl.uniform1i(this.location('borderTexture'), 2);


  }

  location(name) { return this.gl.getUniformLocation(this.program, name); }

  /** Upload an integer texture to a fixed unit. */
  uploadInt(unit, name, internal, format, type, width, height, data) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.intTextures[name]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
    gl.uniform1i(this.location(name), unit);
  }

  /**
   * Static images: the image and its palette as integer textures, plus the
   * per-column/per-row tables for this frame. Only the tables and a cycled
   * palette change per frame (a few KB); the shader does the per-pixel work.
   */
  uploadStatic(theme, seconds, overlayTexture) {
    const gl = this.gl, art = theme.artwork, im = art.staticBackground, ci8 = !!art.staticPalette;
    if (this.staticImage !== im) {
      const data = new Uint8Array(im.width * im.height * (ci8 ? 1 : 4));
      for (let p = 0; p < im.width * im.height; p++) {
        if (ci8) data[p] = im.data[p * 4];
        else for (let c = 0; c < 3; c++) data[p * 4 + c] = im.data[p * 4 + c] >> 3;
      }
      this.uploadInt(5, 'staticIndex', ci8 ? gl.R8UI : gl.RGBA8UI, ci8 ? gl.RED_INTEGER : gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, im.width, im.height, data);
      this.staticImage = im;
      this.staticTableKey = null;
    }
    if (ci8) {
      const palette = cycledStaticPalette(art.staticPalette, theme.staticPalette, seconds), data = new Uint8Array(256 * 4);
      palette.forEach((c, i) => { data[i * 4] = c[0] >> 3; data[i * 4 + 1] = c[1] >> 3; data[i * 4 + 2] = c[2] >> 3; });
      this.uploadInt(6, 'staticPal', gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, 256, 1, data);
    }
    const layout = theme.staticLayout, moving = !!(layout?.panX || layout?.panY);
    const key = moving ? null : im;
    if (!key || key !== this.staticTableKey) {
      const tables = staticTables(theme, seconds);
      this.uploadInt(7, 'staticCols', gl.RGBA32I, gl.RGBA_INTEGER, gl.INT, 640, 1, tables.cols);
      this.uploadInt(8, 'staticRows', gl.RGBA32I, gl.RGBA_INTEGER, gl.INT, 480, tables.classes, tables.rows);
      this.staticFiltered = tables.filter;
      this.staticTableKey = key;
    }
    gl.uniform1i(this.location('staticCi8'), ci8 ? 1 : 0);
    gl.uniform1i(this.location('staticFiltered'), this.staticFiltered ? 1 : 0);
    const bg = theme.background;
    if (bg.overlay && overlayTexture) {
      if (this.overlaySource !== overlayTexture) {
        const n = overlayTexture.width * overlayTexture.height, data = new Uint8Array(n * 4);
        for (let i = 0; i < n; i++) {
          const v = overlayTexture.kind === 'ci4' ? overlayTexture.palette[overlayTexture.indices[i]] : overlayTexture.values[i];
          data.set([(v >>> 11) & 31, (v >>> 6) & 31, (v >>> 1) & 31, v & 1], i * 4);
        }
        this.uploadInt(9, 'overlayTex', gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, overlayTexture.width, overlayTexture.height, data);
        this.overlaySource = overlayTexture;
      }
      const o = overlayParams(theme, seconds, overlayTexture);
      gl.uniform4i(this.location('overlayStep'), o.dsdx, o.dtdy, o.su, o.tv);
      gl.uniform1i(this.location('overlayAlpha'), o.alpha);
      gl.uniform1i(this.location('overlayApprox'), bg.rotation ? 1 : 0);
    } else {
      gl.uniform1i(this.location('overlayAlpha'), 0);
    }
  }

  bindRgb16Target() {
    const gl=this.gl,width=gl.drawingBufferWidth,height=gl.drawingBufferHeight;
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.framebuffer);
    if(width!==this.targetWidth||height!==this.targetHeight){gl.bindRenderbuffer(gl.RENDERBUFFER,this.colorBuffer);gl.renderbufferStorage(gl.RENDERBUFFER,gl.RGB5_A1,width,height);gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.RENDERBUFFER,this.colorBuffer);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('RGBA5551 preview framebuffer is incomplete');this.targetWidth=width;this.targetHeight=height;}
  }

  resize(requestedWidth) {
    const canvas=this.gl.canvas,displayWidth=Math.max(1,Math.min(requestedWidth,requestedWidth>=1280?1280:640)),displayHeight=displayWidth*.75,changed=canvas.width!==640||canvas.height!==480||canvas.style.width!==`${displayWidth}px`;
    if(changed){canvas.width=640;canvas.height=480;canvas.style.width=`${displayWidth}px`;canvas.style.height=`${displayHeight}px`;if(this.lastTheme)this.render(this.lastTheme,this.lastSeconds,this.lastHideUi);}
  }

  upload(unit, image) {
    if (this.images[unit] === image) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[unit]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    const nearest = unit === 2 || unit === 4 || unit === 5;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest?gl.NEAREST:gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest?gl.NEAREST:gl.LINEAR);
    const source = image ?? { width: 1, height: 1, data: new Uint8Array([0,0,0,0]) };
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, source.width, source.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.data);
    this.images[unit] = image;
  }

  async loadFont() {
    const face=new FontFace('NFMT Preview','url(./preview-font.ttf)');
    await face.load(); document.fonts.add(face);
    const cellW=40,cellH=24,cols=16,rows=6,canvas=new OffscreenCanvas(cellW*cols,cellH*rows),ctx=canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);ctx.font='15px "NFMT Preview"';ctx.textBaseline='alphabetic';ctx.lineJoin='round';ctx.lineWidth=2;
    const glyphs=new Map();
    for(let code=32;code<=126;code++){const n=code-32,col=n%cols,row=Math.floor(n/cols),x=col*cellW,y=row*cellH,ch=String.fromCharCode(code);ctx.strokeStyle='#000';ctx.strokeText(ch,x+3,y+18);ctx.fillStyle='#fff';ctx.fillText(ch,x+3,y+18);glyphs.set(ch,{u0:x/canvas.width,v0:y/canvas.height,u1:(x+cellW)/canvas.width,v1:(y+cellH)/canvas.height,advance:ctx.measureText(ch).width});}
    const bitmap=await createImageBitmap(canvas),gl=this.gl;gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,this.fontTexture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,bitmap);bitmap.close();this.font={glyphs,cellW,cellH};
    if(this.lastTheme)this.render(this.lastTheme,this.lastSeconds);
  }

  renderText(theme) {
    if(!this.font)return;
    const vertices = [];
    const width=text=>[...String(text)].reduce((n,ch)=>n+(this.font.glyphs.get(ch)?.advance??8),0);
    const add = (x, y, text, color, centerWidth=0, lift=1) => {
      if(centerWidth)x+=(centerWidth-width(text))/2;
      for (const char of String(text)) {
        const g=this.font.glyphs.get(char)??this.font.glyphs.get('-'),x0=x,y0=y-5-lift,x1=x0+this.font.cellW,y1=y0+this.font.cellH,c=color.map(v=>v/255);
        vertices.push(x0,y0,g.u0,g.v0,...c,x1,y0,g.u1,g.v0,...c,x0,y1,g.u0,g.v1,...c,x0,y1,g.u0,g.v1,...c,x1,y0,g.u1,g.v0,...c,x1,y1,g.u1,g.v1,...c);x+=g.advance;
      }
    };
    const addRight=(x,y,text,color)=>add(x-width(text),y,text,color);
    const tabs=['Grid','Files','History','Favorites','Settings'];for(let i=0;i<5;i++){const x0=24+Math.floor(592*i/5),x1=24+Math.floor(592*(i+1)/5);add(x0,30,tabs[i],theme.colors[i===4?3:4],x1-x0,0);}
    const rail=['Menu','Grid','Theme','Controller','Time','Flashcart','N64','Information'];
    for(let i=0;i<rail.length;i++)add(44,79+i*37,rail[i],theme.colors[i===2?3:4]);
    const {names:families,index:familyIndex}=familyPage(theme.displayFamily??theme.family);
    for(let i=0;i<families.length;i++)add(184,72+i*31,families[i],theme.colors[i===familyIndex?3:4]);
    const nature=['Coral Reef','Desert','Forest','Lava','Moonlit Clouds','Nebula','Sakura','Solar Flare','Slime','Water'];
    const names=theme.family==='Nature'?nature:[theme.name];
    if(!names.includes(theme.name))names.push(theme.name);
    for(let i=0;i<names.length&&i<10;i++)add(314,72+i*31,names[i],theme.colors[names[i]===theme.name?3:4]);
    add(42,414,'A: Select',theme.colors[3]);
    add(42,434,'B: Theme families',theme.colors[3]);
    add(240,414,'D-Pad: Choose',theme.colors[3],160);
    add(240,434,'L / R: Tabs',theme.colors[3],160);
    addRight(598,414,'Z: Preview',theme.colors[3]);
    addRight(598,434,'Start: Customize',theme.colors[3]);
    const gl=this.gl, data=new Float32Array(vertices);
    gl.useProgram(this.textProgram);
    gl.uniform2f(gl.getUniformLocation(this.textProgram,'resolution'),gl.drawingBufferWidth,gl.drawingBufferHeight);gl.uniform2f(gl.getUniformLocation(this.textProgram,'uiOffset'),(gl.drawingBufferWidth-640)/2,(gl.drawingBufferHeight-480)/2);
    gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,this.fontTexture);gl.uniform1i(gl.getUniformLocation(this.textProgram,'fontAtlas'),3);gl.uniform4fv(gl.getUniformLocation(this.textProgram,'outlineColor'),theme.colors[9].map(v=>v/255));
    gl.bindVertexArray(this.textVao);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.textBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,data,gl.DYNAMIC_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES,0,data.length/8);
    gl.disable(gl.BLEND);
  }

  render(theme, seconds, hideUi=false) {
    const sourceTheme=theme;
    theme=resolveThemeAnimation(theme,seconds);
    const gl = this.gl, bg = theme.background;
    this.lastTheme=sourceTheme;this.lastSeconds=seconds;this.lastHideUi=hideUi;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.mainVao);
    this.bindRgb16Target();
    const prepared=preparedArtwork(theme);
    this.upload(0,prepared.tex0?textureImage(prepared.tex0):null);
    this.upload(1,prepared.tex1?textureImage(prepared.tex1):prepared.tex0?textureImage(prepared.tex0):null);
    const border=theme.border.source==='embedded'?(prepared.border?textureImage(prepared.border):null):textureImage(INTERNAL_BORDER_TEXTURES[theme.border.id??0]);
    this.upload(2,border);
    gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);
    gl.uniform2f(this.location('resolution'),gl.drawingBufferWidth,gl.drawingBufferHeight);
    gl.uniform2f(this.location('uiOffset'),(gl.drawingBufferWidth-640)/2,(gl.drawingBufferHeight-480)/2);
    gl.uniform4fv(this.location('colors[0]'), new Float32Array(theme.colors.flatMap(c => c.map(v => v / 255))));
    gl.uniform1f(this.location('time'), seconds);
    gl.uniform1i(this.location('hideUi'),hideUi?1:0);
    const staticArt = bg.mode === 'static' ? theme.artwork?.staticBackground : null;
    gl.uniform1i(this.location('mode'), staticArt ? 4 : ({solid:0,gradient:1,single:2,dual:3}[bg.mode] ?? 0));
    if (staticArt) {
      this.uploadStatic(theme, seconds, prepared.tex0);
      if (bg.overlay) {
        gl.uniform4f(this.location('params0'), bg.scale, bg.rotation, bg.alpha / 255, 0);
        gl.uniform2f(this.location('velocity0'), bg.velocityX, bg.velocityY);
      }
    }
    gl.uniform3f(this.location('borderGeometry'),theme.border.tabOverlap??2,theme.border.tabJoinDepth??3,theme.border.selectedExpansion??1);
    const family=familyPage(theme.displayFamily??theme.family),names=theme.family==='Nature'?['Coral Reef','Desert','Forest','Lava','Moonlit Clouds','Nebula','Sakura','Solar Flare','Slime','Water']:[theme.name];
    gl.uniform2f(this.location('menuSelection'),family.index,Math.max(0,names.indexOf(theme.name)));
    if (bg.mode === 'gradient') gl.uniform4f(this.location('params0'), bg.speed, bg.warp, 0, 0);
    if (bg.mode === 'single') {
      gl.uniform4f(this.location('params0'), bg.scale, bg.rotation, bg.alpha / 255, 0);
      gl.uniform2f(this.location('velocity0'), bg.velocityX, bg.velocityY);
    }
    if (bg.mode === 'dual') {
      const ratio = bg.scale1 / bg.scale0, q = Math.max(-5, Math.min(10, Math.floor(Math.log2(ratio) + .5)));
      gl.uniform4f(this.location('params0'), bg.scale0, bg.scale0 * 2 ** q, bg.rotation, bg.alpha0 / 255);
      gl.uniform2f(this.location('velocity0'), bg.velocityX0, bg.velocityY0);
      gl.uniform2f(this.location('velocity1'), bg.velocityX1, bg.velocityY1);
    }
    const plainBorder=theme.border.source==='internal'&&(theme.border.id??0)===0;
    gl.uniform4f(this.location('params1'),bg.mode==='dual'?bg.alpha1/255:0,plainBorder?0:2,0,0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if(!hideUi)this.renderText(theme);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,this.framebuffer);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);gl.blitFramebuffer(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.COLOR_BUFFER_BIT,gl.NEAREST);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }
}
import { INTERNAL_BORDER_TEXTURES } from '../src/internal-borders.generated.mjs';
import { prepareArtworkTextures } from '../src/texture.mjs';
import { resolveThemeAnimation, cycledStaticPalette } from '../src/animation.mjs';
import { staticTables, overlayParams } from '../src/rdp-static.mjs';

import { familyPage } from '../src/utils.mjs';
