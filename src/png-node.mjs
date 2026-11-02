import { deflateSync, inflateSync } from 'node:zlib';
import { crc32 } from './crc32.mjs';
import { assert } from './utils.mjs';

const SIG = Uint8Array.from([137,80,78,71,13,10,26,10]);
const ADAM7 = [
  [0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]
];
function u32be(b,o){return ((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;}
function w32be(b,o,v){b[o]=(v>>>24)&255;b[o+1]=(v>>>16)&255;b[o+2]=(v>>>8)&255;b[o+3]=v&255;}
function concat(parts){const n=parts.reduce((s,p)=>s+p.length,0),o=new Uint8Array(n);let q=0;for(const p of parts){o.set(p,q);q+=p.length;}return o;}

function channels(type){return ({0:1,2:3,3:1,4:2,6:4})[type] ?? 0;}
function allowedDepth(type,depth){return type===0?[1,2,4,8,16].includes(depth):type===3?[1,2,4,8].includes(depth):[2,4,6].includes(type)?[8,16].includes(depth):false;}
function paeth(a,b,c){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
function unfilter(raw,rowBytes,bpp,height){const out=new Uint8Array(rowBytes*height);let ro=0,oo=0;for(let y=0;y<height;y++){const f=raw[ro++];for(let x=0;x<rowBytes;x++){const cur=raw[ro++],a=x>=bpp?out[oo+x-bpp]:0,b=y?out[oo+x-rowBytes]:0,c=y&&x>=bpp?out[oo+x-rowBytes-bpp]:0;let v;if(f===0)v=cur;else if(f===1)v=(cur+a)&255;else if(f===2)v=(cur+b)&255;else if(f===3)v=(cur+Math.floor((a+b)/2))&255;else if(f===4)v=(cur+paeth(a,b,c))&255;else throw new Error(`unsupported PNG filter ${f}`);out[oo+x]=v;}oo+=rowBytes;}assert(ro===raw.length,'PNG decompressed scanline size mismatch');return out;}
function samplePacked(row,bitDepth,sampleIndex){const bit=sampleIndex*bitDepth,byte=row[bit>>3],shift=8-bitDepth-(bit&7);return (byte>>shift)&((1<<bitDepth)-1);}
function scaleSample(v,d){if(d===8)return v;if(d===16)return v>>>8;const m=(1<<d)-1;return Math.round(v*255/m);}

function decodePass(raw,width,height,bitDepth,colorType,palette,trns,out,x0,y0,dx,dy){if(width<=0||height<=0)return 0;const ch=channels(colorType),bits=ch*bitDepth,rowBytes=Math.ceil(width*bits/8),bpp=Math.max(1,Math.ceil(bits/8)),need=(rowBytes+1)*height;const rows=unfilter(raw.subarray(0,need),rowBytes,bpp,height);
  for(let py=0;py<height;py++){
    const row=rows.subarray(py*rowBytes,(py+1)*rowBytes);let si=0;
    for(let px=0;px<width;px++){
      let r,g,b,a=255;
      if(colorType===0){const gv=bitDepth<8?samplePacked(row,bitDepth,px):bitDepth===8?row[px]:((row[px*2]<<8)|row[px*2+1]);const g8=scaleSample(gv,bitDepth);r=g=b=g8;if(trns?.gray!==undefined&&gv===trns.gray)a=0;}
      else if(colorType===3){const idx=samplePacked(row,bitDepth,px);assert(palette&&idx<palette.length/3,`palette index ${idx} out of range`);r=palette[idx*3];g=palette[idx*3+1];b=palette[idx*3+2];a=trns?.palette?.[idx]??255;}
      else {
        const step=bitDepth===16?2:1;const read=()=>{const v=bitDepth===16?((row[si]<<8)|row[si+1]):row[si];si+=step;return v;};
        if(colorType===2){const rv=read(),gv=read(),bv=read();r=scaleSample(rv,bitDepth);g=scaleSample(gv,bitDepth);b=scaleSample(bv,bitDepth);if(trns?.rgb&&rv===trns.rgb[0]&&gv===trns.rgb[1]&&bv===trns.rgb[2])a=0;}
        else if(colorType===4){const gv=read(),av=read();r=g=b=scaleSample(gv,bitDepth);a=scaleSample(av,bitDepth);}
        else if(colorType===6){r=scaleSample(read(),bitDepth);g=scaleSample(read(),bitDepth);b=scaleSample(read(),bitDepth);a=scaleSample(read(),bitDepth);}
      }
      const x=x0+px*dx,y=y0+py*dy,i=(y*out.width+x)*4;out.data[i]=r;out.data[i+1]=g;out.data[i+2]=b;out.data[i+3]=a;
    }
  }
  return need;
}

export function decodePng(bytesLike){const bytes=bytesLike instanceof Uint8Array?bytesLike:new Uint8Array(bytesLike);assert(bytes.length>=8&&SIG.every((v,i)=>bytes[i]===v),'not a PNG');let o=8,ihdr=null,palette=null,trns=null;const idat=[];
  while(o+12<=bytes.length){const len=u32be(bytes,o),type=String.fromCharCode(...bytes.subarray(o+4,o+8)),data=bytes.subarray(o+8,o+8+len),stored=u32be(bytes,o+8+len),calc=crc32(bytes,o+4,o+8+len);assert(stored===calc,`PNG ${type} CRC mismatch`);o+=12+len;
    if(type==='IHDR'){assert(len===13,'bad IHDR length');ihdr={width:u32be(data,0),height:u32be(data,4),bitDepth:data[8],colorType:data[9],compression:data[10],filter:data[11],interlace:data[12]};}
    else if(type==='PLTE')palette=new Uint8Array(data);
    else if(type==='tRNS'){trns=trns??{};if(ihdr.colorType===3)trns.palette=new Uint8Array(data);else if(ihdr.colorType===0){assert(data.length===2,'bad grayscale tRNS');trns.gray=(data[0]<<8)|data[1];}else if(ihdr.colorType===2){assert(data.length===6,'bad RGB tRNS');trns.rgb=[(data[0]<<8)|data[1],(data[2]<<8)|data[3],(data[4]<<8)|data[5]];}}
    else if(type==='IDAT')idat.push(new Uint8Array(data));
    else if(type==='IEND')break;
  }
  assert(ihdr,'PNG missing IHDR');assert(ihdr.width>0&&ihdr.height>0,'invalid PNG dimensions');assert(ihdr.compression===0&&ihdr.filter===0,'unsupported PNG compression/filter method');assert([0,1].includes(ihdr.interlace),'unsupported PNG interlace method');assert(channels(ihdr.colorType)>0&&allowedDepth(ihdr.colorType,ihdr.bitDepth),`unsupported PNG type/depth ${ihdr.colorType}/${ihdr.bitDepth}`);if(ihdr.colorType===3)assert(palette&&palette.length%3===0,'indexed PNG missing valid PLTE');
  const raw=inflateSync(concat(idat)),out={width:ihdr.width,height:ihdr.height,data:new Uint8ClampedArray(ihdr.width*ihdr.height*4)};let p=0;
  if(ihdr.interlace===0){p=decodePass(raw,ihdr.width,ihdr.height,ihdr.bitDepth,ihdr.colorType,palette,trns,out,0,0,1,1);}
  else for(const [x0,y0,dx,dy] of ADAM7){const w=ihdr.width<=x0?0:Math.ceil((ihdr.width-x0)/dx),h=ihdr.height<=y0?0:Math.ceil((ihdr.height-y0)/dy);const ch=channels(ihdr.colorType),rowBytes=Math.ceil(w*ch*ihdr.bitDepth/8),need=w&&h?(rowBytes+1)*h:0;if(need){decodePass(raw.subarray(p,p+need),w,h,ihdr.bitDepth,ihdr.colorType,palette,trns,out,x0,y0,dx,dy);p+=need;}}
  assert(p===raw.length,'extra or missing Adam7 scanline data');return out;
}

function chunk(type,data){const out=new Uint8Array(12+data.length);w32be(out,0,data.length);for(let i=0;i<4;i++)out[4+i]=type.charCodeAt(i);out.set(data,8);w32be(out,8+data.length,crc32(out,4,8+data.length));return out;}
export function encodePng(image,{level=9}={}){assert(image.width>0&&image.height>0&&image.data.length===image.width*image.height*4,'invalid RGBA image');const ihdr=new Uint8Array(13);w32be(ihdr,0,image.width);w32be(ihdr,4,image.height);ihdr[8]=8;ihdr[9]=6;const stride=image.width*4,raw=new Uint8Array((stride+1)*image.height);let p=0;for(let y=0;y<image.height;y++){raw[p++]=0;raw.set(image.data.subarray(y*stride,(y+1)*stride),p);p+=stride;}return concat([SIG,chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level})),chunk('IEND',new Uint8Array())]);}
