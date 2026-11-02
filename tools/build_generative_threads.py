#!/usr/bin/env python3
"""Build the animated Generative Threads theme."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps

from theme_writer import (
    ANIMATION_INTERPOLATE, Animation, FAMILY, NAME, ParameterAnimation,
    ParameterFrame, TextureRegions, close_seams, colors_record,
    dual_texture_background, internal_border, pack_after_parameters,
    pack_parameter_animation, palette, quantize_fixed_palette, regions_record,
    text_record, write_theme,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "texture-sources" / "generative-threads-raw.jpg"
OUTPUT = ROOT / "assets" / "themes" / "generative-threads.png"
ROWS = 2
WIDTH, HEIGHT = 32, 64


COLORS = palette(
    "05061a", ("10132b", 222), "7a72a9", "f2efff",
    "aaa5c5", "48a9d8", "dc5b9d", "211d42",
    "47336e", "02020a", "73cf9b", "e3a262",
    "0c1232", "26306a", "5c2866", "294f83",
)

CI_COLORS = (
    (0, 0, 8, 255), (0, 8, 24, 255), (8, 16, 41, 255),
    (16, 32, 74, 255), (24, 57, 115, 255), (41, 90, 156, 255),
    (66, 132, 197, 255), (115, 189, 230, 255),
    (41, 8, 57, 255), (74, 16, 82, 255), (115, 24, 107, 255),
    (156, 41, 123, 255), (197, 66, 148, 255), (230, 107, 181, 255),
    (189, 173, 230, 255), (247, 230, 214, 255),
)


def curve_fields(source: Image.Image) -> tuple[Image.Image, Image.Image]:
    source = ImageOps.fit(source.convert("RGB"), (WIDTH, HEIGHT),
                          method=Image.Resampling.LANCZOS)
    source = ImageEnhance.Contrast(source).enhance(1.14)
    source = close_seams(source)
    cyan = Image.new("RGBA", (WIDTH, HEIGHT))
    magenta = Image.new("RGBA", (WIDTH, HEIGHT))
    src, blue_out, pink_out = source.load(), cyan.load(), magenta.load()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            red, green, blue, _ = src[x, y]
            brightness = max(red, green, blue)
            ivory = min(red, green, blue) > 168
            blue_family = blue + green >= red * 2
            pink_family = red > green * 1.08
            if ivory:
                blue_out[x, y] = pink_out[x, y] = (247, 230, 214, 255)
            else:
                blue_out[x, y] = ((24, 90, min(230, brightness + 34), 255)
                                  if blue_family and brightness > 54 else (2, 4, 18, 255))
                pink_out[x, y] = ((min(230, brightness + 28), 35, 128, 255)
                                  if pink_family and brightness > 54 else (5, 2, 16, 255))
    cyan = quantize_fixed_palette(close_seams(cyan), CI_COLORS)
    magenta = quantize_fixed_palette(close_seams(magenta), CI_COLORS)
    return cyan, magenta


def parameter_frames() -> list[ParameterFrame]:
    frames = []
    for index in range(8):
        phase = index * math.tau / 8
        handoff = 0.5 + 0.5 * math.sin(phase)
        other = 1 - handoff
        frames.append(ParameterFrame(
            layer0_scale=0.48 + 0.19 * handoff,
            layer1_scale=0.48 + 0.19 * other,
            layer0_dx=0.0015 + 0.0060 * math.sin(phase),
            layer0_dy=-0.0010 + 0.0040 * math.cos(phase),
            layer1_dx=-0.0020 + 0.0065 * math.sin(phase + math.pi / 2),
            layer1_dy=0.0010 + 0.0045 * math.cos(phase + math.pi / 2),
            layer0_alpha=126 + round(116 * handoff),
            layer1_alpha=126 + round(116 * other),
        ))
    return frames


def build() -> Path:
    cyan, magenta = curve_fields(Image.open(SOURCE))
    parameter_record, parameter_sheet = pack_parameter_animation(
        ParameterAnimation(parameter_frames(), Animation(42, ANIMATION_INTERPOLATE, 2)),
        ROWS,
    )
    packed = pack_after_parameters(parameter_sheet, (cyan, magenta))
    records = [
        text_record(NAME, "Generative Threads"),
        text_record(FAMILY, "Abstract"),
        colors_record(COLORS),
        dual_texture_background(0.575, 0.575, 0.0015, 0.003,
                                0.0045, 0.001, 0, 184, 184),
        regions_record(TextureRegions(*packed.rectangles), ROWS),
        internal_border(8),
        parameter_record,
    ]
    write_theme(OUTPUT, records, packed.image, ROWS)
    return OUTPUT


if __name__ == "__main__":
    output = build()
    print(f"wrote {output.relative_to(ROOT)}")
