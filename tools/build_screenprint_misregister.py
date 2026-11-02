#!/usr/bin/env python3
"""Build the animated Screenprint Misregister theme."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps

from theme_writer import (
    ANIMATION_INTERPOLATE,
    Animation,
    FAMILY,
    NAME,
    ParameterAnimation,
    ParameterFrame,
    TextureRegions,
    close_seams,
    colors_record,
    dual_texture_background,
    internal_border,
    lerp_rgba,
    pack_after_parameters,
    pack_parameter_animation,
    palette,
    quantize_fixed_palette,
    regions_record,
    text_record,
    write_theme,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "texture-sources" / "screenprint-misregister-raw.jpg"
OUTPUT = ROOT / "assets" / "themes" / "screenprint-misregister.png"
ROWS = 2
SIZE = 64


PRINT_COLORS = (
    (255, 247, 222, 255),
    (239, 222, 181, 255),
    (222, 197, 156, 255),
    (24, 24, 24, 255),
    (41, 41, 41, 255),
    (66, 57, 49, 255),
    (0, 115, 132, 255),
    (0, 165, 181, 255),
    (66, 206, 206, 255),
    (189, 33, 33, 255),
    (239, 49, 41, 255),
    (255, 99, 74, 255),
    (206, 107, 16, 255),
    (247, 156, 16, 255),
    (123, 57, 41, 255),
    (0, 66, 74, 255),
)

THEME_PALETTE = palette(
    "f6e9c9", ("292522", 232), "111111", "fff9e5", "c8bca2",
    "00a4b5", "ef4339", "14343b", "92342f", "080706", "4caa7e",
    "ed8f24", "f2ddba", "e8cfa3", "dcc092", "cda978",
)


def make_texture(source: Image.Image) -> Image.Image:
    source = ImageOps.fit(source.convert("RGB"), (512, 512), method=Image.Resampling.LANCZOS)
    source = source.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    source = ImageEnhance.Color(source).enhance(1.16)
    source = ImageEnhance.Contrast(source).enhance(1.12)
    return quantize_fixed_palette(close_seams(source), PRINT_COLORS)


def parameter_frames() -> list[ParameterFrame]:
    frames: list[ParameterFrame] = []
    for index in range(12):
        phase = index * math.tau / 12
        red = 0.5 + 0.5 * math.sin(phase - 0.35)
        overlap = 0.5 + 0.5 * math.sin(phase * 2 + 0.6)
        frames.append(ParameterFrame(
            border=lerp_rgba("008fa5", "e43c35", red),
            accent=lerp_rgba("00a7b8", "f04438", red),
            highlight=lerp_rgba("ed493e", "16b5bf", red),
            tab_inactive=lerp_rgba("14343b", "522729", red),
            tab_active=lerp_rgba("1b6972", "92342f", red),
            # Opposing velocity channels integrate to a visible, closed
            # registration loop: the plates drift roughly six texels apart,
            # then reunite over the 24-second cycle.
            layer0_dx=0.00018 + 0.00160 * math.cos(phase),
            layer0_dy=0.000055 + 0.00110 * math.sin(phase),
            layer1_dx=0.00018 - 0.00160 * math.cos(phase),
            layer1_dy=0.000055 - 0.00110 * math.sin(phase),
            layer1_alpha=110 + round(60 * overlap),
        ))
    return frames


def build() -> Path:
    texture = make_texture(Image.open(SOURCE))
    parameter_record, parameter_sheet = pack_parameter_animation(
        ParameterAnimation(
            parameter_frames(),
            Animation(120, ANIMATION_INTERPOLATE, 4),
        ),
        ROWS,
    )
    packed = pack_after_parameters(parameter_sheet, (texture,))
    shared_rect = packed.rectangles[0]
    records = [
        text_record(NAME, "Screenprint Misregister"),
        text_record(FAMILY, "Texture"),
        colors_record(THEME_PALETTE),
        dual_texture_background(0.42, 0.42, 0.00178, 0.000055,
                                -0.00142, 0.000055,
                                0.0, 255, 82),
        regions_record(TextureRegions(shared_rect, shared_rect), ROWS),
        internal_border(2),
        parameter_record,
    ]
    write_theme(OUTPUT, records, packed.image, ROWS)
    return OUTPUT


if __name__ == "__main__":
    output = build()
    print(f"wrote {output.relative_to(ROOT)}")
