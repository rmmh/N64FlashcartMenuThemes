#!/usr/bin/env python3
"""Build Sakura with sparse wind-like parameter animation."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image

from theme_writer import (Animation, ParameterAnimation, ParameterFrame,
                          PARAMETER_ANIMATION, REGIONS, TextureRegions,
                          decode_regions,
                          pack_after_parameters, pack_parameter_animation,
                          read_metadata, record_value, regions_record,
                          replace_record, write_theme)


THEME = Path("assets/themes/sakura.png")
FRAME_COUNT = 16


def wind_frame(index: int) -> ParameterFrame:
    phase = math.tau * index / FRAME_COUNT
    return ParameterFrame(
        layer0_dx=0.012 * math.sin(phase),
        layer0_dy=0.014 + 0.005 * math.cos(phase + 0.45),
        layer1_dx=0.007 * math.sin(phase + 2.15),
        layer1_dy=0.009 + 0.003 * math.cos(phase + 1.20),
    )


def main() -> None:
    source = Image.open(THEME).convert("RGBA")
    metadata_rows, records = read_metadata(source)
    records = [(kind, value) for kind, value in records
               if kind != PARAMETER_ANIMATION]
    source_region = decode_regions(record_value(records, REGIONS)).layer0
    texture = source.crop((source_region.x, source_region.y,
                           source_region.x + source_region.width,
                           source_region.y + source_region.height))

    parameter_record, parameter_sheet = pack_parameter_animation(
        ParameterAnimation(
            tuple(wind_frame(index) for index in range(FRAME_COUNT)),
            Animation(frame_ticks=75, flags=8, columns=16),
        ),
        metadata_rows,
    )
    records.append(parameter_record)
    packed = pack_after_parameters(parameter_sheet, (texture,))
    texture_region = packed.rectangles[0]
    records = replace_record(records, regions_record(TextureRegions(
        texture_region, texture_region), metadata_rows))
    write_theme(THEME, records, packed.image, metadata_rows)
    print(f"wrote {THEME} ({packed.image.width}x{metadata_rows + packed.image.height})")


if __name__ == "__main__":
    main()
