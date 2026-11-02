# N64 menu theme PNG format, version 1

A theme is one non-interlaced PNG. Repeating and animated texture packages are
64 pixels wide. Static-image packages may be 64–640 pixels wide. Metadata occupies the first 1–4 rows; any
remaining pixels are artwork. PNG color type is unrestricted, but decoding to
RGBA8 must reproduce metadata RGB exactly and metadata alpha must be 255.
Static artwork may contain up to 480 rows below the metadata; compact packages
may be up to 287 pixels high. Multi-byte integers and IEEE-754 floats are little
endian.

## Header

Read metadata bytes left-to-right as R, G, B, continuing on the next row.

| Offset | Size | Meaning |
|---:|---:|---|
| 0 | 4 | ASCII `N64T` |
| 4 | 1 | Version, exactly `1` |
| 5 | 1 | Metadata row count, 1–4 and no greater than image height |
| 6 | 2 | Header size, including this 16-byte prefix |
| 8 | 4 | Reserved feature flags, zero in version 1 |
| 12 | 4 | Standard IEEE/zlib CRC-32 of bytes 16 through `header_size-1` |

`header_size` must be 16 through `rows × 64 × 3`. Bytes after it in the
metadata rows are ignored and canonical writers fill them with zero.

The body is TLV: one-byte type, unsigned 16-bit length, then value. It must end
with type 0 encoded as `00 00 00`. Unknown types are skipped. Known types may
occur at most once and malformed known records invalidate the file.

| Type | Required | Value |
|---:|---|---|
| 1 | Yes | Theme name: 1–63 bytes intended as UTF-8, no NUL |
| 2 | Yes | Picker family: same encoding and limits as name |
| 3 | Yes | Sixteen RGBA8888 colors (64 bytes) |
| 4 | No | Non-solid background definition |
| 5 | For textures or embedded borders | Three artwork rectangles (12 bytes) |
| 6 | For embedded borders only | Three tab-geometry bytes |
| 7 | Unless type 5 embeds a border | One-byte internal border ID |
| 8 | No | Two fixed-size texture-animation records (10 bytes) |
| 9 | No | Masked animated-parameter region and playback record (13 bytes) |

Family matching is case-insensitive. Recognized families are the legacy
`Simple`, `Hardware`, `Nature`, `Texture`, and `Extra` names plus `Water`,
`Space`, `Life`, `Materials`, `Ornament`, `Machines`, `Electronics`, `Retro`,
`Abstract`, `Fantasy`, `Panorama`, and `Particle`. `Custom` is reserved for the built-in editor; it
and unknown names appear under `External`. Theme-name
collision checks are also case-insensitive. When
a bundled and storage-backed theme have the same name, the storage-backed
theme wins.

The theme name `Custom` is reserved case-insensitively; packages using it are
invalid so they cannot replace the built-in editable theme.

Names and families are intended as UTF-8, but encoding is not validated;
malformed sequences have unspecified display. Displayable characters are
limited to the glyphs in `assets/fonts/charset.txt` (ASCII, extended Latin,
Japanese kana, and the listed kanji); others may display as the missing glyph.

Install external packages as `/menu/themes/*.png` on the active storage
device. Bundled packages use the same `themes/` directory in the ROM
filesystem. Files with other extensions and invalid packages are ignored.
If a previously discovered package cannot be decoded when selected, its
background falls back to color 0 for that session.

## Colors: type 3

Each entry is four bytes R, G, B, A:

| # | Name | Use |
|---:|---|---|
| 0 | Background | Solid clear color; texture compositing fallback |
| 1 | Panel | Dialog/menu panel fill |
| 2 | Border | Border tint |
| 3 | Text | Primary text |
| 4 | Muted text | Secondary/disabled text |
| 5 | Accent | Focus and selected-border accent |
| 6 | Highlight | Selected-row fill |
| 7 | Inactive tab | Unselected tab fill |
| 8 | Active tab | Selected tab fill |
| 9 | Shadow | Text/panel shadow |
| 10 | Success | Positive status |
| 11 | Warning | Warning/error emphasis |
| 12–15 | Gradient TL, TR, BL, BR | Gradient corner colors |

All sixteen entries are present in every theme. Interface alpha is honored by
the relevant UI drawing operation; gradient alpha is not used.

## Background: type 4

Omission means solid using color 0. Otherwise length and byte-0 mode must
match exactly; floats follow the mode byte:

| Length | Mode | Remaining payload |
|---:|---:|---|
| 9 | 3, gradient | speed, warp |
| 18 | 2, one texture | scale, X velocity, Y velocity, rotation, alpha byte |
| 31 | 1, two layers | scales 0/1, X/Y velocities 0/1, rotation, alpha 0/1 |
| 1 | 5, static image | No remaining payload |

