import { clamp, mod } from './utils.mjs';
import { INTERNAL_BORDER_TEXTURES } from './internal-borders.generated.mjs';
import { prepareArtworkTextures, texel } from './texture.mjs';
import { resolveThemeAnimation, cycledStaticPalette } from './animation.mjs';
import { staticLayer } from './rdp-static.mjs';

function bilinear(t,u,v){const x=Math.floor(u),y=Math.floor(v),fx=u-x,fy=v-y,a=texel(t,x,y),b=texel(t,x+1,y),c=texel(t,x,y+1),d=texel(t,x+1,y+1);const out=[0,0,0,0];for(let k=0;k<4;k++){const top=a[k]+(b[k]-a[k])*fx,bot=c[k]+(d[k]-c[k])*fx;out[k]=top+(bot-top)*fy;}return out;}
function mixRgb(a,b,t){return [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t,255];}
function effectiveScale1(s0,s1){const ratio=s1/s0,q=Math.max(-5,Math.min(10,Math.floor(Math.log2(ratio)+0.5)));return s0*Math.pow(2,q);}
function renderTextureBackground(theme,prepared,time,out){const bg=theme.background,c0=theme.colors[0],F=time*60,ang=bg.rotation*F,ca=Math.cos(ang),sa=Math.sin(ang),off=(x,y,s,vx,vy,t)=>{const dx=x-320,dy=y-240,xr=ca*dx-sa*dy+320,yr=sa*dx+ca*dy+240;return [xr*s-mod(vx*8*F,64),yr*s-mod(vy*8*F,64)];};
  for(let y=0;y<480;y++)for(let x=0;x<640;x++){let c;if(bg.mode==='single'){const [u,v]=off(x,y,bg.scale,bg.velocityX,bg.velocityY,prepared.tex0),t=bilinear(prepared.tex0,u,v),a=(t[3]/255)*(bg.alpha/255);c=mixRgb(c0,t,a);}else{const [u0,v0]=off(x,y,bg.scale0,bg.velocityX0,bg.velocityY0,prepared.tex0),s1=effectiveScale1(bg.scale0,bg.scale1),[u1,v1]=off(x,y,s1,bg.velocityX1,bg.velocityY1,prepared.tex1),t0=bilinear(prepared.tex0,u0,v0),t1=bilinear(prepared.tex1,u1,v1),base=mixRgb(c0,t0,bg.alpha0/255),a1=(t1[3]/255)*(bg.alpha1/255);c=mixRgb(base,t1,a1);}const i=(y*640+x)*4;out.data[i]=c[0];out.data[i+1]=c[1];out.data[i+2]=c[2];out.data[i+3]=255;}}
