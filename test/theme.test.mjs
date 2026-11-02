import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from '../src/png-node.mjs';
import { parseThemeImage, packThemeImage } from '../src/theme.mjs';
import { renderTheme } from '../src/renderer.mjs';
import { BORDER_NAMES, FAMILIES, familyPage } from '../src/utils.mjs';
import { quantizeImage, makePalette, mapCi4 } from '../src/texture.mjs';
import { resolveThemeAnimation } from '../src/animation.mjs';
import { INTERNAL_BORDER_TEXTURES } from '../src/internal-borders.generated.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cases=[['desert-sunset.png','Desert'],['moonlit-clouds.png','Moonlit Clouds'],['sakura.png','Sakura'],['water.png','Water']];

test('expanded theme families are recognized and page into six-row menus',()=>{
  for(const name of ['Nature','Water','Space','Life','Materials','Ornament','Machines','Electronics','Retro','Abstract','Fantasy','Custom'])assert.ok(FAMILIES.includes(name));
  const page=familyPage('Electronics');
  assert.equal(page.names.length,6);
  assert.equal(page.names[page.index],'Electronics');
});

for(const [file,name] of cases)test(`parse, repack and render ${name}`,()=>{
  const image=decodePng(fs.readFileSync(path.join(root,'assets','themes',file)));
  const t=parseThemeImage(image);
  assert.equal(t.name,name); assert.equal(t.family,'Nature'); assert.equal(t.background.mode,'dual'); assert.equal(t.metadataRows,1);
  const {image:packed}=packThemeImage(t,t.artwork),again=parseThemeImage(packed);
  assert.equal(again.name,t.name); assert.deepEqual(again.colors,t.colors); assert.equal(again.background.mode,t.background.mode); assert.equal(again.border.source,t.border.source); assert.equal(again.border.id,t.border.id);
  assert.equal(again.artwork.layer0.width,t.artwork.layer0.width);assert.equal(again.artwork.layer0.height,t.artwork.layer0.height);
  const preview=renderTheme(t,{time:0.75,ui:true});assert.equal(preview.width,640);assert.equal(preview.height,480);assert.equal(preview.data.length,640*480*4);
  const png=encodePng(preview),decoded=decodePng(png);assert.equal(decoded.width,640);assert.equal(decoded.height,480);
});

test('canonical pack supports solid and gradient themes without texture artwork',()=>{
  const colors=Array.from({length:16},(_,i)=>[i*13%256,i*29%256,i*47%256,255]);
  for(const background of [{mode:'solid'},{mode:'gradient',speed:0.3,warp:0.5}]){
    const theme={name:'Synthetic',family:'Custom',colors,background,border:{source:'internal',id:0}};
    const {image}=packThemeImage(theme,{}),parsed=parseThemeImage(image);
    assert.equal(parsed.background.mode,background.mode);assert.equal(parsed.border.id,0);
  }
});

test('static image themes round-trip full-screen artwork',()=>{
  const colors=Array.from({length:16},(_,i)=>[i*11,i*7,i*3,255]);
  const staticBackground={width:640,height:480,data:new Uint8ClampedArray(640*480*4)};
  for(let i=0;i<staticBackground.data.length;i+=4)staticBackground.data.set([240,80,20,255],i);
  const theme={name:'Static',family:'Texture',colors,background:{mode:'static'},border:{source:'internal',id:0},artwork:{staticBackground}};
  const packed=packThemeImage(theme,theme.artwork),parsed=parseThemeImage(packed.image);
  assert.equal(packed.image.width,640);assert.equal(packed.image.height,481);
  assert.equal(parsed.background.mode,'static');assert.equal(parsed.artwork.staticBackground.height,480);
  // The preview shows what the console does: RGBA5551 expanded back to 8 bits.
  const preview=renderTheme(parsed,{ui:false});assert.deepEqual(Array.from(preview.data.slice(0,4)),[247,82,16,255]);
});

test('PNG decoder accepts encoded RGBA8 data exactly',()=>{
  const image={width:7,height:5,data:new Uint8ClampedArray(7*5*4)};
  for(let i=0;i<image.data.length;i++)image.data[i]=(i*37+11)&255;
  const round=decodePng(encodePng(image));assert.deepEqual(Array.from(round.data),Array.from(image.data));
});