Accepted finite ranges are: scale 1/64–16, velocity -4–4, rotation
-0.25–0.25 radians per nominal frame, gradient speed 0–2 cycles/second, and
warp 0–1. Alpha is 0–255.

Mode 5 uses every pixel below the metadata rows as one non-repeating background
image. Its artwork must be no larger than 640×480. It is scaled to the 640×480
menu output. Type 5 and type 8 are not used for this mode.

## Artwork regions: type 5

The value is three four-byte rectangles `(x, y, width, height)`, in order:
layer 0, layer 1, embedded border. Coordinates include metadata rows and are
unsigned bytes. A zero rectangle means absent. A present rectangle must fit
inside the PNG. Texture rectangles are at most 64×64; an embedded border is
exactly 24×24. Single-texture mode requires layer 0; dual mode requires both.
Equal layer rectangles mean one stored texture sampled twice.

Artwork may be arranged anywhere meeting those rules. Canonical files stack
64-pixel-wide texture regions below metadata. Metadata pixels must not be part
of an artwork rectangle.

Texture width and height must each be a power of two (1, 2, 4, 8, 16, 32, or
64). The RDP can upload NPOT rectangles, but its wrap masks have power-of-two
periods; this launcher infinitely repeats both axes, so NPOT regions are not
valid backgrounds.

Texture format is inferred from each rectangle: width and height both at most
32 means RGBA16 (RGBA5551); every other size means CI4. This permits these
combinations:

- one CI4 texture of any valid larger size, or one RGBA16 texture up to 32×32;
- two CI4 textures, shared or distinct, with a combined TMEM footprint no
  larger than 2048 bytes;
- two RGBA16 textures, shared or distinct, with a combined TMEM footprint no
  larger than 4096 bytes.

Mixed CI4/RGBA16 dual backgrounds are invalid. A CI palette reserves the
upper 2048 bytes of TMEM. Keeping dual backgrounds in one format avoids mixed
TLUT and direct-color texture state. For the size check, each encoded row is
rounded up to 8 bytes; a shared rectangle is counted once.

## Texture animation: type 8

Type 8 is exactly ten bytes: one five-byte record for layer 0 followed by one
for layer 1. Each record is `(frame_count, columns, frame_ticks_u16le, flags)`.
Omitting type 8 makes both layers static. A record with `frame_count` 0 or 1
is also static and must have its other three bytes zero. For a single-texture
background, the unused layer-1 record must be all zero.

For an animated record, `frame_count` is 2–255, `columns` and `frame_ticks`
are nonzero, and every frame has the width and height of that layer's type-5
rectangle. With the type-5 rectangle `(x0,y0,w,h)`, zero-based frame `i` is:

`(x0 + (i mod columns) × w, y0 + floor(i / columns) × h, w, h)`.

Every derived rectangle must fit the PNG, avoid the metadata rows, and meet
the same size, format, repeat, and TMEM rules as its base rectangle. The final
row need not contain `columns` frames. Two dual-mode layers share decoded
storage and one TMEM upload only when both their type-5 rectangles and their
five-byte animation records are identical.

Flag bits 0–1 select playback: 0 loop, 1 ping-pong, 2 play once, and 3 is
invalid. Bit 2 starts playback reversed. Bit 3 enables CPU interpolation to
the next logical playback frame and is valid only for RGBA16 textures. Bits
4–7 must be zero. Duration is uniform: each frame lasts `frame_ticks` nominal
60 Hz ticks. Layer clocks are independent. Readers that do not implement type
8 safely skip it and display the type-5 base rectangle as frame zero.

## Parameter animation: type 9

Type 9 is exactly thirteen bytes: a little-endian 32-bit channel mask, a
four-byte artwork rectangle, and one five-byte animation record in the type-8
format. Mask bits 0–28 correspond to the channels below; bits 29–31 must be
zero and at least one channel must be present. Its `frame_count` is at least
one. Sheets use the same `columns` layout, playback modes, reversal, duration,
and interpolation flag as texture animation. Every derived rectangle must fit
below the metadata rows. Readers without type-9 support safely skip it and
retain the static type-3 and type-4 values.

Each frame packs only its masked channels, in ascending bit order, with no
alignment between channels. Colors and floats occupy four bytes; alpha and
texture selectors occupy one. Payload bytes occupy RGB channels only and every
pixel alpha must be 255, preventing transparent-pixel optimization from
discarding data. The rectangle width is `ceil(packed_bytes / 3)`, its height
is exactly one, and unused RGB bytes in its last pixel must be zero. Omitted
channels inherit the static type-3 or type-4 value; omitted texture selectors
inherit 255. Thus four animated float channels contain exactly 16 payload
bytes in a 6×1 rectangle, with two zero padding bytes.

