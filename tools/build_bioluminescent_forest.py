#!/usr/bin/env python3
"""Build the animated Bioluminescent Forest theme."""

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
SOURCE = ROOT / "assets" / "texture-sources" / "bioluminescent-forest-raw.jpg"
OUTPUT = ROOT / "assets" / "themes" / "bioluminescent-forest.png"
ROWS = 2
SIZE = 32
GLOW_FRAMES = 8
SELECTORS = (0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1)
ENERGY = (.08, .14, .22, .34, .50, .70, 1.0, .48,
          .68, .92, .64, .40, .24, .13)


COLORS = palette(
    "020d0c", ("071b18", 224), "337c70", "e8fff4",
    "96bfb1", "1fb59e", "72f0cd", "102d29",
    "175b51", "010605", "73cf9b", "d9a85f",
    "041411", "0b3029", "17251f", "135348",
)


def source_tile(source: Image.Image) -> Image.Image:
    source = source.convert("RGB")
    # Work from one root junction rather than shrinking the entire dense source;
    # broad trunks must survive RGBA16 conversion and remain legible at UI scale.
    crop = round(min(source.size) * .47)
    left = round(source.width * .26)
    top = round(source.height * .22)
    source = source.crop((left, top, left + crop, top + crop))
    source = ImageOps.fit(source, (SIZE, SIZE),
                          method=Image.Resampling.LANCZOS)
    return close_seams(ImageEnhance.Contrast(source).enhance(1.34))


def root_and_glow_frames(source: Image.Image) -> tuple[Image.Image, list[Image.Image]]:
    """Separate a fixed root bed from eight traveling luminous wavefronts."""
    src = source.load()
    root = Image.new("RGBA", (SIZE, SIZE))
    root_px = root.load()
    frames = [Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
              for _ in range(GLOW_FRAMES)]
    outputs = [frame.load() for frame in frames]
    for y in range(SIZE):
        for x in range(SIZE):
            red, green, blue, _ = src[x, y]
            luminous = max(red, green, blue)
            chroma = blue + green - red
            # Three broad periodic roots form visible junctions at 32x32. The
            # source contributes mottled bark color without dictating geometry.
            h0 = 8 + 4 * math.sin(math.tau * x / SIZE)
            h1 = 23 + 5 * math.sin(math.tau * x / SIZE + 2.1)
            v0 = 17 + 5 * math.sin(math.tau * y / SIZE + .8)
            dh = min(abs(y - h0), abs(y - h0 + SIZE), abs(y - h0 - SIZE))
            dh = min(dh, abs(y - h1), abs(y - h1 + SIZE), abs(y - h1 - SIZE))
            dv = min(abs(x - v0), abs(x - v0 + SIZE), abs(x - v0 - SIZE))
            distance = min(dh, dv)
            bark = max(0, 1 - distance / 3.2)
            mottled = luminous / 255
            root_px[x, y] = (
                round(3 + 34 * bark + 8 * mottled),
                round(10 + 60 * bark + 14 * mottled),
                round(10 + 42 * bark + 12 * mottled), 255,
            )
            along = x if dh <= dv else y
            phase = (along // 4 + (1 if dh > dv else 0)) % GLOW_FRAMES
            eligible = distance < 1.35
            for index, output in enumerate(outputs):
                distance = min((phase - index) % GLOW_FRAMES,
                               (index - phase) % GLOW_FRAMES)
                if eligible and distance <= 1:
                    strength = 1.0 if distance == 0 else .48
                    violet = red > green * .80
                    if violet:
                        color = (round(110 * strength), round(120 * strength),
                                 round(255 * strength), 255)
                    else:
                        color = (round(70 * strength), round(255 * strength),
                                 round(205 * strength), 255)
                    output[x, y] = color
    root = close_seams(root)
    closed = []
    for frame in frames:
        frame = close_seams(frame)
        pixels = frame.load()
        for y in range(SIZE):
            for x in range(SIZE):
                r, g, b, a = pixels[x, y]
                pixels[x, y] = (r, g, b, 255 if a >= 128 else 0)
        closed.append(frame)
    return root, closed


def parameter_frames() -> list[ParameterFrame]:
    frames = []
    for selector, energy in zip(SELECTORS, ENERGY):
        # Slow charge, mint-white flash, then a violet-tinged decay/return.
        return_phase = len(frames) >= 8
        border_hot = "baffdf" if not return_phase else "a7b6ff"
        highlight_hot = "eefff8" if not return_phase else "d9d5ff"
        phase = len(frames) * math.tau / len(SELECTORS)
        scale = .24 + .011 * math.sin(phase)
        dx = .00035 * math.cos(phase)
        dy = .00025 * math.sin(phase)
        frames.append(ParameterFrame(
            border=lerp_rgba("28574f", border_hot, energy),
            accent=lerp_rgba("167768", "6dffe0", energy),
            highlight=lerp_rgba("397d70", highlight_hot, energy),
            tab_active=lerp_rgba("145047", "3ba994", energy),
            layer0_scale=scale, layer1_scale=scale,
            layer0_dx=dx, layer1_dx=dx,
            layer0_dy=dy, layer1_dy=dy,
            layer1_alpha=24 + round(220 * energy),
            layer1_texture=selector,
        ))
    return frames


def build() -> Path:
    root, glows = root_and_glow_frames(source_tile(Image.open(SOURCE)))
    parameter_record, parameter_sheet = pack_parameter_animation(
        ParameterAnimation(parameter_frames(), Animation(28, ANIMATION_INTERPOLATE, 2)),
        ROWS,
    )
    packed = pack_after_parameters(parameter_sheet, (*glows, root))
    records = [
        text_record(NAME, "Bioluminescent Forest"),
        text_record(FAMILY, "Materials"),
        colors_record(COLORS),
        dual_texture_background(.24, .24, 0, 0, 0, 0, 0, 255, 104),
        regions_record(TextureRegions(packed.rectangles[GLOW_FRAMES],
                                      packed.rectangles[0]), ROWS),
        internal_border(6),
        texture_animations(0, Animation(), GLOW_FRAMES, Animation(28, 0, 2)),
        parameter_record,
    ]
    write_theme(OUTPUT, records, packed.image, ROWS)
    return OUTPUT


if __name__ == "__main__":
    output = build()
    print(f"wrote {output.relative_to(ROOT)}")
