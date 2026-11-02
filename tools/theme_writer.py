"""Reusable writer for N64FlashcartMenu V1 theme PNG packages."""

from __future__ import annotations

import math
import struct
import zlib
from collections import namedtuple
from pathlib import Path
from typing import Iterable

from PIL import Image


WIDTH = 64
# Regions retain byte-sized origins.  A 32px texture can therefore start as
# late as row 255 and extend through row 286.
MAX_HEIGHT = 287
MAX_STATIC_WIDTH = 640
MAX_STATIC_HEIGHT = 480
NAME = 1
FAMILY = 2
COLORS = 3
BACKGROUND = 4
REGIONS = 5
TAB_GEOMETRY = 6
INTERNAL_BORDER = 7
TEXTURE_ANIMATION = 8
PARAMETER_ANIMATION = 9
TEXTURE_ORIGIN = 10

# Animation flag bits shared by Type 8 texture animation and Type 9 parameter
# animation. Combining PING_PONG | INTERPOLATE is valid; LOOP and PING_PONG
# are mutually exclusive playback modes.
ANIMATION_LOOP = 0
ANIMATION_PING_PONG = 1 << 0
ANIMATION_ONCE = 1 << 1
ANIMATION_REVERSED = 1 << 2
ANIMATION_INTERPOLATE = 1 << 3

# Rotation is expressed in radians per 60 Hz tick. Large fullscreen repeating
# fields can cause discomfort well below the format's technical ±0.25 limit,
# so authored themes use this conservative ceiling unless a future validator
# grants an explicit, reviewed exception.
COMFORTABLE_ROTATION_LIMIT = 0.001

COLOR_NAMES = (
    "background panel border text muted_text accent highlight tab_inactive "
    "tab_active shadow success warning gradient_tl gradient_tr gradient_bl gradient_br"
).split()
Palette = namedtuple("Palette", COLOR_NAMES)
ParameterFrame = namedtuple("ParameterFrame", (
    "background panel border text muted_text accent highlight tab_inactive "
    "tab_active shadow success warning gradient_tl gradient_tr gradient_bl gradient_br "
    "gradient_speed gradient_warp layer0_scale layer1_scale layer0_dx layer0_dy "
    "layer1_dx layer1_dy rotation layer0_alpha layer1_alpha layer0_texture layer1_texture"
), defaults=(None,) * 29)
Rectangle = namedtuple("Rectangle", "x y width height", defaults=(0, 0, 0, 0))
Animation = namedtuple("Animation", "frame_ticks flags columns", defaults=(0, 0, 1))
ParameterAnimation = namedtuple("ParameterAnimation", "frames animation")
PackedArtwork = namedtuple("PackedArtwork", "image rectangles")
TextureRegions = namedtuple("TextureRegions", "layer0 layer1 border",
                            defaults=(Rectangle(), Rectangle(), Rectangle()))
DualTextureBackground = namedtuple("DualTextureBackground", (
    "layer0_scale layer1_scale layer0_dx layer0_dy layer1_dx layer1_dy "
    "rotation layer0_alpha layer1_alpha"))


def _uint(value: int, bits: int, label: str) -> int:
    value = int(value)
    if not 0 <= value < 1 << bits:
        raise ValueError(f"{label} must be 0..{(1 << bits) - 1}")
    return value


def _finite(value: float, label: str) -> float:
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"{label} must be finite")
    return value


def rgba(hex_rgb: str, alpha: int = 255) -> tuple[int, int, int, int]:
    """Create an RGBA tuple from a six-digit hexadecimal RGB string."""
    if len(hex_rgb) != 6:
        raise ValueError("RGB colors must contain exactly six hexadecimal digits")
    try:
        rgb = bytes.fromhex(hex_rgb)
    except ValueError as error:
        raise ValueError("RGB colors must contain hexadecimal digits") from error
    return (*rgb, _uint(alpha, 8, "alpha"))


def lerp_rgba(left, right, amount: float, alpha: int | None = None
              ) -> tuple[int, int, int, int]:
    """Interpolate two RGBA tuples or hex RGB strings with clamped rounding."""
    if isinstance(left, str):
        left = rgba(left)
    if isinstance(right, str):
        right = rgba(right)
    if len(left) != 4 or len(right) != 4:
        raise ValueError("interpolated colors must be RGBA tuples or hex RGB strings")
    amount = _finite(amount, "color interpolation amount")
    if not 0 <= amount <= 1:
        raise ValueError("color interpolation amount must be 0..1")
    result = tuple(round(a + (b - a) * amount) for a, b in zip(left, right))
    if alpha is not None:
        result = (*result[:3], _uint(alpha, 8, "alpha"))
    return result


