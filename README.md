# N64 Flashcart Menu Themes

Animated background themes for
[N64FlashcartMenu](https://github.com/Polprzewodnikowy/N64FlashcartMenu), an
open-source menu that runs on a Nintendo 64 flashcart. Each theme is a single
PNG image that is placed on the SD card. This repo holds the themes, a web
editor for browsing and changing them, and the tools that build them.

- **[Open the web editor](https://rmmh.github.io/N64FlashcartMenuThemes/)**: preview
  the themes in your browser, change them, or make your own.
- **[Download the latest release](https://github.com/rmmh/N64FlashcartMenuThemes/releases/latest)**:
  every theme in one ZIP.

## Install themes

1. Download `n64-menu-themes.zip` from the
   [latest release](https://github.com/rmmh/N64FlashcartMenuThemes/releases/latest).
2. Extract it to the root of your SD card. The themes go in `menu/themes/`.
3. On the console, open **Settings → Theme**, choose a family, then choose a theme.

To install only some themes, open the
[web editor](https://rmmh.github.io/N64FlashcartMenuThemes/) and download one theme
as a PNG, or the themes its gallery is showing as a ZIP.

## Use the web editor

The [web editor](https://rmmh.github.io/N64FlashcartMenuThemes/) has a gallery of
every theme and an animated preview. You can edit palettes, backgrounds, borders,
artwork and color cycling, then export the result as a theme PNG.

Nothing needs installing. To run a local copy, see
[Develop](#develop).

## Make a theme

[`AGENTS.md`](AGENTS.md) describes how to add a theme to this repo, from source art
to registering the package. The file format is defined in
[`docs/external_theme_format.md`](docs/external_theme_format.md).

## Develop

The tools need Node 20 or newer and have no npm dependencies.

```sh
npm test
npm run editor  # serves the editor at http://localhost:8080/
```

### Command-line tool

```sh
node cli/nfmt.mjs inspect assets/themes/water.png
node cli/nfmt.mjs unpack assets/themes/sakura.png out/sakura
node cli/nfmt.mjs pack out/sakura/theme.json out/sakura-repacked.png
node cli/nfmt.mjs render assets/themes/desert-sunset.png out/desert-preview.png --time 1.25
node cli/nfmt.mjs tile source.png tile.png --size 64x64 --preview tile-3x3.png
```

`tile` turns source art into a seamless low-resolution tile; see
[`docs/texture-pipeline.md`](docs/texture-pipeline.md).

### Rebuild themes

The finished themes are checked in at `assets/themes/`, so you only need the builders
to change one. They also need `djpeg` (from libjpeg or mozjpeg), and the Python
builders need Pillow and NumPy.

```sh
node tools/build-showcase.mjs    # Sea of Clouds, Snowbound Shrine, Zellige Courtyard
node tools/build-cycling.mjs     # Cycling family
node tools/build-panoramas.mjs   # Panorama family
node tools/build-particles.mjs   # Particle family
python3 tools/build_<theme>.py   # Animated textures
```

A rebuilt theme can differ slightly from the checked-in one, because the source plates
are now stored as JPEG and the packages were built from lossless originals.

### Publish

| Action | Result |
|---|---|
| Push to `master` | `.github/workflows/pages.yml` deploys the web editor. |
| Push a `v*` tag | `.github/workflows/release.yml` publishes the release ZIP. |

`npm run build:release` writes the same ZIP to `out/release/`.

## License

Code and documentation are under the [MIT License](LICENSE). Original artwork in
`assets/` is under [CC BY 4.0](LICENSE-ART).

Exceptions:

- `web/preview-font.ttf` is an ASCII subset of Firple Bold, renamed as the license
  requires, under the [SIL Open Font License 1.1](web/preview-font-LICENSE.txt).
- `assets/cycling-sources/circuit-pulse-board.jpg` comes from a public-domain
  photo by Evan-Amos; see `circuit-pulse-board.txt` next to it.
