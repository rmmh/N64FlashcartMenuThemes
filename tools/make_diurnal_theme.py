#!/usr/bin/env python3
"""Build the four-phase Diurnal parameter-animation theme variants."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from theme_writer import (Animation, FAMILY, NAME, ParameterAnimation,
                          ParameterFrame, colors_record, gradient_background,
                          internal_border, pack_parameter_animation, palette,
                          text_record, write_theme)


WIDTH = 64
ROWS = 1


PHASES = (
    # Dawn: cool predawn shadows opening into peach and gold.
    palette(
        "17162e", ("392f4d", 220), "d79a7a", "fff3dd",
        "c5aec2", "ffbd72", "b75f68", "342b4d",
        "7e5261", "0b0a18", "83d8a1", "ffd36a",
        "30244d", "df7180", "f5a36f", "ffd58b",
    ),
    # Sunset: hot horizon, wine shadows, and fading amber light.
    palette(
        "2a1029", ("52223a", 220), "f29a66", "fff0dc",
        "d4a6ad", "ff784f", "a83b57", "4a1d3d",
        "9b3d4d", "110714", "7bd29a", "ffd05d",
        "3c1649", "c73568", "f16854", "ffbd62",
    ),
    # Aurora: green and cyan ribbons over a deep polar night.
    palette(
        "04152b", ("102e43", 220), "71f4d1", "ecfffb",
        "9bc9c8", "78ffd0", "176f7d", "0b3045",
        "176b69", "010812", "76f2a8", "ffd465",
        "06172f", "155182", "2fbb9f", "a2ffca",
    ),
    # Twilight: indigo and violet settle back toward dawn.
    palette(
        "11112d", ("28254b", 220), "a69be8", "f3efff",
        "aaa5c7", "be8cff", "514c8b", "252146",
        "5d477f", "070716", "7ad6a0", "ffd064",
        "17173f", "444387", "765dba", "bd91e8",
    ),
)


SPEEDS = (0.020, 0.014, 0.026, 0.012)
WARPS = (0.12, 0.16, 0.24, 0.10)


def parameter_frame(colors, gradient_speed: float, gradient_warp: float) -> ParameterFrame:
    return ParameterFrame(*colors, gradient_speed=gradient_speed,
                          gradient_warp=gradient_warp)


def build_theme(name: str, output: Path, frame_ticks: int) -> None:
    records = [
        text_record(NAME, name),
        text_record(FAMILY, "Simple"),
        colors_record(PHASES[0]),
        gradient_background(0.020, 0.12),
        internal_border(8),  # Soft.
    ]
    frames = [parameter_frame(PHASES[phase], SPEEDS[phase], WARPS[phase])
              for phase in range(4)]
    parameter_record, sheet = pack_parameter_animation(
        ParameterAnimation(frames, Animation(frame_ticks, 8, 3)), ROWS)
    records.append(parameter_record)
    write_theme(output, records, sheet, ROWS)
    print(f"wrote {output} ({WIDTH}x{ROWS + sheet.height})")


def main() -> None:
    build_theme("Diurnal", Path("assets/themes/diurnal.png"), 900)


if __name__ == "__main__":
    main()