const BAYER4=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
function dither555(c,x,y){const b=BAYER4[(y&3)*4+(x&3)]-7.5;return c.map((v,k)=>k===3?255:Math.round(clamp((v+b*0.55)/255)*31)*255/31);}
function gradientSample(colors,u,v){const top=mixRgb(colors[12],colors[13],u),bot=mixRgb(colors[14],colors[15],u);return mixRgb(top,bot,v);}
function rasterTri(out,a,b,c){const minX=Math.max(0,Math.floor(Math.min(a.x,b.x,c.x))),maxX=Math.min(639,Math.ceil(Math.max(a.x,b.x,c.x))),minY=Math.max(0,Math.floor(Math.min(a.y,b.y,c.y))),maxY=Math.min(479,Math.ceil(Math.max(a.y,b.y,c.y)));const den=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);if(Math.abs(den)<1e-6)return;for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){const px=x+0.5,py=y+0.5,w0=((b.y-c.y)*(px-c.x)+(c.x-b.x)*(py-c.y))/den,w1=((c.y-a.y)*(px-c.x)+(a.x-c.x)*(py-c.y))/den,w2=1-w0-w1;if(w0>=-1e-6&&w1>=-1e-6&&w2>=-1e-6){const col=[0,0,0,255];for(let k=0;k<3;k++)col[k]=a.c[k]*w0+b.c[k]*w1+c.c[k]*w2;const q=dither555(col,x,y),i=(y*640+x)*4;out.data[i]=q[0];out.data[i+1]=q[1];out.data[i+2]=q[2];out.data[i+3]=255;}}}
function renderGradient(theme,time,out){const {speed,warp}=theme.background,p=mod(speed*time*Math.PI*2,Math.PI*2),xs=[0,640*(0.5+Math.sin(0.71*p)*warp*0.18),640],ys=[0,480*(0.5+Math.cos(0.89*p)*warp*0.18),480],verts=[];for(let j=0;j<3;j++){verts[j]=[];for(let i=0;i<3;i++){const u=i/2,v=j/2,su=clamp(u+Math.sin(p+4.1*v)*warp),sv=clamp(v+Math.cos(0.83*p+3.7*u)*warp);verts[j][i]={x:xs[i],y:ys[j],c:gradientSample(theme.colors,su,sv)};}}for(let j=0;j<2;j++)for(let i=0;i<2;i++){const a=verts[j][i],b=verts[j][i+1],c=verts[j+1][i],d=verts[j+1][i+1];rasterTri(out,a,b,d);rasterTri(out,a,d,c);}}
function fill(out,c){for(let i=0;i<out.data.length;i+=4){out.data[i]=c[0];out.data[i+1]=c[1];out.data[i+2]=c[2];out.data[i+3]=255;}}
function px(out,x,y,c){if(x<0||x>=640||y<0||y>=480)return;const i=(y*640+x)*4;out.data[i]=c[0];out.data[i+1]=c[1];out.data[i+2]=c[2];out.data[i+3]=255;}
function rect(out,x,y,w,h,c){const alpha=c[3]/255;for(let yy=Math.max(0,y);yy<Math.min(480,y+h);yy++){let i=(yy*640+Math.max(0,x))*4;for(let xx=Math.max(0,x);xx<Math.min(640,x+w);xx++,i+=4){for(let ch=0;ch<3;ch++)out.data[i+ch]=out.data[i+ch]*(1-alpha)+c[ch]*alpha;out.data[i+3]=255;}}}
function tint(c,t){return [Math.round(c[0]*t[0]/255),Math.round(c[1]*t[1]/255),Math.round(c[2]*t[2]/255),c[3]];}
function pointTexel(t,x,y){return texel(t,Math.floor(x),Math.floor(y));}
function drawNinePatch(out,t,x,y,w,h,tintColor){const cell=8;function drawCell(sx,sy,dx,dy,dw,dh,repeatX,repeatY){for(let yy=0;yy<dh;yy++)for(let xx=0;xx<dw;xx++){const tx=sx+(repeatX?xx%cell:Math.floor(xx*cell/dw)),ty=sy+(repeatY?yy%cell:Math.floor(yy*cell/dh)),c=tint(pointTexel(t,tx,ty),tintColor);if(c[3])px(out,dx+xx,dy+yy,c);}}drawCell(0,0,x,y,8,8,false,false);drawCell(16,0,x+w-8,y,8,8,false,false);drawCell(0,16,x,y+h-8,8,8,false,false);drawCell(16,16,x+w-8,y+h-8,8,8,false,false);drawCell(8,0,x+8,y,w-16,8,true,false);drawCell(8,16,x+8,y+h-8,w-16,8,true,false);drawCell(0,8,x,y+8,8,h-16,false,true);drawCell(16,8,x+w-8,y+8,8,h-16,false,true);}
function drawPanel(out,theme,prepared,x,y,w,h,selected=false){rect(out,x,y,w,h,theme.colors[1]);const bc=selected?theme.colors[5]:theme.colors[2];const borderTexture=theme.border.source==='embedded'?prepared.border:INTERNAL_BORDER_TEXTURES[theme.border.id??0];if(borderTexture)drawNinePatch(out,borderTexture,x,y,w,h,bc);}
const FONT5 = {
  'A':['01110','10001','10001','11111','10001','10001','10001'],
  'B':['11110','10001','10001','11110','10001','10001','11110'],
  'C':['01111','10000','10000','10000','10000','10000','01111'],
  'D':['11110','10001','10001','10001','10001','10001','11110'],
  'E':['11111','10000','10000','11110','10000','10000','11111'],
  'F':['11111','10000','10000','11110','10000','10000','10000'],
  'G':['01111','10000','10000','10111','10001','10001','01111'],
  'H':['10001','10001','10001','11111','10001','10001','10001'],
  'I':['11111','00100','00100','00100','00100','00100','11111'],
  'J':['00111','00010','00010','00010','10010','10010','01100'],
  'K':['10001','10010','10100','11000','10100','10010','10001'],
  'L':['10000','10000','10000','10000','10000','10000','11111'],
  'M':['10001','11011','10101','10101','10001','10001','10001'],
  'N':['10001','11001','10101','10011','10001','10001','10001'],
  'O':['01110','10001','10001','10001','10001','10001','01110'],
  'P':['11110','10001','10001','11110','10000','10000','10000'],
  'Q':['01110','10001','10001','10001','10101','10010','01101'],
  'R':['11110','10001','10001','11110','10100','10010','10001'],
  'S':['01111','10000','10000','01110','00001','00001','11110'],
  'T':['11111','00100','00100','00100','00100','00100','00100'],
  'U':['10001','10001','10001','10001','10001','10001','01110'],
  'V':['10001','10001','10001','10001','10001','01010','00100'],
  'W':['10001','10001','10001','10101','10101','10101','01010'],
  'X':['10001','10001','01010','00100','01010','10001','10001'],
  'Y':['10001','10001','01010','00100','00100','00100','00100'],
  'Z':['11111','00001','00010','00100','01000','10000','11111'],
  '0':['01110','10001','10011','10101','11001','10001','01110'],
  '1':['00100','01100','00100','00100','00100','00100','01110'],
  '2':['01110','10001','00001','00010','00100','01000','11111'],
  '3':['11110','00001','00001','01110','00001','00001','11110'],
  '4':['00010','00110','01010','10010','11111','00010','00010'],
  '5':['11111','10000','10000','11110','00001','00001','11110'],
  '6':['01110','10000','10000','11110','10001','10001','01110'],
  '7':['11111','00001','00010','00100','01000','01000','01000'],
  '8':['01110','10001','10001','01110','10001','10001','01110'],
  '9':['01110','10001','10001','01111','00001','00001','01110'],
  '-':['00000','00000','00000','11111','00000','00000','00000'],
  '.':['00000','00000','00000','00000','00000','00110','00110'],
  ':':['00000','00110','00110','00000','00110','00110','00000'],
  ' ':['00000','00000','00000','00000','00000','00000','00000']
};
function fakeText(out,x,y,text,c){let cursor=x;for(const ch0 of String(text).toUpperCase()){const rows=FONT5[ch0]??FONT5['-'];for(let yy=0;yy<7;yy++)for(let xx=0;xx<5;xx++)if(rows[yy][xx]==='1')px(out,cursor+xx,y+yy,c);cursor+=6;}}

