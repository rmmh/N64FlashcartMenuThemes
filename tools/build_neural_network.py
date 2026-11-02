#!/usr/bin/env python3
"""Build the animated Neural Network theme."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from theme_writer import (
    Animation,
    FAMILY,
    NAME,
    ParameterAnimation,
    ParameterFrame,
    Rectangle,
    TextureRegions,
    colors_record,
    dual_texture_background,
    internal_border,
    pack_parameter_animation,
    palette,
    regions_record,
    text_record,
    texture_animations,
    write_theme,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "texture-sources" / "neural-network-raw.jpg"
OUTPUT = ROOT / "assets" / "themes" / "neural-network.png"
METADATA_ROWS = 2
FRAME_COUNT = 8
FRAME_COLUMNS = 2

THEME_COLORS = palette(
    "020617", ("07142e", 224), "38d9ef", "e9fdff",
    "89a9bd", "55e6f2", "9b6cff", "0d2948",
    "143f60", ("00020a", 190), "60efc4", "f5be62",
    "030b20", "091b3a", "150d38", "281153",
)

PULSE_COLORS = (
    (65, 230, 247, 255),
    (90, 247, 222, 255),
    (146, 255, 222, 255),
    (181, 156, 255, 255),
    (206, 107, 255, 255),
    (156, 107, 255, 255),
    (82, 173, 255, 255),
    (65, 230, 247, 255),
)


def periodic_tile(source: Image.Image) -> Image.Image:
    """Mirror-fold a generated crop into an exact 32x32 repeat."""
    rgb = source.convert("RGB")
    side = min(rgb.width, rgb.height) // 4
    left = (rgb.width - side) // 2
    top = (rgb.height - side) // 2
    crop = rgb.crop((left, top, left + side, top + side))
    cell = crop.resize((16, 16), Image.Resampling.LANCZOS)
    tile = Image.new("RGB", (32, 32))
    tile.paste(cell, (0, 0))
    tile.paste(ImageOps.mirror(cell), (16, 0))
    tile.paste(ImageOps.flip(cell), (0, 16))
    tile.paste(ImageOps.flip(ImageOps.mirror(cell)), (16, 16))
    return tile


def make_layers(source: Image.Image) -> tuple[Image.Image, list[Image.Image]]:
    tile = periodic_tile(source)
    # Keep the network dark enough for menu text while retaining blue/violet
    # structure. RGBA16 conversion happens in the launcher/toolchain.
    base_rgb = ImageEnhance.Contrast(tile.filter(ImageFilter.GaussianBlur(0.35))).enhance(1.08)
    base = Image.new("RGBA", tile.size)
    source_px, base_px = base_rgb.load(), base.load()
    energies: list[int] = []
    for y in range(32):
        for x in range(32):
            r, g, b = source_px[x, y]
            energy = (r + 2 * g + 2 * b) // 5
            energies.append(energy)
            # Compress highlights so layer 0 reads as a stable dim network.
            scale = 0.44 if energy > 116 else 0.58
            base_px[x, y] = (
                round(r * scale), round(g * scale), round(b * scale), 255
            )

    threshold = sorted(energies)[round(len(energies) * 0.67)]
    frames: list[Image.Image] = []
    for frame_index, pulse_color in enumerate(PULSE_COLORS):
        frame = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        pixels = frame.load()
        for y in range(32):
            for x in range(32):
                r, g, b = source_px[x, y]
                energy = (r + 2 * g + 2 * b) // 5
                # Phase advances across the existing generated filaments. A
                # two-pixel head/tail makes pulses move rather than flicker.
                phase = (x + 2 * y - frame_index * 3) % 16
                if energy >= threshold and phase in (0, 1, 2):
                    strength = (1.0, 0.68, 0.38)[phase]
                    pixels[x, y] = tuple(round(c * strength) for c in pulse_color[:3]) + (255,)
        frames.append(frame)
    return base, frames


def parameter_frames() -> list[ParameterFrame]:
    return [
        ParameterFrame(
            accent=color,
            highlight=PULSE_COLORS[(index + 2) % FRAME_COUNT],
            tab_active=PULSE_COLORS[(index + 1) % FRAME_COUNT],
            layer1_alpha=150 + (index % 4) * 18,
            layer1_texture=index,
        )
        for index, color in enumerate(PULSE_COLORS)
    ]


def build() -> Path:
    layer0, pulse_frames = make_layers(Image.open(SOURCE))
    parameter_record, parameter_sheet = pack_parameter_animation(
        ParameterAnimation(parameter_frames(), Animation(12, 8, 4)),
        METADATA_ROWS,
    )

    layer0_y = parameter_sheet.height
    layer1_y = layer0_y + 32
    artwork = Image.new("RGBA", (64, layer1_y + 4 * 32), (0, 0, 0, 0))
    artwork.alpha_composite(parameter_sheet, (0, 0))
    artwork.alpha_composite(layer0, (0, layer0_y))
    for index, frame in enumerate(pulse_frames):
        artwork.alpha_composite(frame, ((index % FRAME_COLUMNS) * 32,
                                        layer1_y + (index // FRAME_COLUMNS) * 32))

    regions = TextureRegions(
        Rectangle(0, layer0_y, 32, 32),
        Rectangle(0, layer1_y, 32, 32),
    )
    records = [
        text_record(NAME, "Neural Network"),
        text_record(FAMILY, "Machines"),
        colors_record(THEME_COLORS),
        dual_texture_background(0.56, 0.56, 0.002, 0.0, 0.002, 0.0,
                                0.0, 255, 150),
        regions_record(regions, METADATA_ROWS),
        internal_border(6),
        texture_animations(1, Animation(), FRAME_COUNT,
                           Animation(12, 0, FRAME_COLUMNS)),
        parameter_record,
    ]
    write_theme(OUTPUT, records, artwork, METADATA_ROWS)
    return OUTPUT


if __name__ == "__main__":
    print(f"wrote {build().relative_to(ROOT)}")