def close_seams(image: Image.Image) -> Image.Image:
    """Return an RGBA image whose opposite edge pixels match exactly."""
    output = image.convert("RGBA")
    if output.width < 2 or output.height < 2:
        raise ValueError("seam closure needs an image at least 2x2 pixels")
    pixels = output.load()
    for y in range(output.height):
        value = tuple((pixels[0, y][channel] + pixels[output.width - 1, y][channel]) // 2
                      for channel in range(4))
        pixels[0, y] = pixels[output.width - 1, y] = value
    for x in range(output.width):
        value = tuple((pixels[x, 0][channel] + pixels[x, output.height - 1][channel]) // 2
                      for channel in range(4))
        pixels[x, 0] = pixels[x, output.height - 1] = value
    return output


def quantize_fixed_palette(image: Image.Image, colors: Iterable[tuple[int, int, int, int]],
                           *, alpha_threshold: int = 128) -> Image.Image:
    """Map pixels to an explicit <=16-color RGBA palette deterministically."""
    choices = tuple(tuple(_uint(channel, 8, "palette channel") for channel in color)
                    for color in colors)
    if not 1 <= len(choices) <= 16 or any(len(color) != 4 for color in choices):
        raise ValueError("fixed palettes must contain 1..16 RGBA colors")
    threshold = _uint(alpha_threshold, 8, "alpha threshold")
    transparent = [color for color in choices if color[3] < threshold]
    opaque = [color for color in choices if color[3] >= threshold]
    if not opaque:
        raise ValueError("fixed palettes need at least one opaque color")
    source = image.convert("RGBA")
    output = Image.new("RGBA", source.size)
    mapped = []
    for pixel in source.get_flattened_data():
        candidates = transparent if pixel[3] < threshold and transparent else opaque
        mapped.append(min(candidates, key=lambda color: sum(
            (pixel[channel] - color[channel]) ** 2 for channel in range(4))))
    output.putdata(mapped)
    return output


def palette(*colors) -> Palette:
    """Build the required sixteen-color palette from RGBA tuples or hex strings."""
    if len(colors) != len(COLOR_NAMES):
        raise ValueError("a theme palette must contain sixteen colors")
    normalized = []
    for color in colors:
        if isinstance(color, str):
            color = rgba(color)
        elif len(color) == 2 and isinstance(color[0], str):
            color = rgba(*color)
        if len(color) != 4:
            raise ValueError("palette colors must be RGBA tuples")
        normalized.append(tuple(_uint(channel, 8, "color channel") for channel in color))
    return Palette(*normalized)


def colors_record(colors: Palette) -> tuple[int, bytes]:
    """Encode a sixteen-color theme palette."""
    return COLORS, b"".join(bytes(color) for color in colors)


def decode_palette(value: bytes) -> Palette:
    """Decode a type-3 value into a named palette."""
    if len(value) != 64:
        raise ValueError("a theme palette must contain exactly 64 bytes")
    return Palette(*(tuple(value[offset:offset + 4]) for offset in range(0, 64, 4)))


def text_record(kind: int, value: str) -> tuple[int, bytes]:
    """Encode a theme name or family."""
    if kind not in (NAME, FAMILY):
        raise ValueError("text records are only valid for name and family")
    encoded = value.encode("ascii")
    if not 1 <= len(encoded) <= 63 or b"\0" in encoded:
        raise ValueError("theme text must be 1..63 non-NUL ASCII bytes")
    return kind, encoded


def gradient_background(speed: float, warp: float) -> tuple[int, bytes]:
    """Encode a moving four-corner gradient background."""
    speed, warp = _finite(speed, "gradient speed"), _finite(warp, "gradient warp")
    if not 0 <= speed <= 2 or not 0 <= warp <= 1:
        raise ValueError("gradient speed must be 0..2 and warp must be 0..1")
    return BACKGROUND, bytes((3,)) + struct.pack("<2f", speed, warp)


def static_image_background() -> tuple[int, bytes]:
    """Use the complete artwork image as a non-repeating static background."""
    return BACKGROUND, bytes((5,))


