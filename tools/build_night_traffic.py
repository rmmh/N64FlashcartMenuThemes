#!/usr/bin/env python3
"""Build the animated Night Traffic theme."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from theme_writer import (
    ANIMATION_INTERPOLATE, Animation, FAMILY, NAME, TextureRegions,
    close_seams, colors_record, dual_texture_background, internal_border, pack_artwork,
    palette, regions_record, text_record,
    texture_animations, write_theme,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "texture-sources" / "night-traffic-raw.jpg"
OUTPUT = ROOT / "assets" / "themes" / "night-traffic.png"
ROWS = 2
SIZE = 32
FRAME_COUNT = 8


COLORS = palette(
    "050912", ("0a1421", 224), "5c7891", "eaf4ff",
    "94aabc", "d84235", "f3c36a", "111d2a",
    "263c50", "020407", "66d398", "f0aa4d",
    "07101b", "132638", "21394f", "36566e",
)


def road_layer(source: Image.Image) -> Image.Image:
    base = ImageOps.fit(source.convert("RGB"), (SIZE, SIZE), method=Image.Resampling.LANCZOS)
    base = ImageEnhance.Brightness(base).enhance(1.28)
    base = ImageEnhance.Contrast(base).enhance(1.15)
    base = ImageEnhance.Color(base).enhance(0.72)
    return close_seams(base.convert("RGBA"))


def put_light(image: Image.Image, x: int, y: int,
              color: tuple[int, int, int], horizontal: bool) -> None:
    """Draw a wrapped two-texel vehicle and a dim one-texel wake."""
    pixels = image.load()
    positions = ((x, y), (x - 1 if horizontal else x, y - 1 if not horizontal else y))
    wake = (x - 2 if horizontal else x, y - 2 if not horizontal else y)
    for px, py in positions:
        pixels[px % SIZE, py % SIZE] = (*color, 255)
    wr, wg, wb = (channel // 2 for channel in color)
    pixels[wake[0] % SIZE, wake[1] % SIZE] = (wr, wg, wb, 255)


def light_frames() -> list[Image.Image]:
    frames = []
    for frame in range(FRAME_COUNT):
        image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        # White headlights advance each frame; red tail lights advance on a
        # different phase and direction, giving independent-feeling clocks.
        # Separate lanes and unequal periods keep head- and tail-lights moving
        # independently in both axes without selector jumps.
        put_light(image, 4 + 4 * frame, 7, (255, 247, 214), True)
        put_light(image, 28 - 4 * frame, 20, (231, 222, 198), True)
        put_light(image, 9, 2 + 4 * frame, (247, 49, 33), False)
        put_light(image, 22, 29 - 4 * frame, (206, 33, 24), False)
        frames.append(image)
    return frames


def build() -> Path:
    roads = road_layer(Image.open(SOURCE))
    lights = light_frames()
    packed = pack_artwork((*lights, roads))
    layer1_rect = packed.rectangles[0]
    layer0_rect = packed.rectangles[-1]
    records = [
        text_record(NAME, "Night Traffic"),
        text_record(FAMILY, "Machines"),
        colors_record(COLORS),
        dual_texture_background(0.45, 0.45, 0, 0, 0, 0, 0, 255, 228),
        regions_record(TextureRegions(layer0_rect, layer1_rect), ROWS),
        internal_border(4),
        texture_animations(0, Animation(), FRAME_COUNT,
                           Animation(4, ANIMATION_INTERPOLATE, 2)),
    ]
    write_theme(OUTPUT, records, packed.image, ROWS)
    return OUTPUT


if __name__ == "__main__":
    output = build()
    print(f"wrote {output.relative_to(ROOT)}")
