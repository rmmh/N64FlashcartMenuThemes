#!/usr/bin/env python3
"""Build the animated Solar Granules theme."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from theme_writer import (
    Animation, FAMILY, NAME, ParameterAnimation, ParameterFrame, TextureRegions,
    colors_record, dual_texture_background, internal_border, pack_after_parameters,
    pack_parameter_animation, palette, regions_record, text_record,
    texture_animations, write_theme,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "texture-sources" / "solar-granules-raw.jpg"
OUTPUT = ROOT / "assets" / "themes" / "solar-granules.png"
ROWS = 2
SIZE = 32
FRAME_COUNT = 8


BASE_PALETTE = palette(
    "25030a", ("4a0710", 220), "e95012", "fff2cf",
    "dfb27c", "ff9d18", "ffd34b", "59100f",
    "9c210e", "0b0103", "7bd89d", "ffc33d",
    "3c050a", "8f160c", "de480c", "ffb51e",
)


def _roll(image: Image.Image, dx: int, dy: int) -> Image.Image:
    """Offset an image with toroidal wrapping."""
    return Image.frombytes(image.mode, image.size, bytes(
        image.getpixel(((x - dx) % image.width, (y - dy) % image.height))[channel]
        for y in range(image.height)
        for x in range(image.width)
        for channel in range(len(image.getbands()))
    ))


def _close_seams(image: Image.Image) -> Image.Image:
    """Make opposite edge texels equal so RDP repeat filtering has no join."""
    image = image.copy()
    pixels = image.load()
    for y in range(image.height):
        pair = tuple((pixels[0, y][c] + pixels[image.width - 1, y][c]) // 2
                     for c in range(len(image.getbands())))
        pixels[0, y] = pixels[image.width - 1, y] = pair
    for x in range(image.width):
        pair = tuple((pixels[x, 0][c] + pixels[x, image.height - 1][c]) // 2
                     for c in range(len(image.getbands())))
        pixels[x, 0] = pixels[x, image.height - 1] = pair
    return image


def solar_frames(source: Image.Image) -> tuple[list[Image.Image], Image.Image]:
    """Reduce the generated plate into a looping convection animation."""
    source = source.convert("RGB")
    # Preserve a handful of large convection cells at 32x32 instead of
    # collapsing the whole generated plate into high-frequency noise.
    side = round(min(source.size) * 0.55)
    left = (source.width - side) // 2
    top = (source.height - side) // 2
    source = source.crop((left, top, left + side, top + side))
    source = ImageOps.fit(source, (384, 384), method=Image.Resampling.LANCZOS)
    base = source.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    base = ImageEnhance.Color(base).enhance(1.18)
    base = ImageEnhance.Contrast(base).enhance(1.13)
    base = _close_seams(base)

    soft = base.filter(ImageFilter.GaussianBlur(1.15))
    frames: list[Image.Image] = []
    for index in range(FRAME_COUNT):
        phase = index * math.tau / FRAME_COUNT
        # Counter-moving wrapped samples expand and contract the cell interiors.
        dx = round(1.6 * math.cos(phase))
        dy = round(1.6 * math.sin(phase))
        hot = _roll(base, dx, dy)
        cool = _roll(soft, -dx, -dy)
        frame = Image.blend(hot, cool, 0.20 + 0.10 * (1 + math.sin(phase)) / 2)
        frame = ImageEnhance.Brightness(frame).enhance(0.96 + 0.08 * math.sin(phase + 0.5))
        frames.append(_close_seams(frame.convert("RGBA")))

    # A transparent RGBA5551 layer isolates the hottest ridges; Type 9 pulses it.
    luminance = ImageOps.grayscale(base)
    edges = luminance.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(0.45))
    overlay = Image.new("RGBA", (SIZE, SIZE), (255, 174, 32, 0))
    op = overlay.load()
    ep = edges.load()
    lp = luminance.load()
    for y in range(SIZE):
        for x in range(SIZE):
            visible = ep[x, y] > 38 and lp[x, y] > 112
            op[x, y] = (255, min(255, 116 + lp[x, y] // 2), 20, 255 if visible else 0)
    return frames, _close_seams(overlay)


def parameter_frames() -> list[ParameterFrame]:
    """Pulse only the ridge overlay; UI colors stay calm and fixed."""
    return [ParameterFrame(layer1_alpha=56 + round(94 * (1 + math.sin(
        index * math.tau / FRAME_COUNT - 0.5)) / 2)) for index in range(FRAME_COUNT)]


def build() -> Path:
    frames, overlay = solar_frames(Image.open(SOURCE))
    parameter_record, parameter_sheet = pack_parameter_animation(
        ParameterAnimation(parameter_frames(), Animation(18, 8, 4)), ROWS
    )
    packed = pack_after_parameters(parameter_sheet, (*frames, overlay))
    layer0_rect = packed.rectangles[0]
    layer1_rect = packed.rectangles[-1]
    records = [
        text_record(NAME, "Solar Granules"),
        text_record(FAMILY, "Texture"),
        colors_record(BASE_PALETTE),
        dual_texture_background(1.05, 1.05, 0.0015, -0.001, -0.002, 0.001, 0, 255, 88),
        regions_record(TextureRegions(layer0_rect, layer1_rect), ROWS),
        internal_border(2),
        texture_animations(FRAME_COUNT, Animation(9, 8, 2)),
        parameter_record,
    ]
    write_theme(OUTPUT, records, packed.image, ROWS)
    return OUTPUT


if __name__ == "__main__":
    output = build()
    print(f"wrote {output.relative_to(ROOT)}")