| Mask bit | Size | Animated value |
|---:|---:|---|
| 0–15 | 4 each | Sixteen RGBA8888 colors in type-3 order |
| 16 | 4 | Gradient speed, float |
| 17 | 4 | Gradient warp, float |
| 18 | 4 | Layer-0 scale, float |
| 19 | 4 | Layer-1 scale, float |
| 20 | 4 | Layer-0 X velocity, float |
| 21 | 4 | Layer-0 Y velocity, float |
| 22 | 4 | Layer-1 X velocity, float |
| 23 | 4 | Layer-1 Y velocity, float |
| 24 | 4 | Shared rotation speed, float |
| 25 | 1 | Layer-0 alpha |
| 26 | 1 | Layer-1 alpha |
| 27 | 1 | Layer-0 texture-frame selector |
| 28 | 1 | Layer-1 texture-frame selector |

Floats use the type-4 encoding and ranges. A texture selector is either 255,
meaning the layer follows its normal type-8 clock, or an index smaller than
that layer's available texture-frame count. A non-textured or unused layer
therefore uses selector 0 or 255.

Without the interpolation flag, all values step at keyframe boundaries. With
it, colors, alpha, velocities, rotation speed, gradient speed, and warp are
linearly interpolated. Scale is interpolated in log space, so reciprocal zoom
ratios have symmetric timing. Texture selectors are discrete and switch to the
next keyframe's selector halfway through the transition. Parameter-selected
texture frames are not CPU-blended. Playback flags themselves and background
mode are not animatable.

Velocity and rotation values are rates: the renderer integrates the resolved
rate over elapsed time, preserving continuous motion as it changes. Animated
scale compensates UV translation so the pattern remains anchored at screen
center while zooming.

## Borders: types 6 and 7

Exactly one border source is required:

- Embedded: type 5 contains a 24×24 border and type 6 supplies
  `tab_overlap`, `tab_join_depth`, `selected_expansion` as unsigned pixels.
- Internal: type 7 supplies an ID and type 6 and the border rectangle are
  absent.

The 24×24 embedded image is a 3×3 grid of 8×8 nine-patch cells. Corners are
drawn once; edges repeat in 8-pixel steps; the center supplies panel fill
masking. Point filtering is used. Type-6 values are accepted over their full
byte range; editors should normally keep them within 0–8.

| ID | Border | Canonical artwork |
|---:|---|---|
| 0 | Plain | `assets/images/theme-border-plain.png` |
| 1 | Double | `assets/images/theme-border-double.png` |
| 2 | Facets | `assets/images/theme-border-facets.png` |
| 3 | Beads | `assets/images/theme-border-beads.png` |
| 4 | Brackets | `assets/images/theme-border-brackets.png` |
| 5 | Stitches | `assets/images/theme-border-stitches.png` |
| 6 | Nodes | `assets/images/theme-border-nodes.png` |
| 7 | Scallops | `assets/images/theme-border-scallops.png` |
| 8 | Soft | `assets/images/theme-border-soft.png` |

Internal geometry is `(overlap, join, expansion) = (2,3,1)`, except Brackets
uses `(2,3,4)`.

`assets/themes/*.png` are canonical packages. A bundled build merely copies
them to generated `filesystem/themes/`; edit or distribute the former.
`assets/themes/diurnal.png` is the canonical type-9 palette/parameter example;
its four 900-tick keys form a 60-second Dawn → Sunset → Aurora → Twilight loop
and are generated by `tools/make_diurnal_theme.py`.
`tools/theme_writer.py` is the public Python API for generating themes. It
provides named palettes, backgrounds, atlas rectangles, and animation models;
validated record helpers; automatic Type-9 channel masks and parameter-sheet
encoding; metadata CRC validation; and 64-pixel-wide texture/artwork packing.
Generators do not need to construct TLVs or call `struct.pack`. The writer
places parameter data in the first artwork rows immediately after the metadata
header, then packs visible textures and borders below it. Run its tests with
`python3 -m unittest tools/test_theme_writer.py`.
`assets/themes/sakura.png` uses sixteen cyclic type-9 keys to vary the lateral
and downward speed of two texture layers over 20 seconds, producing staggered
wind-like petal drift; it is generated by `tools/make_sakura_theme.py`.

## Precise rendering definition

These rules reproduce the launcher's 640×480 preview.

### Texture conversion

