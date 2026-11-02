#!/usr/bin/env python3
"""Build the comfort-aware Demo Scene Tunnel theme."""

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
SOURCE = ROOT / "assets" / "texture-sources" / "demo-scene-tunnel-raw.jpg"
OUTPUT = ROOT / "assets" / "themes" / "demo-scene-tunnel.png"
ROWS, SIZE, TUNNEL_FRAMES, SPARK_FRAMES = 2, 32, 8, 4

COLORS = palette(
    "020519", ("080d29", 228), "386fc6", "f0f5ff", "aab5d2",
    "22c2d8", "a65ce0", "121c49", "333477", "010207", "61c69b",
    "d7895d", "071033", "251750", "101e50", "4c286e",
)


def source_tile(source: Image.Image) -> Image.Image:
    image = ImageOps.fit(source.convert("RGB"), (SIZE, SIZE),
                         method=Image.Resampling.NEAREST)
    return close_seams(ImageEnhance.Contrast(image).enhance(1.18))


def tunnel_frames(source: Image.Image) -> list[Image.Image]:
    src = source.load(); frames = []
    center = (SIZE - 1) / 2
    for index in range(TUNNEL_FRAMES):
        frame = Image.new("RGBA", (SIZE, SIZE)); out = frame.load()
        phase = index / TUNNEL_FRAMES
        for y in range(SIZE):
            for x in range(SIZE):
                dx, dy = x - center, y - center
                radius = max(abs(dx), abs(dy))
                # Log-like ring coordinate advances inward while center stays fixed.
                ring = math.floor(math.log2(1 + radius) * 3.1 + phase * 2.0)
                quadrant = (x >= center) ^ (y >= center)
                branch = (ring + int(quadrant) + (index // 4)) & 3
                colors = ((2, 5, 20), (12, 38, 112), (16, 174, 212), (103, 35, 190))
                r, g, b = colors[branch]
                sr, sg, sb, _ = src[x, y]
                out[x, y] = (min(255, r + sr // 12), min(255, g + sg // 14),
                              min(255, b + sb // 12), 255)
        # Stable dark 4x4 core anchors the image throughout the travel cycle.
        for y in range(14, 18):
            for x in range(14, 18): out[x, y] = (1, 2, 14, 255)
        frames.append(close_seams(frame))
    return frames


def spark_frames() -> list[Image.Image]:
    frames = []
    for index in range(SPARK_FRAMES):
        frame = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)); px = frame.load()
        for n in range(10):
            side = (n + index) & 3
            p = (n * 7 + index * 5) % SIZE
            x, y = ((p, 1) if side == 0 else (30, p) if side == 1
                    else (p, 30) if side == 2 else (1, p))
            px[x, y] = ((240, 110, 255, 255) if n % 3 else (160, 245, 255, 255))
        frame = close_seams(frame); px = frame.load()
        for y in range(SIZE):
            for x in range(SIZE):
                r, g, b, a = px[x, y]; px[x, y] = (r, g, b, 255 if a >= 128 else 0)
        frames.append(frame)
    return frames


def parameters() -> list[ParameterFrame]:
    selectors = (0, 1, 2, 3, 4, 5, 7, 6, 4, 2)
    depth = (0, .10, .23, .40, .62, .82, 1, .78, .45, .18)
    frames = []
    for index, (selector, z) in enumerate(zip(selectors, depth)):
        # Parameter scales interpolate geometrically in the renderer, producing
        # a logarithmic-feeling pulse without moving the center or rotating.
        frames.append(ParameterFrame(
            border=lerp_rgba("315fa8", "9d62db", z),
            accent=lerp_rgba("20a7c4", "c05edc", z),
            highlight=lerp_rgba("76d9e4", "f1c6ff", z),
            tab_active=lerp_rgba("29336c", "623286", z),
            layer0_scale=.205 + .050 * z,
            layer1_scale=.205 + .050 * z,
            layer1_alpha=44 + round(78 * z),
            layer0_texture=selector,
        ))
    return frames


def build() -> Path:
    tunnels, sparks = tunnel_frames(source_tile(Image.open(SOURCE))), spark_frames()
    parameter_record, sheet = pack_parameter_animation(
        ParameterAnimation(parameters(), Animation(42, ANIMATION_INTERPOLATE, 2)), ROWS)
    packed = pack_after_parameters(sheet, (*tunnels, *sparks))
    records = [
        text_record(NAME, "Demo Scene Tunnel"), text_record(FAMILY, "Retro"),
        colors_record(COLORS),
        dual_texture_background(.205, .205, 0, 0, 0, 0, 0, 255, 70),
        regions_record(TextureRegions(packed.rectangles[0],
                                      packed.rectangles[TUNNEL_FRAMES]), ROWS),
        internal_border(2),
        texture_animations(TUNNEL_FRAMES, Animation(30, 0, 2),
                           SPARK_FRAMES, Animation(47, 0, 2)),
        parameter_record,
    ]
    write_theme(OUTPUT, records, packed.image, ROWS)
    return OUTPUT


if __name__ == "__main__": print(f"wrote {build().relative_to(ROOT)}")