function renderUi(theme,prepared,out){const [left,top,right,bottom]=[32,24,608,456];drawPanel(out,theme,prepared,left,top+35,right-left,bottom-top-35,false);const tabs=['Themes','Display','Audio','About'],tw=112,g=4,y=top+7;tabs.forEach((t,i)=>{const sel=i===0,x=left+i*(tw-g),over=theme.border.tabOverlap??2,exp=sel?(theme.border.selectedExpansion??1):0,join=theme.border.tabJoinDepth??3,l=i?Math.floor(over/2):0,r=i<tabs.length-1?Math.ceil(over/2):0;drawPanel(out,theme,prepared,x-l-exp,y-(sel?5:0),tw+l+r+exp*2,28+(sel?5:0)+join,sel);fakeText(out,x+14,y+8-(sel?5:0),t,sel?theme.colors[3]:theme.colors[4]);});
  fakeText(out,56,94,theme.name,theme.colors[3]);fakeText(out,56,111,theme.family,theme.colors[4]);rect(out,56,140,520,28,theme.colors[6]);fakeText(out,70,150,'Preview theme',theme.colors[3]);for(let i=0;i<6;i++){const yy=184+i*34;fakeText(out,70,yy,`Menu item ${i+1}`,i===4?theme.colors[4]:theme.colors[3]);if(i===2)rect(out,500,yy-4,52,16,theme.colors[10]);}
}

