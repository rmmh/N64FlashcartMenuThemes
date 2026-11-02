#!/usr/bin/env python3
"""Focused tests for reusable Python theme-building helpers."""

import sys
import unittest
from pathlib import Path

from PIL import Image


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from theme_writer import (  # noqa: E402
    ANIMATION_INTERPOLATE,
    ANIMATION_PING_PONG,
    ANIMATION_REVERSED,
    COMFORTABLE_ROTATION_LIMIT,
    close_seams,
    lerp_rgba,
    quantize_fixed_palette,
    static_image_background,
    write_theme,
    palette,
    colors_record,
    text_record,
    NAME,
    FAMILY,
    internal_border,
)


class ThemeWriterHelpersTest(unittest.TestCase):
    def test_animation_flag_values_match_format(self):
        self.assertEqual(ANIMATION_PING_PONG, 1)
        self.assertEqual(ANIMATION_REVERSED, 4)
        self.assertEqual(ANIMATION_INTERPOLATE, 8)
        self.assertEqual(COMFORTABLE_ROTATION_LIMIT, 0.001)

    def test_lerp_rgba_accepts_hex_and_alpha_override(self):
        self.assertEqual(lerp_rgba("000000", "ffffff", 0.5), (128, 128, 128, 255))
        self.assertEqual(lerp_rgba("ff0000", "0000ff", 0.25, 77), (191, 0, 64, 77))

    def test_close_seams_matches_opposite_edges(self):
        image = Image.new("RGBA", (4, 3), (0, 0, 0, 255))
        image.putpixel((0, 1), (20, 40, 60, 255))
        image.putpixel((3, 1), (100, 120, 140, 255))
        image.putpixel((2, 0), (40, 60, 80, 255))
        image.putpixel((2, 2), (120, 140, 160, 255))
        closed = close_seams(image)
        self.assertEqual(closed.getpixel((0, 1)), closed.getpixel((3, 1)))
        self.assertEqual(closed.getpixel((2, 0)), closed.getpixel((2, 2)))

    def test_fixed_palette_preserves_transparency_class(self):
        image = Image.new("RGBA", (2, 1))
        image.putdata(((250, 20, 20, 255), (250, 250, 250, 0)))
        colors = ((0, 0, 0, 0), (255, 0, 0, 255), (0, 0, 255, 255))
        quantized = quantize_fixed_palette(image, colors)
        self.assertEqual(quantized.getpixel((0, 0)), colors[1])
        self.assertEqual(quantized.getpixel((1, 0)), colors[0])

    def test_static_background_accepts_full_screen_artwork(self):
        import tempfile
        colors = palette(*(["112233"] * 16))
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "static.png"
            write_theme(output, [text_record(NAME, "Static"), text_record(FAMILY, "Texture"),
                colors_record(colors), static_image_background(), internal_border(0)],
                Image.new("RGBA", (640, 480), (20, 40, 60, 255)))
            with Image.open(output) as package:
                self.assertEqual(package.size, (640, 481))


if __name__ == "__main__":
    unittest.main()
