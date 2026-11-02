# Making a new theme

A theme is one PNG package in `assets/themes/`, built from source plates by a
builder in `tools/`. The format is defined in `docs/external_theme_format.md`.

## 1. Pick a family

Add an entry to the builder that fits the idea:

| Family | Builder | Plates in |
|---|---|---|
| Panorama: wide scene that pans and loops | `tools/build-panoramas.mjs` | `assets/panorama-sources/` |
| Cycling: scene animated only by CI8 palette cycling | `tools/build-cycling.mjs` | `assets/cycling-sources/` |
| Particle: scene with a moving overlay | `tools/build-particles.mjs` | `assets/particle-sources/` |
| Animated texture: repeating tiles with parameter animation | a new `tools/build_<slug>.py` using `tools/theme_writer.py` | `assets/texture-sources/` |
| Abstract: math-driven color cycling | `tools/build-abstract.mjs`, registered in `build-cycling.mjs` | none needed |

Cycling themes with their own logic get a `tools/build-<name>.mjs`, registered
in the `THEMES` list in `build-cycling.mjs`.

## 2. Generate the source art

Use the image-generation tool for scenes and textures. Don't substitute
procedural art for a plate. Only themes whose concept is mathematical, as in the
Abstract family, may skip plates. If generation fails partway through a batch,
stop and process the plates you have; don't fill the gaps with procedural art.

For a repeating texture, prefer one square plate per texture, ideally 1024×1024:

- orthographic, edge-to-edge surface or pattern;
- no UI, labels, border, frame, mockup or text;
- no horizon or perspective unless the concept needs it;
- no vignette or broad baked lighting gradient;
- motifs that stay recognizable at 64×64;
- ask for the visual idea, not fake pixel art or a fake N64 screenshot.

If the generator returns a contact sheet, crop to one clean swatch.

For a dual-texture theme, first try sampling one shared texture twice with
different scale, velocity and alpha. Generate separate plates only when the
layers carry different information, such as basalt crust and magma glow.

## 3. Store the plate

1. Save the prompt next to the plate as `<name>.prompt`.
2. Compress pictures with `python3 tools/compress_plate.py <plate>.png` and
   commit the `.jpg`. Use `--sheet` for sprite, particle and flame sheets.
3. Keep masks, depth maps, route data and animation frame sheets as PNG, because
   builders threshold or measure them.

## 4. Build and register

1. Add the file name to `sd-themes.txt`. The JavaScript builders refuse to write
   unlisted packages.
2. Run the builder, for example `node tools/build-cycling.mjs`.
3. Run `node tools/build-theme-index.mjs` to update the gallery index.

Limits and starting points:

- Keep CI8 images within 640×480 pixels (300 KB) so they fit 4 MiB consoles.
- Offsets advance by `velocity × 8 × F`, where `F = seconds × 60`, so keep motion
  subtle: background drift about `0.001–0.015` per axis, rain, snow or fast
  detail about `0.015–0.035`.
- Rotation: about `±0.0001–0.0008` radians per nominal frame.
- Shared dual layers: commonly `2×` scale ratio and alpha `60–112`.

For tile conversion and seam metrics, see `docs/texture-pipeline.md`.
`quality.pass` is a gate, not the whole review. A 64×64 texture will visibly
repeat even with no seam, so inspect a 3×3 repeat too.

## 5. Check it

1. Look at the preview the builder writes under `out/previews/`, or open the theme
   with `npm run editor` (`http://localhost:8080/`). Check more than one point in
   the animation.
2. Run `npm test`.
3. Commit the package, plates, prompts, `sd-themes.txt` and
   `assets/themes/index.json`. Only rebuild the themes you changed: rebuilding
   from compressed plates can slightly change existing packages.
