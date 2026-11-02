#!/usr/bin/env python3
"""Build the animated Radioactive Slime theme."""
from __future__ import annotations
import math
from pathlib import Path
from PIL import Image, ImageEnhance, ImageOps
from theme_writer import (ANIMATION_INTERPOLATE, Animation, FAMILY, NAME,
 ParameterAnimation, ParameterFrame, TextureRegions, close_seams, colors_record,
 dual_texture_background, internal_border, lerp_rgba, pack_after_parameters,
 pack_parameter_animation, palette, regions_record, text_record,
 texture_animations, write_theme)
ROOT=Path(__file__).resolve().parents[1]; SOURCE=ROOT/'assets/texture-sources/radioactive-slime-raw.jpg'; OUTPUT=ROOT/'assets/themes/radioactive-slime.png'
ROWS=2; SIZE=32; BLOBS=6; BUBBLES=4
COLORS=palette('031004',('09220a',224),'559526','f1ffe0','b7d59a','8cda24','dfff4f','173613','417921','010501','7bcf75','d4a84a','0b2608','214d13','102f0d','55851a')
def tile(im): return close_seams(ImageEnhance.Contrast(ImageOps.fit(im.convert('RGB'),(SIZE,SIZE),method=Image.Resampling.LANCZOS)).enhance(1.15))
def deform(src,phase):
 p=src.load(); out=Image.new('RGBA',(SIZE,SIZE)); q=out.load()
 for y in range(SIZE):
  for x in range(SIZE):
   sx=round(x+1.2*math.sin(math.tau*y/SIZE+phase))%SIZE; sy=round(y+.8*math.sin(math.tau*x/SIZE-phase))%SIZE; q[x,y]=(*p[sx,sy][:3],255)
 return close_seams(out)
def bubbles():
 result=[]; centers=((7,23),(21,14),(27,27))
 for i in range(BUBBLES):
  im=Image.new('RGBA',(SIZE,SIZE),(0,0,0,0)); p=im.load(); radius=1.5+i*1.25
  for y in range(SIZE):
   for x in range(SIZE):
    for cx,cy in centers:
     d=math.hypot(min(abs(x-cx),SIZE-abs(x-cx)),min(abs(y-cy),SIZE-abs(y-cy)))
     if abs(d-radius)<.7: p[x,y]=(225,255,72,255)
  im=close_seams(im); p=im.load()
  for y in range(SIZE):
   for x in range(SIZE): r,g,b,a=p[x,y]; p[x,y]=(r,g,b,255 if a>=128 else 0)
  result.append(im)
 return result
def params():
 selectors=(0,1,2,3,3,2,1,0); viscosity=(.15,.30,.55,.85,1,.68,.38,.20); out=[]
 for i,(s,v) in enumerate(zip(selectors,viscosity)):
  out.append(ParameterFrame(border=lerp_rgba('477c22','c8ed43',v),accent=lerp_rgba('73b91d','d9f436',v),highlight=lerp_rgba('98d83b','f5ffb0',v),warning=lerp_rgba('b28b28','ecdd3d',v),tab_active=lerp_rgba('37641b','689b20',v),layer0_scale=.245+.018*v,layer1_scale=.245+.018*v,layer1_dy=.0008+.0022*v,layer0_alpha=218-round(28*v),layer1_alpha=48+round(150*v),layer1_texture=s))
 return out
def build():
 src=tile(Image.open(SOURCE)); blobs=[deform(src,i*math.tau/BLOBS) for i in range(BLOBS)]; pops=bubbles(); rec,sheet=pack_parameter_animation(ParameterAnimation(params(),Animation(48,ANIMATION_INTERPOLATE,2)),ROWS); packed=pack_after_parameters(sheet,(*blobs,*pops)); records=[text_record(NAME,'Radioactive Slime'),text_record(FAMILY,'Materials'),colors_record(COLORS),dual_texture_background(.245,.245,0,0,0,.0008,0,218,78),regions_record(TextureRegions(packed.rectangles[0],packed.rectangles[BLOBS]),ROWS),internal_border(6),texture_animations(BLOBS,Animation(38,ANIMATION_INTERPOLATE,2),BUBBLES,Animation(29,0,2)),rec]; write_theme(OUTPUT,records,packed.image,ROWS); return OUTPUT
if __name__=='__main__': print(f'wrote {build().relative_to(ROOT)}')
