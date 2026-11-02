#!/usr/bin/env python3
"""Build curated themes from generated source patches."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

from theme_writer import (
    Animation, FAMILY, NAME, ParameterAnimation, ParameterFrame, TextureRegions,
    colors_record, dual_texture_background, internal_border, pack_after_parameters,
    pack_parameter_animation, palette, regions_record, text_record, write_theme,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "assets" / "texture-sources"
THEME_DIR = ROOT / "assets" / "themes"
ROWS = 2


def gas_giant_layers(source: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Reduce generated art into an opaque RGBA16 base and binary overlay."""
    source = source.convert("RGB")
    # Image generation produced a 2x4 periodic plate. Work from one repeat
    # cell so 32x32 retains broad bands instead of compressing eight periods.
    source = source.crop((0, 0, source.width // 2, source.height // 4))
    base = source.resize((32, 32), Image.Resampling.LANCZOS)
    base = ImageEnhance.Color(base).enhance(1.12)
    base = ImageEnhance.Contrast(base).enhance(1.08).convert("RGBA")

    blurred = source.filter(ImageFilter.GaussianBlur(source.width / 55))
    detail = ImageEnhance.Contrast(source).enhance(1.35)
    overlay = Image.new("RGBA", source.size)
    src_pixels, blur_pixels, detail_pixels, out = (
        source.load(), blurred.load(), detail.load(), overlay.load()
    )
    for y in range(source.height):
        for x in range(source.width):
            r, g, b = src_pixels[x, y]
            br, bg, bb = blur_pixels[x, y]
            dr, dg, db = detail_pixels[x, y]
            local = abs(r - br) + abs(g - bg) + abs(b - bb)
            warm = max(0, r - g) + max(0, g - b)
            alpha = 255 if local > 23 and warm > 24 else 0
            out[x, y] = (min(255, dr + 24), min(255, dg + 8), max(0, db - 8), alpha)
    overlay = overlay.resize((32, 32), Image.Resampling.LANCZOS)
    # RGBA5551 has binary alpha; threshold after resizing to keep clean storms.
    pixels = overlay.load()
    for y in range(32):
        for x in range(32):
            r, g, b, a = pixels[x, y]
            pixels[x, y] = (r, g, b, 255 if a >= 128 else 0)
    return base, overlay


GAS_PALETTES = (
    palette("1c0910", ("3b1715", 218), "e5a342", "fff1cf", "d7b68e", "ffb13b", "a44a22", "321311", "71301a", "090305", "79d6a4", "ffd363", "36131d", "9d3e22", "d86e24", "f5bd55"),
    palette("250b11", ("4b1a12", 218), "f0b54f", "fff4d6", "ddbd91", "ffc04b", "b55220", "3c1710", "843719", "0c0304", "7bdca4", "ffd86b", "431522", "b24822", "e67b28", "ffd064"),
    palette("32100d", ("5b2111", 218), "ffd064", "fff8dc", "e3c798", "ffd760", "c06120", "481b0d", "96451b", "100503", "84e0a8", "ffdf72", "55191d", "c55221", "ef8b2c", "ffdd73"),
    palette("2b0d14", ("501b1c", 218), "efa54c", "fff0d3", "d5b388", "ffad42", "ae4826", "401419", "80331f", "0d0307", "78d5a1", "ffd269", "4c1728", "a94131", "dd6f30", "f7bd5a"),
)


def gas_parameter_frames() -> list[ParameterFrame]:
    frames = []
    for index in range(8):
        phase = index * math.tau / 8
        colors = GAS_PALETTES[(index // 2) % len(GAS_PALETTES)]
        frames.append(ParameterFrame(
            background=colors.background,
            panel=colors.panel,
            border=colors.border,
            accent=colors.accent,
            highlight=colors.highlight,
            tab_inactive=colors.tab_inactive,
            tab_active=colors.tab_active,
            gradient_tl=colors.gradient_tl,
            gradient_tr=colors.gradient_tr,
            gradient_bl=colors.gradient_bl,
            gradient_br=colors.gradient_br,
            layer0_dx=0.010 + 0.006 * math.sin(phase),
            layer0_dy=0.0015 * math.cos(phase),
            layer1_dx=-0.020 - 0.009 * math.sin(phase + 0.7),
            layer1_dy=0.003 * math.cos(phase + 1.1),
            layer1_alpha=88 + round(34 * (0.5 + 0.5 * math.sin(phase - 0.4))),
        ))
    return frames


def build_gas_giant() -> Path:
    source_path = SOURCE_DIR / "gas-giant-bands-raw.jpg"
    layer0, layer1 = gas_giant_layers(Image.open(source_path))
    parameter_record, parameter_sheet = pack_parameter_animation(
        ParameterAnimation(gas_parameter_frames(), Animation(300, 8, 4)), ROWS
    )
    packed = pack_after_parameters(parameter_sheet, (layer0, layer1))
    layer0_rect, layer1_rect = packed.rectangles
    regions = TextureRegions(layer0_rect, layer1_rect)
    records = [
        text_record(NAME, "Gas Giant Bands"),
        text_record(FAMILY, "Texture"),
        colors_record(GAS_PALETTES[0]),
        dual_texture_background(0.72, 1.44, 0.010, 0.0, -0.020, 0.0, 0, 255, 104),
        regions_record(regions, ROWS),
        internal_border(2),
        parameter_record,
    ]
    output = THEME_DIR / "gas-giant-bands.png"
    write_theme(output, records, packed.image, ROWS)
    return output


if __name__ == "__main__":
    print(f"wrote {build_gas_giant().relative_to(ROOT)}")
