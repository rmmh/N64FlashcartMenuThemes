// Editor panels for hands-on tinkering: static images (layout, panorama,
// CI8 palettes and color cycling), texture inspection and auto-tiling.
import { decodePngBrowser, imageToCanvas } from '../src/browser.mjs';
import { cycledStaticPalette } from '../src/animation.mjs';
import { STATIC_RANGE_REVERSE, STATIC_RANGE_BLEND } from '../src/theme.mjs';
import { findPeriod, makeTile, tilePreview, tileQuality, quantizeForNfmt } from '../src/tile-tools.mjs';
import { cover, wrapHorizontally, quantizeIndexed, colorizeIndexImage, consoleColor } from '../src/palette-tools.mjs';
import { prepareArtworkTextures } from '../src/texture.mjs';

const $ = id => document.getElementById(id);
const hex = c => '#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
const fromHex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const RANGE_COLORS = ['#ff6b6b', '#ffd93d', '#6bcB77', '#4d96ff', '#c77dff', '#ff9f1c', '#2ec4b6', '#e71d36'];
// Memory a 4 MiB console reliably has for a static image (see docs).
const FOUR_MB_STATIC_BYTES = 640 * 480;
const HIGHLIGHT_PULSE_MS = 800;

export function initExtras({ getTheme, queueRender, setError, rebuild }) {
  let selection = null; // [start, end] palette indices, inclusive
  let busy = false;
  let hovered = null; // { index, since }: the swatch under the mouse

  async function task(label, fn) {
    if (busy) return;
    busy = true; setError(`${label}…`);
    await new Promise(r => setTimeout(r, 20));
    try { await fn(); setError(''); } catch (e) { setError(e.message); }
    busy = false; sync(); queueRender();
  }

  // ---- static image ---------------------------------------------------------
  function staticBytes(theme) {
    const im = theme.artwork?.staticBackground;
    return im ? im.width * im.height * (theme.artwork.staticPalette ? 1 : 2) : 0;
  }

  function syncStatic() {
    const theme = getTheme(), isStatic = theme.background.mode === 'static';
    $('staticSection').classList.toggle('hidden', !isStatic);
    $('paletteSection').classList.toggle('hidden', !isStatic || !theme.artwork.staticPalette);
    if (!isStatic) return;
    const im = theme.artwork.staticBackground, colors = theme.artwork.staticPalette;
    const shown = im && colors ? colorizeIndexImage(im, colors) : im;
    const c = $('staticThumb'), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (shown) {
      const tmp = document.createElement('canvas'); imageToCanvas(shown, tmp);
      const s = Math.min(c.width / shown.width, c.height / shown.height);
      ctx.drawImage(tmp, (c.width - shown.width * s) / 2, (c.height - shown.height * s) / 2, shown.width * s, shown.height * s);
    }
    const bytes = staticBytes(theme);
    $('staticInfo').textContent = im
      ? `${im.width}×${im.height} ${colors ? `CI8, ${colors.length} colors` : 'RGBA16'} · ${(bytes / 1024).toFixed(0)} KiB`
      : 'no image';
    $('staticBudget').textContent = bytes > FOUR_MB_STATIC_BYTES
      ? 'Over the 300 KiB that fits a 4 MiB console; use CI8 or a smaller image.' : '';
    $('staticOverlay').checked = !!theme.background.overlay;
    const digits = v => +Number(v ?? 0).toPrecision(6);
    $('panX').value = digits(theme.staticLayout?.panX);
    $('panY').value = digits(theme.staticLayout?.panY);
    $('paletteSection').classList.toggle('hidden', !colors);
    if (colors) syncPalette();
  }

  function setStaticImage(image, colors = null) {
    const theme = getTheme();
    theme.artwork.staticBackground = image;
    theme.artwork.staticPalette = colors;
    theme.staticPalette = colors ? { ranges: theme.staticPalette?.ranges?.filter(r => r.start + r.length <= colors.length) ?? [] } : null;
    theme.staticLayout ??= { panX: 0, panY: 0 };
    selection = null;
  }

  $('staticFile').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    task('Preparing static image', async () => {
      let image = await decodePngBrowser(file);
      const fit = $('staticFit').value;
      if (fit === 'screen') image = cover(image, 640, 480);
      else if (fit === 'panorama') {
        // Height 384 is drawn at 1.25x; width + overlap columns become a seamless loop.
        const width = Math.min(1280, Math.round(image.width * 384 / image.height) - 96);
        image = wrapHorizontally(cover(image, width + 96, 384), width, 96);
        getTheme().staticLayout = { panX: -0.2, panY: 0 };
      }
      if ($('staticCi8').checked) { const q = quantizeIndexed(image, Number($('staticColors').value)); setStaticImage(q.image, q.colors); }
      else setStaticImage(image);
    });
  });
  $('staticToCi8').addEventListener('click', () => task('Quantizing to CI8', async () => {
    const theme = getTheme(), im = theme.artwork.staticBackground;
    if (!im) throw new Error('import a static image first');
    const source = theme.artwork.staticPalette ? colorizeIndexImage(im, theme.artwork.staticPalette) : im;
    const q = quantizeIndexed(source, Number($('staticColors').value));
    setStaticImage(q.image, q.colors);
  }));
  $('staticToRgba').addEventListener('click', () => task('Expanding to RGBA16', async () => {
    const theme = getTheme(), im = theme.artwork.staticBackground;
    if (theme.artwork.staticPalette) setStaticImage(colorizeIndexImage(im, theme.artwork.staticPalette));
  }));
  $('staticOverlay').addEventListener('change', () => {
    const theme = getTheme();
    if ($('staticOverlay').checked) {
      theme.background = { mode: 'static', overlay: true, scale: 0.5, velocityX: 0.01, velocityY: -0.06, rotation: 0, alpha: 220 };
      theme.artwork.layer0 ??= theme.artwork.layer0Frames?.[0];
      theme.staticLayout ??= { panX: 0, panY: 0 };
    } else theme.background = { mode: 'static' };
    rebuild();
  });
  for (const [id, key] of [['panX', 'panX'], ['panY', 'panY']]) $(id).addEventListener('input', () => {
    const theme = getTheme(); theme.staticLayout ??= { panX: 0, panY: 0 };
    theme.staticLayout[key] = Math.max(-8, Math.min(8, Number($(id).value) || 0)); queueRender();
  });

  // ---- palette and color cycling ---------------------------------------------
  function rangeOf(index) {
    return (getTheme().staticPalette?.ranges ?? []).findIndex(r => index >= r.start && index < r.start + r.length);
  }

  function syncPalette() {
    const theme = getTheme(), colors = theme.artwork.staticPalette, grid = $('paletteGrid');
    grid.replaceChildren(...colors.map((c, i) => {
      const cell = document.createElement('button');
      cell.className = 'swatch'; cell.dataset.index = i; cell.style.background = hex(c); cell.title = `${i}: ${hex(c)}`;
      const r = rangeOf(i);
      if (r >= 0) cell.style.outline = `2px solid ${RANGE_COLORS[r % RANGE_COLORS.length]}`;
      if (selection && i >= selection[0] && i <= selection[1]) cell.classList.add('selected');
      cell.addEventListener('click', e => {
        selection = e.shiftKey && selection ? [Math.min(selection[0], i), Math.max(selection[1], i)] : [i, i];
        syncPalette();
      });
      return cell;
    }));
    $('paletteSelection').textContent = selection ? `Selected ${selection[0]}–${selection[1]}` : 'Click a color; shift-click to extend';
    $('paletteColor').disabled = !selection;
    if (selection) $('paletteColor').value = hex(colors[selection[0]]);
    const list = $('rangeList');
    list.replaceChildren(...(theme.staticPalette.ranges).map((r, n) => {
      const row = document.createElement('div'); row.className = 'range-row';
      row.innerHTML = `<span class="range-key" style="background:${RANGE_COLORS[n % RANGE_COLORS.length]}"></span>`
        + `<span>${r.start}–${r.start + r.length - 1}</span>`
        + `<label>Step <input type="number" min="1" max="65535" value="${r.stepTicks}" data-k="stepTicks"></label>`
        + `<label><input type="checkbox" data-f="${STATIC_RANGE_REVERSE}" ${r.flags & STATIC_RANGE_REVERSE ? 'checked' : ''}> Rev</label>`
        + `<label><input type="checkbox" data-f="${STATIC_RANGE_BLEND}" ${r.flags & STATIC_RANGE_BLEND ? 'checked' : ''}> Blend</label>`
        + `<button class="small" data-del>✕</button>`;
      row.querySelector('[data-k]').addEventListener('input', e => { r.stepTicks = Math.max(1, Math.round(Number(e.target.value)) || 1); queueRender(); });
      row.querySelectorAll('[data-f]').forEach(box => box.addEventListener('change', () => { r.flags ^= Number(box.dataset.f); queueRender(); }));
      row.querySelector('[data-del]').addEventListener('click', () => { theme.staticPalette.ranges.splice(n, 1); syncPalette(); queueRender(); });
      return row;
    }));
  }

  // Hovering a swatch pulses its pixels in the preview from white to black, so
  // you can see where that index is used. Time runs on while playback is paused.
  $('paletteGrid').addEventListener('pointerover', e => {
    const index = e.target.dataset.index;
    if (index === undefined || e.pointerType === 'touch') return;
    if (hovered?.index !== Number(index)) hovered = { index: Number(index), since: performance.now() };
  });
  $('paletteGrid').addEventListener('pointerleave', () => { hovered = null; });
  function paletteHighlight() {
    if (!hovered) return null;
    const phase = 2 * Math.PI * (performance.now() - hovered.since) / HIGHLIGHT_PULSE_MS;
    return { index: hovered.index, level: Math.round(31 * (1 + Math.cos(phase)) / 2) };
  }

  // Shows the swatches in cycling ranges as the menu has them at this moment.
  function animatePalette(seconds) {
    const theme = getTheme(), colors = theme?.artwork.staticPalette, ranges = theme?.staticPalette?.ranges, cells = $('paletteGrid').children;
    if (!colors || !ranges?.length || cells.length !== colors.length) return;
    const current = cycledStaticPalette(colors, theme.staticPalette, seconds);
    for (const r of ranges) for (let i = r.start; i < r.start + r.length; i++) cells[i].style.background = hex(current[i]);
  }

  $('paletteColor').addEventListener('input', () => {
    const theme = getTheme(); if (!selection) return;
    const rgb = consoleColor(fromHex($('paletteColor').value));
    for (let i = selection[0]; i <= selection[1]; i++) theme.artwork.staticPalette[i] = rgb;
    syncPalette(); queueRender();
  });
  $('paletteRamp').addEventListener('click', () => {
    // Fill the selection with a brightness wave around its first color, the
    // usual starting point for a cycling ramp.
    const theme = getTheme(); if (!selection) return;
    const base = theme.artwork.staticPalette[selection[0]], n = selection[1] - selection[0] + 1;
    for (let j = 0; j < n; j++) { const k = 1 + 0.3 * Math.cos(2 * Math.PI * j / n); theme.artwork.staticPalette[selection[0] + j] = consoleColor(base.slice(0, 3).map(v => v * k)); }
    syncPalette(); queueRender();
  });
  $('rangeAdd').addEventListener('click', () => {
    const theme = getTheme();
    if (!selection || selection[1] <= selection[0]) { setError('select at least two colors for a range'); return; }
    if ((theme.staticPalette.ranges ?? []).some(r => r.start <= selection[1] && selection[0] < r.start + r.length)) { setError('ranges cannot overlap'); return; }
    if (theme.staticPalette.ranges.length >= 16) { setError('at most 16 ranges'); return; }
    theme.staticPalette.ranges.push({ start: selection[0], length: selection[1] - selection[0] + 1, stepTicks: 8, flags: STATIC_RANGE_BLEND });
    setError(''); syncPalette(); queueRender();
  });

  // ---- texture inspector ----------------------------------------------------
  function syncTexture() {
    const theme = getTheme(), layer = theme.artwork.layer0;
    // Only modes that draw layer 0 have a texture to inspect or replace.
    const textured = theme.background.mode === 'single' || theme.background.mode === 'dual' || !!theme.background.overlay;
    $('textureSection').classList.toggle('hidden', !textured);
    if (!textured) return;
    const c = $('tileView'), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (!layer) { $('tileInfo').textContent = 'no layer 0 artwork'; return; }
    const quantized = quantizeForNfmt(layer).image, repeat = tilePreview(quantized, 3, 3);
    const tmp = document.createElement('canvas'); imageToCanvas(repeat, tmp);
    ctx.imageSmoothingEnabled = false;
    const s = Math.min(c.width / repeat.width, c.height / repeat.height);
    ctx.drawImage(tmp, 0, 0, repeat.width * s, repeat.height * s);
    const q = tileQuality(quantized), prepared = prepareArtworkTextures(theme);
    const format = prepared.tex0?.kind === 'ci4' ? 'CI4' : 'RGBA16';
    const rowBytes = format === 'CI4' ? Math.ceil(layer.width / 2) : layer.width * 2;
    const bytes = Math.ceil(rowBytes / 8) * 8 * layer.height, limit = format === 'CI4' ? 2048 : 4096;
    $('tileInfo').textContent = `${layer.width}×${layer.height} ${format} · TMEM ${bytes}/${limit} B · seam ${q.seamRms.toFixed(1)} vs interior ${q.interiorRms.toFixed(1)} ${q.pass ? '✓' : '✗ visible seam'}`;
  }

  $('tileSource').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    task('Tiling source', async () => {
      const source = await decodePngBrowser(file), size = Number($('tileSize').value);
      const alpha = $('tileAlpha').value === '' ? null : Number($('tileAlpha').value);
      let rect = null, note = 'center crop';
      if ($('tilePeriod').checked) {
        const period = findPeriod(source, { aspect: 1 });
        rect = period.rect;
        note = `period ${period.periodX.toFixed(1)}×${period.periodY.toFixed(1)}, ${period.periods[0]}×${period.periods[1]} repeats`;
      }
      const tile = makeTile(source, { width: size, height: size, alphaLuma: alpha, sourceRect: rect, stretch: !!rect });
      const theme = getTheme();
      theme.artwork.layer0 = tile.image; theme.artwork.layer0Frames = [tile.image];
      if (theme.background.mode === 'dual' && $('sharedLayer').checked) theme.artwork.layer1 = tile.image;
      $('tileNote').textContent = note;
      rebuild();
    });
  });

  // Per-theme editing state is dropped when another theme is loaded.
  let syncedTheme = null;
  function sync() {
    const theme = getTheme();
    if (!theme) return;
    if (theme !== syncedTheme) {
      syncedTheme = theme; selection = null;
      $('tileNote').textContent = '';
    }
    syncStatic(); syncTexture();
  }
  return { sync, animatePalette, paletteHighlight };
}
