#!/usr/bin/env python3
"""Build Matrix from two explicit, interpolated glyph-rain texture sequences."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from theme_writer import (ANIMATION_INTERPOLATE, Animation, FAMILY, NAME,
                          TextureRegions, colors_record,
                          dual_texture_background, internal_border,
                          pack_artwork, palette, regions_record, text_record,
                          texture_animations, texture_origin, write_theme)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "themes" / "matrix.png"
ROWS, SIZE, FRAMES = 1, 32, 8
COLUMNS = (0, 5, 10, 15, 20, 25, 29)
VERTICAL_OFFSETS = (0, 2, 1, 3, 1, 2, 3)
FALL_STEPS = (1, 2, 3, 5, 3, 2, 1)
CELL = 4

COLORS = palette(
    "010905", ("04180e", 226), "278a62", "eaffef", "a8c8b8",
    "29c778", "58e4d2", "0b3320", "176443", "000302", "68c88b",
    "d1a05d", "02140a", "07301b", "061d12", "125537",
)

def bitmap(top: str, middle: str, bottom: str) -> int:
    """Encode a readable 3×3 glyph written in visual top-to-bottom order."""
    return int(bottom + middle + top, 2)


# Every glyph below has a real reference; we avoid synthetic noise masks that
# merely resemble punctuation at this resolution.  The katakana forms are
# horizontally reversed to retain the intended Matrix-like reading direction.
BACKWARDS_KATAKANA = (
    # Digits
    bitmap("111", "101", "111"),  # 0 / O
    bitmap("010", "110", "010"),  # 1
    bitmap("111", "011", "110"),  # 2
    bitmap("111", "011", "111"),  # 3
    bitmap("101", "111", "001"),  # 4
    bitmap("110", "111", "011"),  # 5
    bitmap("110", "101", "111"),  # 6
    bitmap("111", "001", "001"),  # 7
    bitmap("010", "111", "010"),  # 十 (Japanese kanji: ten)
    bitmap("111", "101", "011"),  # 9
    # Mirrored katakana with stable three-pixel silhouettes
    bitmap("111", "010", "011"),  # ア
    bitmap("111", "010", "111"),  # エ
    bitmap("111", "111", "010"),  # キ
    bitmap("111", "010", "110"),  # チ
    bitmap("001", "111", "101"),  # ケ
    bitmap("111", "001", "111"),  # コ
    bitmap("111", "010", "010"),  # ナ
    bitmap("111", "000", "111"),  # ニ
    bitmap("100", "110", "100"),  # ト
    bitmap("110", "100", "111"),  # ヒ
    bitmap("101", "111", "010"),  # ヤ
    # Clear Latin forms, also used as compact terminal characters
    bitmap("010", "111", "101"),  # A
    bitmap("111", "100", "111"),  # C
    bitmap("111", "110", "111"),  # E
    bitmap("101", "111", "101"),  # H
    bitmap("100", "100", "111"),  # L
    bitmap("101", "101", "111"),  # U
)


def glyph(image: Image.Image, x: int, y: int, code: int, color) -> None:
    """Draw one fixed backwards-katakana pixel glyph."""
    pixels = image.load()
    mask = BACKWARDS_KATAKANA[code % len(BACKWARDS_KATAKANA)]
    for row in range(3):
        bits = (mask >> (row * 3)) & 0x7
        for column in range(3):
            if bits & (1 << (2 - column)):
                pixels[(x + column) % SIZE, (y + row) % SIZE] = color


def dim_frame(_frame: int) -> Image.Image:
    """A stable low-energy glyph field behind the animated traces."""
    image = Image.new("RGBA", (SIZE, SIZE), (0, 5, 2, 255))
    for column, x in enumerate(COLUMNS):
        y_offset = VERTICAL_OFFSETS[column]
        for cell in range(8):
            # A few dark gaps let the bright traces read as independent falls.
            if (cell * 3 + column * 5) % 9 in (0, 1):
                continue
            code = 0x12D ^ (cell * 0x53 + column * 0x2F)
            glyph(image, x, cell * CELL + y_offset, code,
                  (6, 45 + (cell % 3) * 12, 20 + (column % 2) * 10, 255))
    return image


def trace_frame(frame: int) -> Image.Image:
    """Independent falling glyph heads with a phosphor-decay trail."""
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    for column, x in enumerate(COLUMNS):
        # Each stream advances at a different cadence, so the six heads do not
        # collapse into one scrolling sheet.  The eight-frame cycle closes.
        head = (column * 3 + frame * FALL_STEPS[column]) % 8
        y_offset = VERTICAL_OFFSETS[column]
        for trail in range(6):
            cell = (head - trail) % 8
            color = ((210, 255, 224, 255) if trail == 0 else
                     (78, 238, 126, 255) if trail == 1 else
                     (16, 170 - trail * 24, 64 - trail * 8, 255))
            # Only the head and its immediate afterimage cycle.  Older
            # phosphor decays at a fixed glyph position instead of flickering.
            phase = frame - trail if trail < 2 else cell
            code = 0x1B7 ^ (column * 0x4D + phase * 0x17)
            glyph(image, x, cell * CELL + y_offset, code, color)
    return image


def build() -> Path:
    dim = [dim_frame(frame) for frame in range(FRAMES)]
    traces = [trace_frame(frame) for frame in range(FRAMES)]
    # Eight frames return the 8×8 glyph grid to its initial state after one
    # one-cell-per-keyframe descent. Frame blending supplies the phosphor fade
    # between these deliberate glyph-state changes.
    packed = pack_artwork((*dim, *traces))
    layer0, layer1 = packed.rectangles[0], packed.rectangles[FRAMES]
    animation = Animation(20, ANIMATION_INTERPOLATE, 2)
    records = [
        text_record(NAME, "Matrix"), text_record(FAMILY, "Machines"),
        colors_record(COLORS),
        # The dim field falls more slowly than the bright active trails.
        dual_texture_background(.25, .25, 0, .003, 0, .006, 0, 255, 255),
        texture_origin(-1, 0),
        regions_record(TextureRegions(layer0, layer1), ROWS),
        internal_border(1),
        texture_animations(FRAMES, animation, FRAMES, animation),
    ]
    write_theme(OUTPUT, records, packed.image, ROWS)
    return OUTPUT


if __name__ == "__main__":
    print(f"wrote {build().relative_to(ROOT)}")
