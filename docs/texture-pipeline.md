# NFMT low-resolution texture pipeline

This pipeline is for producing texture-backed N64 menu themes from AI-generated or hand-authored source art. The important constraint is not whether the source image claims to be seamless; it is whether the **actual RGBA5551/CI4 result sampled with wrap** has an unobtrusive boundary.

## Source generation profile

Generate substantially above the final texture size. The preferred input is a 1024x1024 source plate; a concept board is also usable if each clean texture swatch is at least about 128x128 pixels.

Source-art constraints:

- orthographic, edge-to-edge material or pattern;
- no frame, text, menu UI, perspective horizon, central hero object, or vignette;
- no large global directional lighting gradient;
- major motifs should remain roughly 4-16 texels across after the final 32px or 64px downsample;
- avoid extremely fine linework that disappears in RGBA5551 or a 16-color CI4 palette;
- for dual themes, generate the base and glow/caustic/detail field as separate swatches when possible.

The converter deliberately does not trust the edges of source art.

## Conversion

`nfmt tile` performs:

1. center crop to the target aspect ratio;
2. Lanczos3 downsample to the target power-of-two size;
3. periodic-plus-smooth FFT decomposition to remove the low-frequency component caused by opposite-edge disagreement;
4. optional luminance-to-alpha conversion for RGBA5551 detail masks;
5. the format's real RGBA5551 conversion;
6. CI4 palette construction and nearest-color mapping when the dimensions require CI4;
7. quality measurement before and after periodicization on decoded, post-quantization textures;
8. optional 3x3 repeat preview.

For the first batch, dual-layer themes use two 32x32 RGBA16 textures. Each occupies 2048 bytes, exactly filling the 4096-byte dual-RGBA16 allowance. Single-layer themes use 64x64 CI4.

## Tiling quality

The checker reports:

- `seamRms`: RMS RGB difference of left/right and top/bottom wrap neighbors;
- `seamMax`: worst wrap-neighbor RGB difference;
- `interiorRms`: RMS difference between ordinary adjacent texels;
- `seamRatio`: seam RMS divided by interior RMS;
- `gradientJumpRms`: change in first derivative as sampling crosses the wrap boundary.

The pass rule is intentionally relative to local texture contrast as well as absolute error. This allows a high-contrast stone texture to have a larger numerical edge delta than a smooth sky while still rejecting a boundary that is conspicuous relative to its ordinary detail.

Always inspect the generated 3x3 repeat preview in addition to the numeric result. The automated metrics catch edge discontinuity; the preview catches overly obvious repetition, mirrored-looking motifs, or low-frequency structures that technically wrap but still look synthetic.
