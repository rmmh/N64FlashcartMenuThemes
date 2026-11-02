import { readF32LE } from './utils.mjs';
import { rgba5551FromRgba, rgbaFrom5551 } from './theme.mjs';

function indexAtStep(animation,step){
  const n=animation.frameCount,mode=animation.flags&3;let index;
  if(mode===0)index=((step%n)+n)%n;
  else if(mode===1){const period=n*2-2,q=((step%period)+period)%period;index=q<n?q:period-q;}
  else index=Math.min(Math.max(step,0),n-1);
  return animation.flags&4?n-1-index:index;
}
export function animationState(animation,seconds){
  if(!animation||animation.frameCount<=1)return {index:0,next:0,weight:0};
  const ticks=seconds*60,step=Math.floor(ticks/animation.frameTicks),index=indexAtStep(animation,step),next=indexAtStep(animation,step+1),weight=(animation.flags&8)?(ticks%animation.frameTicks)/animation.frameTicks:0;
  return {index,next,weight};
}
function lerp(a,b,t){return a+(b-a)*t;}
function blendImage(a,b,t){
  if(!t||a===b)return a;const data=new Uint8ClampedArray(a.data.length);
  for(let p=0;p<data.length;p+=4){const av=rgba5551FromRgba(...a.data.subarray(p,p+4)),bv=rgba5551FromRgba(...b.data.subarray(p,p+4)),r=Math.round(lerp((av>>>11)&31,(bv>>>11)&31,t)),g=Math.round(lerp((av>>>6)&31,(bv>>>6)&31,t)),bl=Math.round(lerp((av>>>1)&31,(bv>>>1)&31,t)),alpha=lerp(av&1,bv&1,t)>=.5?1:0;data.set(rgbaFrom5551((r<<11)|(g<<6)|(bl<<1)|alpha),p);}
  return {width:a.width,height:a.height,data};
}
function readChannels(parameter,index){const bytes=parameter.frames[index],out=new Map();let o=0;for(let channel=0;channel<29;channel++)if((parameter.mask>>>channel)&1){const size=channel<25?4:1;out.set(channel,channel<16?Array.from(bytes.subarray(o,o+4)):channel<25?readF32LE(bytes,o):bytes[o]);o+=size;}return out;}
export function resolveThemeAnimation(theme,seconds){
  let resolved=theme;
  if(theme.parameterAnimation){const p=theme.parameterAnimation,s=animationState(p.animation,seconds),a=readChannels(p,s.index),b=readChannels(p,s.next),background={...theme.background},colors=theme.colors.map(c=>[...c]),single=background.mode==='single'||!!background.overlay;for(const [channel,av] of a){const bv=b.get(channel),discrete=channel>=27,isScale=channel===18||channel===19,value=discrete?(s.weight<.5?av:bv):Array.isArray(av)?av.map((v,i)=>Math.round(lerp(v,bv[i],s.weight))):isScale?Math.exp(lerp(Math.log(av),Math.log(bv),s.weight)):lerp(av,bv,s.weight);if(channel<16)colors[channel]=value;else if(channel===16)background.speed=value;else if(channel===17)background.warp=value;else if(channel===18){if(single)background.scale=value;else background.scale0=value;}else if(channel===19)background.scale1=value;else if(channel===20){if(single)background.velocityX=value;else background.velocityX0=value;}else if(channel===21){if(single)background.velocityY=value;else background.velocityY0=value;}else if(channel===22)background.velocityX1=value;else if(channel===23)background.velocityY1=value;else if(channel===24)background.rotation=value;else if(channel===25){if(single)background.alpha=Math.round(value);else background.alpha0=Math.round(value);}else if(channel===26)background.alpha1=Math.round(value);else if(channel===27)background.layer0Frame=value;else if(channel===28)background.layer1Frame=value;}resolved={...theme,colors,background};}
  const artwork={...theme.artwork},animations=theme.textureAnimations;
  for(const layer of [0,1]){const frames=artwork[`layer${layer}Frames`];if(!frames?.length)continue;const selector=resolved.background[`layer${layer}Frame`],s=selector!==undefined&&selector!==255?{index:selector,next:selector,weight:0}:animationState(animations?.[`layer${layer}`],seconds);artwork[`layer${layer}`]=blendImage(frames[s.index]??frames[0],frames[s.next]??frames[0],s.weight);}
  return {...resolved,artwork};
}

/**
 * Type-12 color cycling: the palette shown at `seconds`, as RGBA8 colors.
 * Entry start+i shows color start+((i-k) mod length), k = floor(F/step);
 * reversed ranges use i+k, and blended ranges interpolate 5-bit channels.
 */
export function cycledStaticPalette(colors,staticPalette,seconds){
  const out=colors.map(c=>[...c]);if(!staticPalette)return out;
  const F=seconds*60;
  for(const range of staticPalette.ranges??[]){
    // Integer blend exactly as the menu computes it: weight in 1/256 steps.
    const steps=F/range.stepTicks,step=Math.floor(steps),weight=(range.flags&2)?Math.floor((steps-step)*256):0,dir=range.flags&1?1:-1;
    for(let i=0;i<range.length;i++){
      const at=k=>colors[range.start+(((i+dir*k)%range.length)+range.length)%range.length];
      const a=rgba5551FromRgba(...at(step)),b=rgba5551FromRgba(...at(step+1)),mix=sh=>{const ia=(a>>>sh)&31,ib=(b>>>sh)&31;return (ia*256+(ib-ia)*weight+128)>>8;};
      out[range.start+i]=rgbaFrom5551((mix(11)<<11)|(mix(6)<<6)|(mix(1)<<1)|1);
    }
  }
  return out;
}
