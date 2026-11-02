#!/usr/bin/env python3
"""Build the animated Ink Wash Mountains theme."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps

from theme_writer import (
    ANIMATION_INTERPOLATE, ANIMATION_PING_PONG, Animation, FAMILY, NAME,
    ParameterAnimation, ParameterFrame, TextureRegions, close_seams,
    colors_record, dual_texture_background, internal_border,
    pack_after_parameters, pack_parameter_animation, palette, regions_record,
    text_record, texture_animations, write_theme,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "texture-sources" / "ink-wash-mountains-raw.jpg"
OUTPUT = ROOT / "assets" / "themes" / "ink-wash-mountains.png"
ROWS = 2
SIZE = 32
FRAME_COUNT = 4


COLORS = palette(
    "171717", ("252525", 226), "9d9a90", "f3efe4",
    "b9b6ad", "858987", "d5d0c4", "323331",
    "5b5b57", "080808", "7fc498", "c7ad72",
    "222323", "434542", "6d6c67", "9b9991",
)


def mountain_layer(source: Image.Image) -> tuple[Image.Image, Image.Image]:
    source = ImageOps.fit(source.convert("RGB"), (SIZE, SIZE),
                          method=Image.Resampling.LANCZOS)
    source = ImageOps.grayscale(source)
    source = ImageEnhance.Contrast(source).enhance(1.12)
    light = source.convert("RGBA")
    base = ImageEnhance.Brightness(source).enhance(0.54).convert("RGBA")
    return close_seams(base), close_seams(light)


def mist_frames(light_source: Image.Image) -> list[Image.Image]:
    luminance = ImageOps.grayscale(light_source)
    pixels = luminance.load()
    frames = []
    # Only describe half a cycle. Ping-pong interpolation supplies the return,
    # so neither the silhouette nor its motion snaps at the loop boundary.
    for frame_index in range(FRAME_COUNT):
        phase = frame_index * math.pi / (FRAME_COUNT - 1)
        image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        output = image.load()
        for y in range(SIZE):
            for x in range(SIZE):
                band = math.sin(y * math.tau / 9 + phase)
                drift = math.sin(x * math.tau / SIZE + phase * 0.65)
                threshold = 168 - 20 * band - 10 * drift
                if pixels[x, y] > threshold:
                    shade = min(247, 190 + pixels[x, y] // 4)
                    output[x, y] = (shade, shade - 2, shade - 8, 255)
        frames.append(close_seams(image))
    return frames


def parameter_frames() -> list[ParameterFrame]:
    frames = []
    for index in range(8):
        phase = index * math.tau / 8
        breath = 0.5 + 0.5 * math.sin(phase - 0.4)
        frames.append(ParameterFrame(
            layer1_dx=0.0007 + 0.00135 * math.sin(phase),
            layer1_alpha=62 + round(66 * breath),
        ))
    return frames


def build() -> Path:
    mountains, light = mountain_layer(Image.open(SOURCE))
    mist = mist_frames(light)
    parameter_record, parameter_sheet = pack_parameter_animation(
        ParameterAnimation(parameter_frames(), Animation(75, ANIMATION_INTERPOLATE, 8)),
        ROWS,
    )
    packed = pack_after_parameters(parameter_sheet, (*mist, mountains))
    layer1_rect, layer0_rect = packed.rectangles[0], packed.rectangles[-1]
    records = [
        text_record(NAME, "Ink Wash Mountains"),
        text_record(FAMILY, "Materials"),
        colors_record(COLORS),
        dual_texture_background(0.52, 0.52, 0, 0, 0.0007, 0, 0, 255, 94),
        regions_record(TextureRegions(layer0_rect, layer1_rect), ROWS),
        internal_border(0),
        texture_animations(
            0, Animation(),
            FRAME_COUNT,
            Animation(100, ANIMATION_PING_PONG | ANIMATION_INTERPOLATE, 2),
        ),
        parameter_record,
    ]
    write_theme(OUTPUT, records, packed.image, ROWS)
    return OUTPUT


if __name__ == "__main__":
    output = build()
    print(f"wrote {output.relative_to(ROOT)}")
