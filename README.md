# NFMT theme tools

Dependency-free JavaScript tooling for **N64 menu theme PNG format v1**:

- strict packer/unpacker and validator;
- Node PNG decoder supporting standard PNG color types, bit depths, filters and Adam7;
- canonical RGBA8 PNG writer;
- 640×480 software renderer for solid, animated gradient, one-texture and dual-texture backgrounds;
- CI4/RGBA5551 texture conversion and dual-layer scale quantization;
- exact built-in 24×24 border artwork for all nine internal border IDs plus embedded nine-patch support;
- CLI (`inspect`, `unpack`, `pack`, `render`);
- browser editor with import/export, palette/background/border controls, artwork replacement and animated preview.

The format specification is in `docs/external_theme_format.md`. Theme packages are in `assets/themes/`.

## Quick start

Requires Node 20+ and no npm dependencies.

```sh
npm test
npm run editor
```

Then open `http://localhost:8080/`.

The editor is hosted at <https://rmmh.github.io/N64FlashcartMenuThemes/>. Pushes to `master` deploy it
through `.github/workflows/pages.yml`.

CLI examples:

```sh
node cli/nfmt.mjs inspect assets/themes/water.png
node cli/nfmt.mjs unpack assets/themes/sakura.png out/sakura
node cli/nfmt.mjs pack out/sakura/theme.json out/sakura-repacked.png
node cli/nfmt.mjs render assets/themes/desert-sunset.png out/desert-preview.png --time 1.25
```

`unpack` writes `theme.json` plus the active artwork rectangles. `pack` canonicalizes the package: metadata first, followed by layer 0, distinct layer 1, then an embedded border.

## Renderer scope

The texture conversion, palette selection, alpha semantics, motion, dual-layer scale quantization, gradient mesh deformation and 24×24 border tiling follow the supplied format definition. The nine launcher border PNGs are stored under `assets/images/` and converted to the renderer's CI4 representation by `npm run build:borders`; the generated data is shared by Node and the browser editor. The Firple font is still not included, so the standalone preview uses a compact built-in bitmap font for menu text.

## Low-resolution seamless texture pipeline

`nfmt tile` converts arbitrary source art into an NFMT-ready low-resolution tile. It center-crops to the requested aspect ratio, downsamples with Lanczos3, removes opposite-edge discontinuities with periodic-plus-smooth decomposition, performs the same RGBA5551/CI4 conversion used by the renderer, and grades the **post-quantization** result.

```sh
node cli/nfmt.mjs tile source.png tile.png --size 64x64 \
  --preview tile-3x3.png --report tile-quality.json
```

For bright detail layers in dual-texture themes, `--alpha-luma 0.55` converts the low-resolution luminance into a binary RGBA5551 mask before grading. The command exits with status 2 if the tile fails the seam checks.

## Installing themes

