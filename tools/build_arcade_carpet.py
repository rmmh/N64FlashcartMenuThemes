#!/usr/bin/env python3
"""Build the drifting, gently breathing Arcade Carpet theme."""
from __future__ import annotations
import math
from pathlib import Path
from PIL import Image,ImageEnhance
from theme_writer import (ANIMATION_INTERPOLATE,Animation,FAMILY,NAME,
 ParameterAnimation,ParameterFrame,TextureRegions,colors_record,
 dual_texture_background,internal_border,pack_after_parameters,pack_parameter_animation,palette,
 quantize_fixed_palette,regions_record,text_record,write_theme)
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'assets/texture-sources/arcade-carpet-raw.jpg'
OUTPUT=ROOT/'assets/themes/arcade-carpet.png';ROWS=1;SIZE=64
CI=((0,0,0,0),(1,3,20,255),(2,7,38,255),(3,13,59,255),(4,22,82,255),
 (14,50,105,255),(10,95,145,255),(12,151,191,255),(25,198,222,255),
 (67,22,116,255),(105,30,155,255),(151,49,184,255),(188,28,105,255),
 (237,38,128,255),(236,151,15,255),(255,207,24,255))
COLORS=palette('02072c',('08103e',224),'7e39ae','f4f4ff','a49bc9','12b4d2',
 'ffca24','14265c','2d4180','010316','69c39a','ec9d3f','060c32','111c4d',
 '0b153e','23366b')
def texture(source):
 # Direct square reduction keeps source-authored squiggles, sparks, polygons,
 # spacing, carpet fiber and seamless edge topology.
 im=source.convert('RGB').resize((SIZE,SIZE),Image.Resampling.LANCZOS)
 im=ImageEnhance.Contrast(im).enhance(1.12);im=ImageEnhance.Color(im).enhance(1.18)
 tile=quantize_fixed_palette(im.convert('RGBA'),CI[1:])
 # This theme's near-black source colors read as dirt rather than shadow at
 # menu scale. Fold them into the deep navy ground, not merely isolated dots.
 pixels=tile.load();cleaned=tile.copy();out=cleaned.load();dark={CI[1],CI[2]}
 for y in range(SIZE):
  for x in range(SIZE):
   if pixels[x,y] in dark: out[x,y]=CI[3]
 return cleaned
def build():
 tile=texture(Image.open(SOURCE))
 # Type-9 supplies a zero-mean vertical velocity.  Its integral is a smooth
 # bob, while the base horizontal velocity stays continuous and constant.
 vertical_frames=[ParameterFrame(layer0_dy=.006*math.sin(index*math.tau/12))
                  for index in range(12)]
 parameter_record,parameter_sheet=pack_parameter_animation(ParameterAnimation(
  vertical_frames,Animation(24,ANIMATION_INTERPOLATE,4)),ROWS)
 packed=pack_after_parameters(parameter_sheet,(tile,));rect=packed.rectangles[0]
 records=[text_record(NAME,'Arcade Carpet'),text_record(FAMILY,'Retro'),
  colors_record(COLORS),dual_texture_background(.210,.210,.006,0,0,0,0,255,0),
  regions_record(TextureRegions(rect,rect),ROWS),internal_border(8),parameter_record]
 write_theme(OUTPUT,records,packed.image,ROWS);return OUTPUT
if __name__=='__main__':print(f'wrote {build().relative_to(ROOT)}')
