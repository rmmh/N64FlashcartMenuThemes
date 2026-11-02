import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTile, periodicizeImage, quantizeForNfmt, tileQuality } from '../src/tile-tools.mjs';

function synthetic(w=64,h=64){
  const data=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=(y*w+x)*4;
    data[i]=Math.min(255,x*4 + ((x^y)&7)*3);
    data[i+1]=Math.min(255,y*4 + ((x*3+y*5)&15));
    data[i+2]=(x*11+y*7)&255;
    data[i+3]=255;
  }
  return {width:w,height:h,data};
}

function rawSeamRms(image){
  let s=0,n=0;
  const diff=(i,j)=>{for(let c=0;c<3;c++){const d=image.data[i+c]-image.data[j+c];s+=d*d;n++;}};
  for(let y=0;y<image.height;y++)diff((y*image.width+image.width-1)*4,(y*image.width)*4);
  for(let x=0;x<image.width;x++)diff(((image.height-1)*image.width+x)*4,x*4);
  return Math.sqrt(s/n);
}

test('periodic-plus-smooth substantially reduces hard edge disagreement',()=>{
  const src=synthetic();
  const before=rawSeamRms(src);
  const after=rawSeamRms(periodicizeImage(src));
  assert.ok(after < before*0.35,`expected seam reduction, before=${before}, after=${after}`);
});

test('NFMT quantization chooses RGBA16 at 32x32 and CI4 at 64x64',()=>{
  const a=quantizeForNfmt(synthetic(32,32));
  const b=quantizeForNfmt(synthetic(64,64));
  assert.equal(a.texture.kind,'rgba16');
  assert.equal(b.texture.kind,'ci4');
  assert.ok(b.texture.palette.length<=16);
});

test('tile converter grades the actual post-quantization result',()=>{
  const r=makeTile(synthetic(96,80),{width:64,height:64});
  const q=tileQuality(r.image);
  assert.deepEqual(q,r.quality);
  assert.equal(r.texture.kind,'ci4');
  assert.equal(typeof r.quality.pass,'boolean');
});