/**
 * Type-11 placement: uniform cover scale, centered, with panned axes moving
 * by pan*F output pixels and wrapping modulo the scaled size.
 */
export function staticPlacement(layout,width,height,seconds){
  const F=seconds*60,scale=Math.max(640/width,480/height),W=width*scale,H=height*scale;
  // As in the menu's blit_static: filter only when magnified; at 1:1 draw on whole pixels.
  const filter=scale>1.001,snap=v=>filter?v:Math.floor(v+0.5);
  const axis=(size,screen,pan)=>{const start=(screen-size)/2;return pan?{origin:snap(mod(start+pan*F,size)-size),wrap:true}:{origin:snap(start),wrap:false};};
  const x=axis(W,640,layout?.panX??0),y=axis(H,480,layout?.panY??0);
  return {scale,W,H,x0:x.origin,y0:y.origin,wrapX:x.wrap,wrapY:y.wrap,filter};
}

const staticIndexCache=new WeakMap();
/** CI8 indices of a palette-backed static image: the gray value of each pixel. */
export function staticIndices(image){
  let indices=staticIndexCache.get(image);if(indices)return indices;
  indices=new Uint8Array(image.width*image.height);for(let p=0;p<indices.length;p++)indices[p]=image.data[p*4];
  staticIndexCache.set(image,indices);return indices;
}
/** Grayscale index image for palette-backed static artwork. */
export function indexImage(width,height,indices){
  const out={width,height,data:new Uint8ClampedArray(width*height*4)};
  for(let p=0;p<indices.length;p++){const i=p*4;out.data[i]=out.data[i+1]=out.data[i+2]=indices[p];out.data[i+3]=255;}
  return out;
}

function renderStatic(theme,prepared,time,out){
  const colors=theme.artwork.staticPalette,palette=colors?cycledStaticPalette(colors,theme.staticPalette,time):null;
  // The image layer exactly as the menu draws it (see rdp-static.mjs).
  out.data.set(staticLayer(theme,time,palette));
  const bg=theme.background;
  if(!bg.overlay||!prepared.tex0)return;
  const F=time*60,ang=(bg.rotation??0)*F,ca=Math.cos(ang),sa=Math.sin(ang);
  for(let y=0;y<480;y++)for(let x=0;x<640;x++){
    const d=(y*640+x)*4,dx=x-320,dy=y-240,u=(ca*dx-sa*dy+320)*bg.scale-mod(bg.velocityX*8*F,64),v=(sa*dx+ca*dy+240)*bg.scale-mod(bg.velocityY*8*F,64),t=bilinear(prepared.tex0,u,v);
    const c=mixRgb([out.data[d],out.data[d+1],out.data[d+2]],t,(t[3]/255)*(bg.alpha/255));out.data[d]=c[0];out.data[d+1]=c[1];out.data[d+2]=c[2];out.data[d+3]=255;
  }
}

export function renderTheme(theme,{time=0,ui=true}={}){theme=resolveThemeAnimation(theme,time);const out={width:640,height:480,data:new Uint8ClampedArray(640*480*4)},prepared=prepareArtworkTextures(theme);fill(out,theme.colors[0]);if(theme.background.mode==='gradient')renderGradient(theme,time,out);else if(theme.background.mode==='single'||theme.background.mode==='dual')renderTextureBackground(theme,prepared,time,out);else if(theme.background.mode==='static'&&theme.artwork?.staticBackground)renderStatic(theme,prepared,time,out);if(ui)renderUi(theme,prepared,out);return out;}
