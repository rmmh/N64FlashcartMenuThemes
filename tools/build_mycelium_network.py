#!/usr/bin/env python3
"""Build the animated Mycelium Network theme."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from theme_writer import (
    Animation, FAMILY, NAME, ParameterAnimation, ParameterFrame, TextureRegions,
    colors_record, dual_texture_background, internal_border, pack_after_parameters,
    pack_parameter_animation, palette, regions_record, text_record, write_theme,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "texture-sources" / "mycelium-network-raw.jpg"
OUTPUT = ROOT / "assets" / "themes" / "mycelium-network.png"
ROWS = 2
SIZE = 64


COLORS = palette(
    "100b06", ("21170d", 222), "c48b3d", "fff2d2",
    "c8ad82", "d89b3d", "f6cf78", "2d2115",
    "755020", "050302", "77c894", "e6a44c",
    "160e07", "3a2714", "755026", "c79342",
)

# Fixed opaque RGBA5551-friendly colors. Supplying no more than sixteen exact
# colors makes the writer/parser's shared CI4 palette deterministic.
CI_COLORS = (
    (8, 0, 0), (16, 8, 0), (24, 16, 8), (32, 24, 8),
    (49, 32, 8), (66, 41, 8), (82, 49, 8), (99, 66, 16),
    (123, 82, 24), (148, 99, 32), (173, 123, 49), (197, 148, 74),
    (214, 173, 99), (230, 197, 132), (247, 222, 173), (255, 247, 214),
)


def close_seams(image: Image.Image) -> Image.Image:
    image = image.copy()
    pixels = image.load()
    for y in range(SIZE):
        value = tuple((pixels[0, y][c] + pixels[SIZE - 1, y][c]) // 2 for c in range(3))
        pixels[0, y] = pixels[SIZE - 1, y] = value
    for x in range(SIZE):
        value = tuple((pixels[x, 0][c] + pixels[x, SIZE - 1][c]) // 2 for c in range(3))
        pixels[x, 0] = pixels[x, SIZE - 1] = value
    return image


def ci4_texture(source: Image.Image) -> Image.Image:
    source = ImageOps.fit(source.convert("RGB"), (SIZE, SIZE), method=Image.Resampling.LANCZOS)
    source = ImageEnhance.Contrast(source).enhance(1.24)
    source = ImageEnhance.Color(source).enhance(0.88)
    source = source.filter(ImageFilter.UnsharpMask(1.0, 135, 2))
    source = close_seams(source)
    output = Image.new("RGBA", (SIZE, SIZE))
    src, dst = source.load(), output.load()
    for y in range(SIZE):
        for x in range(SIZE):
            r, g, b = src[x, y]
            # Warm perceived luminance retains cream threads and amber knots.
            level = (2 * r + 2 * g + b) // 5
            index = min(15, max(0, round((level / 255) ** 0.82 * 15)))
            dst[x, y] = (*CI_COLORS[index], 255)
    return output


def parameter_frames() -> list[ParameterFrame]:
    frames = []
    for index in range(8):
        phase = index * math.tau / 8
        # The overlay's changing vector drifts its bright knots across the
        # nearly stationary base. Alpha crests a quarter-cycle later.
        frames.append(ParameterFrame(
            layer1_dx=0.0007 + 0.0008 * math.cos(phase),
            layer1_dy=0.0004 + 0.0008 * math.sin(phase),
            layer1_alpha=34 + round(78 * (0.5 + 0.5 * math.sin(phase - 0.8))),
        ))
    return frames


def build() -> Path:
    texture = ci4_texture(Image.open(SOURCE))
    parameter_record, parameter_sheet = pack_parameter_animation(
        ParameterAnimation(parameter_frames(), Animation(54, 8, 4)), ROWS
    )
    packed = pack_after_parameters(parameter_sheet, (texture,))
    shared = packed.rectangles[0]
    records = [
        text_record(NAME, "Mycelium Network"),
        text_record(FAMILY, "Materials"),
        colors_record(COLORS),
        dual_texture_background(0.92, 0.92, 0.0008, -0.0004,
                                0.0007, 0.0004, 0, 255, 66),
        regions_record(TextureRegions(shared, shared), ROWS),
        internal_border(5),
        parameter_record,
    ]
    write_theme(OUTPUT, records, packed.image, ROWS)
    return OUTPUT


if __name__ == "__main__":
    output = build()
    print(f"wrote {output.relative_to(ROOT)}")