def dual_texture_background(layer0_scale: float, layer1_scale: float,
                            layer0_dx: float, layer0_dy: float,
                            layer1_dx: float, layer1_dy: float,
                            rotation: float = 0, layer0_alpha: int = 255,
                            layer1_alpha: int = 255) -> tuple[int, bytes]:
    """Encode a dual-layer UV background without exposing binary packing."""
    values = tuple(_finite(value, "texture parameter") for value in (
        layer0_scale, layer1_scale, layer0_dx, layer0_dy,
        layer1_dx, layer1_dy, rotation))
    if not all(0.015625 <= scale <= 16 for scale in values[:2]):
        raise ValueError("texture scales must be 0.015625..16")
    if not all(-4 <= velocity <= 4 for velocity in values[2:6]):
        raise ValueError("texture velocities must be -4..4")
    if not -0.25 <= values[6] <= 0.25:
        raise ValueError("texture rotation must be -0.25..0.25")
    return (BACKGROUND, bytes((1,)) + struct.pack("<7f", *values)
            + bytes((_uint(layer0_alpha, 8, "layer 0 alpha"),
                     _uint(layer1_alpha, 8, "layer 1 alpha"))))


def decode_dual_texture_background(value: bytes) -> DualTextureBackground:
    """Decode a type-4 dual-texture background value."""
    if len(value) != 31 or value[0] != 1:
        raise ValueError("expected a dual-texture background record")
    return DualTextureBackground(*struct.unpack_from("<7f", value, 1), value[29], value[30])


def texture_origin(u: float = 0, v: float = 0) -> tuple[int, bytes]:
    """Encode a static UV origin shared by both texture layers."""
    u, v = _finite(u, "texture origin"), _finite(v, "texture origin")
    if not -64 <= u <= 64 or not -64 <= v <= 64:
        raise ValueError("texture origins must be -64..64")
    return TEXTURE_ORIGIN, struct.pack("<2f", u, v)


def internal_border(style: int) -> tuple[int, bytes]:
    """Select one of the built-in border styles."""
    return INTERNAL_BORDER, bytes((_uint(style, 8, "border style"),))


def texture_animations(layer0_frames: int, layer0: Animation,
                       layer1_frames: int = 0,
                       layer1: Animation = Animation()) -> tuple[int, bytes]:
    """Encode animation descriptors for the two texture layers."""
    return (TEXTURE_ANIMATION,
            _pack_animation_for_frames(layer0, layer0_frames)
            + _pack_animation_for_frames(layer1, layer1_frames))


def regions_record(regions: TextureRegions, y_offset: int = 0) -> tuple[int, bytes]:
    """Encode atlas rectangles, applying the final PNG artwork-row offset."""
    packed = bytearray()
    for rectangle in regions:
        values = (rectangle.x, rectangle.y + y_offset if rectangle.height else 0,
                  rectangle.width, rectangle.height)
        packed.extend(_uint(value, 8, "region coordinate") for value in values)
    return REGIONS, bytes(packed)


def tlv(kind: int, value: bytes) -> bytes:
    return bytes((_uint(kind, 8, "record type"),)) + struct.pack(
        "<H", _uint(len(value), 16, "record length")) + value


def _pack_animation_for_frames(animation: Animation, frame_count: int) -> bytes:
    frame_count = _uint(frame_count, 8, "frame count")
    if frame_count == 0:
        return b"\0" * 5
    columns = _uint(animation.columns, 8, "animation columns")
    frame_ticks = _uint(animation.frame_ticks, 16, "animation frame ticks")
    flags = _uint(animation.flags, 8, "animation flags")
    if flags & 0xF0 or flags & 0x03 == 0x03:
        raise ValueError("animation flags contain an unsupported playback mode")
    if frame_count == 1:
        if columns not in (0, 1) or frame_ticks or flags:
            raise ValueError("single-frame animations cannot have playback settings")
        return b"\1\0\0\0\0"
    if not columns or not frame_ticks:
        raise ValueError("multi-frame animations need columns and nonzero frame ticks")
    return struct.pack("<BBHB", frame_count, columns, frame_ticks, flags)


