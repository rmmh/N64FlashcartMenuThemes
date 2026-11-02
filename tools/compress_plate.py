#!/usr/bin/env python3
"""Compress a source plate to mozjpeg for assets/*-sources/.

Plates are far larger than the themes built from them, so q80 4:2:0 is plenty
for pictures. Use --sheet for sprite and particle sheets, whose small shapes
set a palette. Masks, depth maps, route data and frame sheets stay PNG, because
builders threshold or measure them.
"""
import argparse
import io
import subprocess
from pathlib import Path

from PIL import Image

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('--sheet', action='store_true', help='use q92 4:4:4')
args = parser.parse_args()

ppm = io.BytesIO()
Image.open(args.source).convert('RGB').save(ppm, 'PPM')
quality, sample = ('92', '1x1') if args.sheet else ('80', '2x2')
args.source.with_suffix('.jpg').write_bytes(subprocess.run(
    ['cjpeg', '-quality', quality, '-sample', sample, '-optimize', '-progressive'],
    input=ppm.getvalue(), capture_output=True, check=True).stdout)
