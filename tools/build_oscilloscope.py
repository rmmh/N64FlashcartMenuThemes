#!/usr/bin/env python3
"""Build the animated Oscilloscope theme."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

from theme_writer import (
    ANIMATION_INTERPOLATE,
    ANIMATION_LOOP,
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
    lerp_rgba,
    pack_after_parameters,
    pack_parameter_animation,
    palette,
    quantize_fixed_palette,
    regions_record,
    text_record,
    texture_animations,
    write_theme,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "texture-sources" / "oscilloscope-raw.jpg"
OUTPUT = ROOT / "assets" / "themes" / "oscilloscope.png"
ROWS = 2
SIZE = 32
FRAME_COUNT = 6


THEME_PALETTE = palette(
    "000d0b", ("03241f", 222), "23bd83", "ebfff0", "91b5a3",
    "18a870", "43dc93", "062e27", "085b47", "000403", "6bd69a",
    "e0a34b", "001611", "023528", "012219", "075743",
)

GRID_COLORS = (
    (0, 8, 7, 255),
    (0, 16, 13, 255),
    (0, 25, 19, 255),
    (0, 41, 29, 255),
    (0, 58, 40, 255),
    (0, 82, 55, 255),
    (8, 107, 72, 255),
    (25, 132, 90, 255),
)

TRACE_COLORS = (
    (0, 0, 0, 0),
    (0, 49, 41, 255),
    (0, 82, 58, 255),
    (0, 123, 74, 255),
    (8, 173, 99, 255),
    (33, 222, 132, 255),
    (66, 247, 181, 255),
    (115, 255, 222, 255),
)


def make_grid(source: Image.Image) -> Image.Image:
    """Reduce the generated CRT plate into a quiet periodic graticule."""
    source = ImageOps.fit(source.convert("RGB"), (384, 384), method=Image.Resampling.LANCZOS)
    source = source.filter(ImageFilter.GaussianBlur(3.5)).resize(
        (SIZE, SIZE), Image.Resampling.LANCZOS
    )
    source = ImageEnhance.Brightness(source).enhance(0.34)
    source = ImageEnhance.Color(source).enhance(0.72).convert("RGBA")
    draw = ImageDraw.Draw(source)
    for coordinate in range(0, SIZE, 8):
        draw.line((coordinate, 0, coordinate, SIZE - 1), fill=(0, 83, 57, 255), width=1)
        draw.line((0, coordinate, SIZE - 1, coordinate), fill=(0, 83, 57, 255), width=1)
    draw.line((SIZE // 2, 0, SIZE // 2, SIZE - 1), fill=(9, 120, 78, 255), width=1)
    draw.line((0, SIZE // 2, SIZE - 1, SIZE // 2), fill=(9, 120, 78, 255), width=1)
    return quantize_fixed_palette(close_seams(source), GRID_COLORS)


def _waveform(kind: int) -> list[int]:
    values: list[int] = []
    for x in range(SIZE):
        phase = x / (SIZE - 1) * math.tau
        if kind == 0:
            value = math.sin(phase)
        elif kind == 1:
            value = 0.68 * math.sin(phase) + 0.28 * math.sin(phase * 3 + 0.4)
        elif kind == 2:
            value = 0.86 if math.sin(phase) >= 0 else -0.86
        elif kind == 3:
            value = 2 / math.pi * math.asin(math.sin(phase))
        elif kind == 4:
            value = 0.82 - 1.64 * ((phase / math.tau + 0.5) % 1.0)
        else:
            value = 0.62 * math.sin(phase * 2) * (0.55 + 0.45 * math.cos(phase))
        values.append(round(15.5 - value * 8.5))
    values[-1] = values[0]
    return values


def make_trace_frames() -> list[Image.Image]:
    waves = [_waveform(index) for index in range(FRAME_COUNT)]
    frames: list[Image.Image] = []
    for index in range(FRAME_COUNT):
        frame = Image.new("RGBA", (SIZE, SIZE))
        draw = ImageDraw.Draw(frame)
        # Two previous acquisitions persist as successively dimmer ghosts.
        for age, color in ((2, TRACE_COLORS[1]), (1, TRACE_COLORS[2])):
            old = waves[(index - age) % FRAME_COUNT]
            draw.line([(x, old[x]) for x in range(SIZE)], fill=color, width=1)
        current = waves[index]
        draw.line([(x, current[x]) for x in range(SIZE)], fill=TRACE_COLORS[6], width=1)
        # Sparse bright phosphor points give the current sweep a hot leading edge.
        for x in range(index % 3, SIZE, 6):
            frame.putpixel((x, current[x]), TRACE_COLORS[7])
        for y in range(SIZE):
            frame.putpixel((SIZE - 1, y), frame.getpixel((0, y)))
        frames.append(quantize_fixed_palette(frame, TRACE_COLORS))
    return frames


def parameter_frames() -> list[ParameterFrame]:
    selectors = (0, 0, 2, 2, 4, 5, 5, 1)
    frames: list[ParameterFrame] = []
    for index, selector in enumerate(selectors):
        phase = index * math.tau / len(selectors)
        cyan = 0.5 + 0.5 * math.sin(phase - 0.6)
        intensity = 0.5 + 0.5 * math.sin(phase + 0.35)
        frames.append(ParameterFrame(
            border=lerp_rgba("19a968", "31c9b7", cyan),
            accent=lerp_rgba("11895b", "22b5b5", cyan),
            highlight=lerp_rgba("31c67c", "56ddd0", cyan),
            tab_inactive=lerp_rgba("062e27", "073e42", cyan),
            tab_active=lerp_rgba("085b47", "0c7774", cyan),
            # Horizontal time-base sweep only: the trace never bobs vertically.
            layer1_dx=0.0015 + 0.0045 * (0.5 + 0.5 * math.sin(phase)),
            layer1_alpha=105 + round(108 * intensity),
            layer1_texture=selector,
        ))
    return frames


def build() -> Path:
    grid = make_grid(Image.open(SOURCE))
    traces = make_trace_frames()
    parameter_record, parameter_sheet = pack_parameter_animation(
        ParameterAnimation(
            parameter_frames(),
            Animation(180, ANIMATION_INTERPOLATE, 4),
        ),
        ROWS,
    )
    # Trace frames must start on x=0 so their Type-8 2-column derivation is
    # contiguous; the static grid is packed after the six-frame sheet.
    packed = pack_after_parameters(parameter_sheet, (*traces, grid))
    trace_rect = packed.rectangles[0]
    grid_rect = packed.rectangles[FRAME_COUNT]
    records = [
        text_record(NAME, "Oscilloscope"),
        text_record(FAMILY, "Machines"),
        colors_record(THEME_PALETTE),
        dual_texture_background(0.46, 0.46, 0.0, 0.0, 0.0040, 0.0, 0, 255, 172),
        regions_record(TextureRegions(grid_rect, trace_rect), ROWS),
        internal_border(5),
        texture_animations(
            0, Animation(),
            FRAME_COUNT, Animation(30, ANIMATION_LOOP, 2),
        ),
        parameter_record,
    ]
    write_theme(OUTPUT, records, packed.image, ROWS)
    return OUTPUT


if __name__ == "__main__":
    output = build()
    print(f"wrote {output.relative_to(ROOT)}")