def read_metadata(image: Image.Image) -> tuple[int, list[tuple[int, bytes]]]:
    """Read and validate the metadata records in a theme PNG."""
    rgba = image.convert("RGBA")
    if not WIDTH <= rgba.width <= MAX_STATIC_WIDTH or rgba.height < 1:
        raise ValueError("theme PNGs must be 64..640 pixels wide")
    first = bytes(c for x in range(WIDTH) for c in rgba.getpixel((x, 0))[:3])
    if first[:5] != b"N64T\1":
        raise ValueError("not a V1 N64FlashcartMenu theme")
    rows = first[5]
    if not 1 <= rows <= 4 or rows > rgba.height:
        raise ValueError("invalid metadata row count")
    if any(rgba.getpixel((x, y))[3] != 255
           for y in range(rows) for x in range(WIDTH)):
        raise ValueError("metadata pixels must be opaque")
    header = bytes(c for y in range(rows) for x in range(WIDTH)
                   for c in rgba.getpixel((x, y))[:3])
    size = struct.unpack_from("<H", header, 6)[0]
    if not 19 <= size <= len(header) or struct.unpack_from("<I", header, 8)[0]:
        raise ValueError("invalid metadata header")
    body = header[16:size]
    if zlib.crc32(body) != struct.unpack_from("<I", header, 12)[0]:
        raise ValueError("theme metadata CRC mismatch")
    records = []
    offset = 16
    terminated = False
    while offset < size:
        if offset + 3 > size:
            raise ValueError("truncated theme record")
        kind = header[offset]
        length = struct.unpack_from("<H", header, offset + 1)[0]
        offset += 3
        if kind == 0:
            if length or offset != size:
                raise ValueError("invalid theme terminator")
            terminated = True
            break
        if offset + length > size:
            raise ValueError("truncated theme record value")
        records.append((kind, header[offset:offset + length]))
        offset += length
    if not terminated:
        raise ValueError("theme metadata is missing its terminator")
    return rows, records


def record_value(records: Iterable[tuple[int, bytes]], kind: int) -> bytes:
    """Return one required record value with a useful error if it is absent."""
    matches = [value for record_kind, value in records if record_kind == kind]
    if len(matches) != 1:
        raise ValueError(f"expected exactly one type-{kind} record")
    return matches[0]


def replace_record(records: Iterable[tuple[int, bytes]], record: tuple[int, bytes]
                   ) -> list[tuple[int, bytes]]:
    """Replace one record while preserving package record order."""
    kind, _ = record
    replaced = False
    result = []
    for old in records:
        if old[0] == kind:
            if replaced:
                raise ValueError(f"duplicate type-{kind} records")
            result.append(record)
            replaced = True
        else:
            result.append(old)
    if not replaced:
        result.append(record)
    return result


def decode_regions(value: bytes) -> TextureRegions:
    """Decode a type-5 record into named atlas rectangles."""
    if len(value) != 12:
        raise ValueError("texture region records must contain twelve bytes")
    rectangles = [Rectangle(*value[offset:offset + 4]) for offset in range(0, 12, 4)]
    return TextureRegions(*rectangles)


def pack_artwork(images: Iterable[Image.Image], start_y: int = 0) -> PackedArtwork:
    """Shelf-pack images into a 64-pixel-wide transparent RGBA atlas."""
    sources = [image.convert("RGBA") for image in images]
    positions = []
    x, y, row_height = 0, start_y, 0
    for image in sources:
        if image.width > WIDTH or image.height > 255:
            raise ValueError("artwork exceeds theme PNG limits")
        if x and x + image.width > WIDTH:
            x, y, row_height = 0, y + row_height, 0
        positions.append(Rectangle(x, y, image.width, image.height))
        x += image.width
        row_height = max(row_height, image.height)
    height = y + row_height
    if height >= MAX_HEIGHT:
        raise ValueError(f"packed artwork exceeds {MAX_HEIGHT - 1} rows")
    atlas = Image.new("RGBA", (WIDTH, max(height, start_y)), (0, 0, 0, 0))
    for image, rectangle in zip(sources, positions):
        atlas.alpha_composite(image, (rectangle.x, rectangle.y))
    return PackedArtwork(atlas, tuple(positions))


def pack_after_parameters(parameter_sheet: Image.Image,
                          images: Iterable[Image.Image]) -> PackedArtwork:
    """Put parameter bytes first, then shelf-pack visible artwork below them."""
    packed = pack_artwork(images, parameter_sheet.height)
    packed.image.alpha_composite(parameter_sheet.convert("RGBA"), (0, 0))
    return packed


