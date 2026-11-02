#!/usr/bin/env python3
"""Build the animated Lava Crust theme."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps

from theme_writer import (
    ANIMATION_INTERPOLATE, Animation, FAMILY, NAME, ParameterAnimation,
    ParameterFrame, TextureRegions, close_seams, colors_record,
    dual_texture_background, internal_border, lerp_rgba, pack_after_parameters,
    pack_parameter_animation, palette, regions_record, text_record,
    texture_animations, write_theme,
)

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "texture-sources" / "lava-crust-raw.jpg"
OUTPUT = ROOT / "assets" / "themes" / "lava-crust.png"
ROWS, SIZE, MAGMA_FRAMES = 2, 32, 8
SELECTORS = (0, 1, 2, 3, 4, 5, 6, 7, 5, 3, 1, 0,
             7, 6, 4, 2, 1, 0)
PRESSURE = (.07, .10, .16, .25, .40, .62, 1.0, .72, .46, .27, .15, .08,
            .12, .22, .48, .82, .36, .10)

COLORS = palette(
    "100807", ("1a0e0b", 224), "713321", "fff0d8", "b9947b",
    "c84a18", "ffb52b", "28120d", "6f2414", "050202", "c78035",
    "e8a047", "210906", "3b1008", "170504", "5b1608",
)


def source_tile(source: Image.Image) -> Image.Image:
    image = ImageOps.fit(source.convert("RGB"), (SIZE, SIZE),
                         method=Image.Resampling.LANCZOS)
    return close_seams(ImageEnhance.Contrast(image).enhance(1.18))


def layers(source: Image.Image) -> tuple[Image.Image, list[Image.Image]]:
    src = source.load()
    basalt = Image.new("RGBA", (SIZE, SIZE))
    base = basalt.load()
    magma = [Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
             for _ in range(MAGMA_FRAMES)]
    out = [frame.load() for frame in magma]
    for y in range(SIZE):
        for x in range(SIZE):
            r, g, b, _ = src[x, y]
            hot = r - (g + b) / 2
            rock = max(0, min(255, round((r + g + b) / 3)))
            # Strip source magma from the fixed layer while retaining coarse
            # basalt shading and plate silhouettes.
            # Cool source fissures to dark red-brown in the basalt image so
            # plate boundaries remain visible even when magma alpha is low.
            edge = max(0, min(90, round(hot * .45)))
            base[x, y] = (14 + rock // 3 + edge, 13 + rock // 4 + edge // 4,
                          13 + rock // 4, 255)
            fissure = hot > 34 and r > 58
            # Alternating connected paths are selected through a phase derived
            # from position; successive frames open, branch, and seal them.
            path = ((x // 3) + (y // 4) + ((x * y) // 19)) % MAGMA_FRAMES
            for index, dst in enumerate(out):
                distance = min((path - index) % MAGMA_FRAMES,
                               (index - path) % MAGMA_FRAMES)
                if fissure and distance <= (1 if index in (3, 4, 5, 6) else 0):
                    bright = distance == 0
                    dst[x, y] = ((255 if bright else 198),
                                 (186 if bright else 48),
                                 (42 if bright else 8), 255)
    basalt = close_seams(basalt)
    result = []
    for frame in magma:
        frame = close_seams(frame)
        px = frame.load()
        for y in range(SIZE):
            for x in range(SIZE):
                r, g, b, a = px[x, y]
                px[x, y] = (r, g, b, 255 if a >= 128 else 0)
        result.append(frame)
    return basalt, result


def parameters() -> list[ParameterFrame]:
    frames = []
    for index, (selector, pressure) in enumerate(zip(SELECTORS, PRESSURE)):
        rupture = pressure ** 1.7
        cooling = index >= 8
        hot = "ffd354" if not cooling else "d84a18"
        frames.append(ParameterFrame(
            border=lerp_rgba("542719", hot, rupture * .07),
            accent=lerp_rgba("9a3214", "ff8c20" if not cooling else "b93618", pressure * .07),
            highlight=lerp_rgba("b04a1e", "fff0a0" if not cooling else "d76a2a", rupture * .06),
            tab_active=lerp_rgba("542014", "a84018", pressure * .05),
            layer1_scale=.25,
            layer1_alpha=22 + round(226 * pressure),
            layer1_texture=selector,
        ))
    return frames


def build() -> Path:
    basalt, magma = layers(source_tile(Image.open(SOURCE)))
    parameter_record, sheet = pack_parameter_animation(
        ParameterAnimation(parameters(), Animation(11, 0, 2)), ROWS)
    packed = pack_after_parameters(sheet, (*magma, basalt))
    records = [
        text_record(NAME, "Lava Crust"), text_record(FAMILY, "Nature"),
        colors_record(COLORS),
        dual_texture_background(.25, .25, 0, 0, 0, 0, 0, 255, 108),
        regions_record(TextureRegions(packed.rectangles[MAGMA_FRAMES],
                                      packed.rectangles[0]), ROWS),
        internal_border(5),
        texture_animations(0, Animation(), MAGMA_FRAMES, Animation(11, 0, 2)),
        parameter_record,
    ]
    write_theme(OUTPUT, records, packed.image, ROWS)
    return OUTPUT


if __name__ == "__main__":
    print(f"wrote {build().relative_to(ROOT)}")