Download `n64-menu-themes.zip` from the
[latest release](https://github.com/rmmh/N64FlashcartMenuThemes/releases/latest) and
extract it into the SD card root. Themes go in `menu/themes/`, where the menu finds
them. The [editor](https://rmmh.github.io/N64FlashcartMenuThemes/) can also download
one theme as a PNG, or the themes its gallery is showing as a ZIP.

`npm run build:release` writes the same ZIP to `out/release/`. Pushing a `v*` tag
publishes it as a GitHub release.

## Making a theme

`AGENTS.md` describes how to add a theme, from source art to registering the package.

## Static layouts, panoramas, color cycling and particles

Format types 11 and 12 and the 18-byte static background (see
`docs/external_theme_format.md`) add three things to static images:

- **Layout and pan (type 11):** the image may be up to 2048×1024 and is
  cover-scaled to the screen; a nonzero pan scrolls and wraps that axis.
- **Indexed palette and color cycling (type 12):** the image stores gray
  palette indices (CI8, up to 1280×480) and up to 16 palette ranges rotate,
  optionally blended. Keep CI8 images within 640×480 pixels (300 KB) for 4 MiB
  consoles.
- **Overlay (mode 5, 18 bytes):** layer 0 is drawn over the image with the
  single-texture motion fields: snow, rain, embers and other particles.

Positive texture velocities move content right and down, as on the console.

These packages are too large to bundle in the menu ROM. They are listed in
`sd-themes.txt` and installed on the SD card as `/menu/themes/<file>`; the
builders only write files listed there.

Builders, all from image-generated sources with prompts kept alongside. They
need `djpeg` (libjpeg or mozjpeg), and the Python builders need Pillow and NumPy.
Pictures are stored as mozjpeg (`tools/compress_plate.py`); plates that builders
threshold or measure stay PNG. Rebuilt themes can differ slightly from the
packages in `assets/themes/`, which were built from the lossless originals.


```sh
node tools/build-showcase.mjs    # Sea of Clouds, Snowbound Shrine, Zellige Courtyard
node tools/build-cycling.mjs     # the Cycling family: scenes animated only by CI8 color cycling
node tools/build-cycling.mjs radar-sweep  # rebuild the frame-derived radar cycle
node tools/build-panoramas.mjs   # Panorama family (assets/panorama-sources/), incl. Synthwave Grid
node tools/build-particles.mjs   # Particle family (assets/particle-sources/)
python3 tools/build_<theme>.py   # Animated textures (assets/texture-sources/)
```

Radar Sweep uses a generated 4×4 animation sheet in
`assets/cycling-sources/radar-sweep-frames.png`; its imagegen prompt is saved
alongside it. The original generated console supplies the surrounding panel.
`radar-sweep-timeline.json` records the observed beam angles: it corrects the
sheet's third-row zigzag, drops the duplicate downward frame, and orders the
remaining artwork clockwise. The builder interpolates these unevenly spaced
keyframes into 192 registered reference frames, including the transition across midnight.
The stationary glass and grid use the temporal median of the source cells.
Only light within each source beam's annotated 65-degree trailing wedge is
extracted using radial medians, which reject contact halos and grid artifacts.
This generated glow profile is warped around the scope center to interpolate missing
angles. Generated mottling is recovered as a smoothed clutter map in fixed
screen coordinates, visible dimly at rest and illuminated by the passing beam.
Each contact uses one extracted sprite with a fixed shape and position. It
retains the generated core and irregular halo using stable phosphor coverage,
instead of assigning every pixel in a circle to the same ramp. Contact centers
are moved radially into the gaps between range rings, with the halo kept clear.
Each contact
flashes after the beam reaches its bearing, holds for 0.1 seconds, and fades for
1.2 seconds. A one-entry guard prevents palette blending from lighting it early.
Shifted contact copies are removed from the static plate before adding these sprites.
Phosphor gain is 2.2× and the menu panel uses lower opacity to reveal the sweep.

`tools/frame-cycling.mjs` fits each pixel's RGB history to a shared palette
trajectory. Two 96-entry ranges run the beam at 30 steps per second. Both have
the same straight, bright head and unlit leading side; spatial dithering mixes
adjacent fade values only in the trailing phosphor. Angular phase is registered
to the scope center and never spatially dithered. Range rings remain stationary.
One separate 32-entry range controls contact persistence. Its inactive entries
match the dark scope exactly, so contacts do not show through before a hit.
The remaining 32 colors preserve stationary artwork. Playback
is a blended 3.2-second type-12 cycle, requiring no new console format or
runtime animation code. This is a palette approximation of the generated
frames: missing angles use motion interpolation, and fine phosphor detail is reduced.
The builder writes 32-pose reference and compiled contact sheets plus an RGB error
report under `out/previews/cycling/radar-sweep-{reference,compiled}.png` and
`out/previews/cycling/radar-sweep-report.json`. Inspect both sheets when revising
the artwork or timing; edit the timeline if a regenerated sheet changes order.

`nfmt tile SOURCE OUT --period auto` crops exactly one repeat of a periodic
source (found by autocorrelation) before shrinking it, which keeps far more
detail than shrinking the whole plate. `src/palette-tools.mjs` has the shared
CI8 quantizer, panorama wrapping and cover cropping.

The editor (`npm run editor`) adds a static-image panel (import, cover or
seamless-panorama fit, CI8 quantization, pan), a palette grid for editing
colors and color-cycling ranges, a texture inspector (3×3 repeat, seam and
TMEM figures, period-cropped tiling from a source image), and playback
controls (pause, scrub, speed).

## License

Code and documentation are under the [MIT License](LICENSE). Original artwork is
under [CC BY 4.0](LICENSE-ART): `assets/`.

Exceptions:

- `web/preview-font.ttf` is an ASCII subset of Firple Bold, renamed as the license
  requires, under the [SIL Open Font License 1.1](web/preview-font-LICENSE.txt).
- `assets/cycling-sources/circuit-pulse-board.jpg` comes from a public-domain
  photo by Evan-Amos; see `circuit-pulse-board.txt` next to it.
