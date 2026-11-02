#!/usr/bin/env python3
"""Build Coral Reef from its static base package, with zoomed, swimming fish."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image

from theme_writer import (ANIMATION_INTERPOLATE, Animation, BACKGROUND,
                          ParameterAnimation, ParameterFrame, TextureRegions,
                          decode_regions, dual_texture_background,
                          pack_after_parameters, pack_parameter_animation,
                          read_metadata, record_value, regions_record,
                          replace_record, write_theme)


ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "assets" / "texture-sources" / "coral-reef-base.png"
OUTPUT = ROOT / "assets" / "themes" / "coral-reef.png"
ROWS = 1


def fish_motion() -> tuple[ParameterFrame, ...]:
    """Oscillate the fish layer's velocity channels without altering its art."""
    return tuple(
        ParameterFrame(
            layer1_dx=.028 + .014 * math.sin(index * math.tau / 8),
            layer1_dy=.004 + .010 * math.cos(index * math.tau / 8),
        )
        for index in range(8)
    )


def build() -> Path:
    image = Image.open(BASE).convert("RGBA")
    rows, records = read_metadata(image)
    artwork = image.crop((0, rows, image.width, image.height))
    regions = decode_regions(record_value(records, 5))
    layer0 = artwork.crop((regions.layer0.x, regions.layer0.y - ROWS,
                           regions.layer0.x + regions.layer0.width,
                           regions.layer0.y - ROWS + regions.layer0.height))
    layer1 = artwork.crop((regions.layer1.x, regions.layer1.y - ROWS,
                           regions.layer1.x + regions.layer1.width,
                           regions.layer1.y - ROWS + regions.layer1.height))
    parameter_record, parameter_sheet = pack_parameter_animation(
        ParameterAnimation(fish_motion(), Animation(90, ANIMATION_INTERPOLATE, 8)), ROWS)
    packed = pack_after_parameters(parameter_sheet, (layer0, layer1))
    records = replace_record(records, dual_texture_background(
        .49, .50, .001, .002, .028, .004, 0, 255, 255))
    records = replace_record(records, regions_record(
        TextureRegions(*packed.rectangles), ROWS))
    records.append(parameter_record)
    write_theme(OUTPUT, records, packed.image, ROWS)
    return OUTPUT


if __name__ == "__main__":
    print(f"wrote {build().relative_to(ROOT)}")