Decode artwork as RGBA8, then convert each pixel to RGBA5551:

`((R>>3)<<11) | ((G>>3)<<6) | ((B>>3)<<1) | (A>=128)`.

A texture with both dimensions no larger than 32 stores those RGBA5551 values
directly. Otherwise, build one CI4 palette jointly from every frame of all
active texture layers and a separate palette for an embedded border. Count at
most the first 4096 distinct RGBA5551 values, sort by descending frequency
then ascending RGBA5551 value, and take 16 (or all if fewer). If either
alpha class occurs but is absent from the selected palette, replace its last
entry with that class's most frequent color. Map pixels to the palette entry
of matching alpha with minimum squared RGB555 distance; ties choose the first.
Internal borders use the repository's prebuilt CI4 versions of the listed
artwork. Embedded borders are always CI4. Textures use bilinear filtering and
infinite repeat; borders use point filtering.

### Texture motion and composition

Let `F = elapsed_seconds × 60`.

For an animation record, let `S = floor(F / frame_ticks)`. Loop selects
`S mod N`. Ping-pong has period `2N-2`: let `q = S mod (2N-2)` and select `q`
when `q < N`, otherwise `2N-2-q`. Play-once selects `min(S,N-1)`. If reverse
is set, replace the result with `N-1-result`; a reversed play-once therefore
ends on frame zero. Animation changes the source image only: UV motion and
rotation continue without resetting. Converted frames are cached in RAM, but
only the current frame pair is uploaded to TMEM for a draw.

With interpolation enabled, let `t = (F mod frame_ticks) / frame_ticks` for
the current playback step. The CPU linearly interpolates the current and next
logical frame's 5-bit R, G, and B components with round-to-nearest. The 1-bit
alpha result is opaque when `(1-t)×A0 + t×A1 >= 0.5`. “Next” follows the
selected mode and direction, including last→first for loop, reversal at each
ping-pong endpoint, and the terminal frame itself for play-once. The blended
RGBA16 scratch surface, rather than either source frame, is uploaded. Each
slot owns one persistent scratch surface; equal shared slots reuse one.

Each layer's texture moves by `velocity × 8 × F` texels, wrapping modulo that
layer's width or height; positive velocities move it right and down on screen.
Rotation advances by
`rotation × F` radians around screen center. Layer-0 coordinates before
rotation are `(screen_x × scale0, screen_y × scale0)`.

For dual mode, layer-1 scale is hardware-quantized relative to layer 0. Let
`q` be the nearest integer to `log2(scale1/scale0)`, using √2 boundaries and
clamped to -5…10; effective layer-1 frequency is `scale0 × 2^q`. Its offsets
remain independent. Equal region rectangles with equal animation records
reuse the same converted frame sequence.

Single mode emits `(texture0.rgb, texture0.a × alpha0/255)`. Dual mode computes
`base = mix(background, texture0, alpha0/255)`, then
`output = mix(base, texture1, texture1_alpha × alpha1/255)`. The result is
opaque. Sampling uses RGBA5551 directly or through CI4, so source alpha is
binary after conversion.

### Gradient

Maintain phase `p`, initially zero:

`p = (p + speed × elapsed_seconds × 2π) mod 2π`.

Create a 3×3 mesh with X positions
`[0, 640×(0.5 + sin(0.71p)×warp×0.18), 640]` and Y positions
`[0, 480×(0.5 + cos(0.89p)×warp×0.18), 480]`. For mesh UV `(u,v)` in
`{0,0.5,1}²`, sample:

`su = clamp(u + sin(p + 4.1v)×warp)`

`sv = clamp(v + cos(0.83p + 3.7u)×warp)`.

Bilinearly interpolate the four gradient RGB colors at `(su,sv)`, assign that
color to the mesh vertex, and render its eight triangles with Gouraud shading
to RGBA16 using Bayer RGB dithering and no alpha.

### UI preview

The visible area is `(32,24)` through `(608,456)`. Plain-border tabs are 28
pixels high; other border styles extend 2 pixels upward. Inactive tab labels
use the muted text color, while the selected label uses the normal text color. The
selected tab is lifted 5 pixels. Type-6 overlap is split left=floor(n/2),
right=ceil(n/2); join depth extends the tab bottom; expansion adds to both
selected-tab sides where a neighbor exists. Panels use color 1 and the border
nine-patch tinted by color 2; selected borders use color 5. The canonical menu
font is `assets/fonts/Firple-Bold.ttf`, rendered at 15 pixels with a one-pixel
outline. These constants are sufficient for a representative standalone theme
preview; individual launcher views determine their own panel and text layout.