test('embedded border packages round-trip and render',()=>{
  const colors=Array.from({length:16},(_,i)=>[20+i*9,30+i*7,40+i*5,255]);
  const border={width:24,height:24,data:new Uint8ClampedArray(24*24*4)};
  for(let y=0;y<24;y++)for(let x=0;x<24;x++){const i=(y*24+x)*4;const edge=x<3||x>=21||y<3||y>=21;border.data[i]=255;border.data[i+1]=255;border.data[i+2]=255;border.data[i+3]=edge?255:0;}
  const theme={name:'Embedded',family:'Custom',colors,background:{mode:'gradient',speed:0.25,warp:0.4},border:{source:'embedded',tabOverlap:2,tabJoinDepth:3,selectedExpansion:1}};
  const {image}=packThemeImage(theme,{border}),parsed=parseThemeImage(image);
  assert.equal(parsed.border.source,'embedded');assert.equal(parsed.artwork.border.width,24);assert.equal(parsed.artwork.border.height,24);
  const preview=renderTheme(parsed,{time:1,ui:true});assert.equal(preview.data.length,640*480*4);
});

test('type 8 texture and type 9 parameter animations survive canonical repacking',()=>{
  const colors=Array.from({length:16},(_,i)=>[i,i*2,i*3,255]);
  const frame=color=>{const data=new Uint8ClampedArray(16*16*4);for(let p=0;p<data.length;p+=4)data.set([...color,255],p);return {width:16,height:16,data};};
  const frames=[frame([255,0,0]),frame([0,0,255])];
  const payload=(color,vx)=>{const out=new Uint8Array(8);out.set(color,0);new DataView(out.buffer).setFloat32(4,vx,true);return out;};
  const theme={name:'Animated',family:'External',colors,background:{mode:'single',scale:1,velocityX:0,velocityY:0,rotation:0,alpha:255},border:{source:'internal',id:1},textureAnimations:{layer0:{frameCount:2,columns:2,frameTicks:30,flags:8},layer1:{frameCount:0,columns:0,frameTicks:0,flags:0}},parameterAnimation:{mask:(1<<0)|(1<<20),animation:{frameCount:2,columns:2,frameTicks:60,flags:8},frames:[payload([0,0,0,255],0),payload([200,100,50,255],1)]},artwork:{layer0:frames[0],layer0Frames:frames}};
  const packed=packThemeImage(theme,theme.artwork),parsed=parseThemeImage(packed.image);
  assert.equal(parsed.textureAnimations.layer0.frameCount,2);assert.equal(parsed.artwork.layer0Frames.length,2);assert.equal(parsed.parameterAnimation.frames.length,2);
  const resolved=resolveThemeAnimation(parsed,.5);assert.deepEqual(resolved.colors[0],[100,50,25,255]);assert.equal(resolved.background.velocityX,.5);assert.notEqual(resolved.artwork.layer0.data[0],255);
  const repacked=parseThemeImage(packThemeImage(parsed,parsed.artwork).image);assert.equal(repacked.artwork.layer0Frames.length,2);assert.deepEqual(Array.from(repacked.parameterAnimation.frames[1]),Array.from(parsed.parameterAnimation.frames[1]));
});


test('generated internal border CI4 data matches the supplied 24x24 border PNGs',()=>{
  assert.equal(INTERNAL_BORDER_TEXTURES.length,BORDER_NAMES.length);
  for(let id=0;id<BORDER_NAMES.length;id++){
    const slug=BORDER_NAMES[id].toLowerCase();
    const image=decodePng(fs.readFileSync(path.join(root,'assets','images',`theme-border-${slug}.png`)));
    assert.equal(image.width,24);assert.equal(image.height,24);
    const q=quantizeImage(image),expected=mapCi4(q,makePalette([q])),actual=INTERNAL_BORDER_TEXTURES[id];
    assert.deepEqual(actual.palette,expected.palette,`${BORDER_NAMES[id]} palette`);
    assert.deepEqual(Array.from(actual.indices),Array.from(expected.indices),`${BORDER_NAMES[id]} indices`);
  }
});