def _channel_bytes(channel: int, value) -> bytes:
    if channel < 16:
        packed = bytes(value)
        if len(packed) != 4:
            raise ValueError("animated colors must be RGBA tuples")
        return packed
    if channel < 25:
        value = float(value)
        if not math.isfinite(value):
            raise ValueError("animated floats must be finite")
        return struct.pack("<f", value)
    value = int(value)
    if not 0 <= value <= 255:
        raise ValueError("animated byte channels must be 0..255")
    return bytes((value,))


def pack_parameter_animation(spec: ParameterAnimation,
                             metadata_rows: int = 1
                             ) -> tuple[tuple[int, bytes], Image.Image]:
    """Encode a sparse animation and its opaque RGB parameter sheet."""
    frames = tuple(spec.frames)
    if not frames:
        raise ValueError("parameter animation needs at least one frame")
    _uint(len(frames), 8, "parameter frame count")
    _uint(metadata_rows, 8, "metadata rows")
    present = [set(i for i, value in enumerate(frame) if value is not None) for frame in frames]
    if any(channels != present[0] for channels in present[1:]):
        raise ValueError("every parameter frame must specify the same channels")
    channels = sorted(present[0])
    if not channels:
        raise ValueError("parameter animation mask cannot be empty")
    mask = sum(1 << channel for channel in channels)
    payloads = [b"".join(_channel_bytes(channel, frame[channel]) for channel in channels)
                for frame in frames]
    frame_width = (len(payloads[0]) + 2) // 3
    requested_columns = _uint(spec.animation.columns, 8, "animation columns")
    columns = min(requested_columns, WIDTH // frame_width, len(frames))
    if columns <= 0:
        raise ValueError("parameter frames do not fit the theme width")
    rows = (len(frames) + columns - 1) // columns
    sheet = Image.new("RGBA", (WIDTH, rows), (0, 0, 0, 0))
    pixels = sheet.load()
    for index, payload in enumerate(payloads):
        padded = payload.ljust(frame_width * 3, b"\0")
        origin_x = index % columns * frame_width
        origin_y = index // columns
        for x in range(frame_width):
            pixels[origin_x + x, origin_y] = (*padded[x * 3:x * 3 + 3], 255)
    animation = _pack_animation_for_frames(spec.animation._replace(columns=columns), len(frames))
    record = struct.pack("<I", mask) + bytes((0, metadata_rows, frame_width, 1)) + animation
    return (PARAMETER_ANIMATION, record), sheet


def write_theme(output: Path, records: Iterable[tuple[int, bytes]], artwork: Image.Image,
                metadata_rows: int = 1) -> None:
    records = tuple(records)
    metadata_rows = _uint(metadata_rows, 8, "metadata rows")
    if not 1 <= metadata_rows <= 4:
        raise ValueError("metadata rows must be 1..4")
    body = b"".join(tlv(kind, value) for kind, value in records) + b"\0\0\0"
    header = b"N64T" + bytes((1, metadata_rows))
    header += struct.pack("<HII", 16 + len(body), 0, zlib.crc32(body)) + body
    capacity = metadata_rows * WIDTH * 3
    if len(header) > capacity:
        raise ValueError("theme metadata exceeds its declared rows")
    header = header.ljust(capacity, b"\0")
    rgba = artwork.convert("RGBA")
    static = any(kind == BACKGROUND and value == bytes((5,)) for kind, value in records)
    max_width = MAX_STATIC_WIDTH if static else WIDTH
    max_height = MAX_STATIC_HEIGHT if static else MAX_HEIGHT - metadata_rows
    if rgba.width < WIDTH or rgba.width > max_width or (not static and rgba.width != WIDTH):
        raise ValueError(f"theme artwork width must be {WIDTH}" + (f"..{max_width}" if static else ""))
    if rgba.height < 1 or rgba.height > max_height:
        raise ValueError(f"theme artwork height must be 1..{max_height}")
    canvas = Image.new("RGBA", (rgba.width, metadata_rows + rgba.height), (0, 0, 0, 0))
    canvas.alpha_composite(rgba, (0, metadata_rows))
    pixels = canvas.load()
    for y in range(metadata_rows):
        for x in range(WIDTH):
            offset = (y * WIDTH + x) * 3
            pixels[x, y] = (*header[offset:offset + 3], 255)
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, optimize=True)
