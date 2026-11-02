#!/usr/bin/env python3
"""Build the animated Riad Courtyard theme."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

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
    pack_after_parameters,
    pack_parameter_animation,
    lerp_rgba,
    palette,
    quantize_fixed_palette,
    regions_record,
    text_record,
    write_theme,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "texture-sources" / "riad-courtyard-raw.jpg"
OUTPUT = ROOT / "assets" / "themes" / "riad-courtyard.png"
ROWS = 2
WIDTH = 64
HEIGHT = 32

# One shared 16-entry palette serves both CI4 layers. Entry zero is the
# transparent caustic texel; the remaining entries are RGBA5551-friendly.
CI4_COLORS = (
    (0, 0, 0, 0),
    (8, 16, 16, 255),
    (8, 33, 49, 255),
    (8, 49, 90, 255),
    (0, 66, 82, 255),
    (0, 99, 107, 255),
    (8, 140, 140, 255),
    (66, 181, 173, 255),
    (214, 222, 197, 255),
    (156, 90, 57, 255),
    (173, 140, 74, 255),
    (8, 90, 107, 255),
    (16, 156, 173, 255),
    (99, 222, 214, 255),
    (189, 247, 230, 255),
    (247, 255, 239, 255),
)

BASE_PALETTE = palette(
    "03161b", ("063b43", 218), "62d8cf", "f5fff3", "acd0c5",
    "249aa6", "74ded0", "073b54", "0b6875", "01090b", "78d7a5",
    "d39a55", "031f29", "075064", "073745", "0b6877",
)


def make_layers(source: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Separate crisp zellige geometry from binary-alpha water light."""
    source = source.convert("RGB")
    crop_width = source.width
    crop_height = crop_width // 2
    top = (source.height - crop_height) // 2
    plate = source.crop((0, top, crop_width, top + crop_height))
    plate = plate.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    plate = close_seams(plate).convert("RGB")

    # Keep the generated grout edges intact so the stationary architectural
    # layer stays crisp after CI4 conversion. The extracted sparse layer adds
    # a second, independently moving pass of the brightest water ribbons.
    mosaic = plate
    mosaic = ImageEnhance.Color(mosaic).enhance(1.12)
    mosaic = ImageEnhance.Contrast(mosaic).enhance(1.15)

    luma = plate.convert("L")
    local = luma.filter(ImageFilter.GaussianBlur(1.3))
    caustics = Image.new("RGBA", (WIDTH, HEIGHT))
    source_pixels = plate.load()
    luma_pixels = luma.load()
    local_pixels = local.load()
    caustic_pixels = caustics.load()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            r, g, b = source_pixels[x, y]
            ridge = luma_pixels[x, y] - local_pixels[x, y]
            cyan_bias = g + b - 2 * r
            visible = ridge > 23 and (cyan_bias > 12 or luma_pixels[x, y] > 184)
            if not visible:
                caustic_pixels[x, y] = (0, 0, 0, 0)
                continue
            glow = max(0.0, min(1.0, (ridge - 20) / 76))
            caustic_pixels[x, y] = (
                round(58 + 164 * glow),
                round(177 + 78 * glow),
                round(174 + 73 * glow),
                255,
            )

    mosaic = close_seams(mosaic.convert("RGBA"))
    caustics = close_seams(caustics)
    return (quantize_fixed_palette(mosaic, CI4_COLORS[1:11]),
            quantize_fixed_palette(caustics, (CI4_COLORS[0], *CI4_COLORS[11:16])))


def parameter_frames() -> list[ParameterFrame]:
    frames: list[ParameterFrame] = []
    for index in range(8):
        phase = index * math.tau / 8
        shimmer = 0.5 + 0.5 * math.sin(phase - 0.35)
        frames.append(ParameterFrame(
            border=lerp_rgba("4ebbb6", "b5eee0", shimmer),
            accent=lerp_rgba("167d91", "48c9c0", shimmer),
            highlight=lerp_rgba("48b8af", "9de8d4", shimmer),
            tab_inactive=lerp_rgba("073b54", "0c5665", shimmer),
            tab_active=lerp_rgba("0b6875", "168b90", shimmer),
            # The integrated sine/cosine velocity pair traces a closed path,
            # keeping the water light continuous at the 48-second loop seam.
            layer1_scale=0.42 * math.exp(0.065 * math.sin(phase)),
            layer1_dx=0.0055 * math.cos(phase),
            layer1_dy=0.0040 * math.sin(phase),
            layer1_alpha=48 + round(52 * shimmer),
        ))
    return frames


def build() -> Path:
    mosaic, caustics = make_layers(Image.open(SOURCE))
    parameter_record, parameter_sheet = pack_parameter_animation(
        ParameterAnimation(parameter_frames(), Animation(360, ANIMATION_INTERPOLATE, 4)), ROWS
    )
    packed = pack_after_parameters(parameter_sheet, (mosaic, caustics))
    mosaic_rect, caustics_rect = packed.rectangles
    records = [
        text_record(NAME, "Riad Courtyard"),
        text_record(FAMILY, "Texture"),
        colors_record(BASE_PALETTE),
        dual_texture_background(0.40, 0.42, 0.0, 0.0, 0.0055, 0.0, 0, 255, 66),
        regions_record(TextureRegions(mosaic_rect, caustics_rect), ROWS),
        internal_border(3),
        parameter_record,
    ]
    write_theme(OUTPUT, records, packed.image, ROWS)
    return OUTPUT


if __name__ == "__main__":
    output = build()
    print(f"wrote {output.relative_to(ROOT)}")
