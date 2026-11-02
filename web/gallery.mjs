// Gallery of every package in assets/themes/: background thumbnails drawn by
// the same WebGL renderer as the editor preview, animated while active or
// focused (or centered on touch screens), and loaded into the editor on click.
import { decodePngBrowser, parseThemeImage } from '../src/browser.mjs';
import { FAMILIES } from '../src/utils.mjs';
import { WebGLThemeRenderer } from './webgl-renderer.mjs';

const $ = id => document.getElementById(id);
const THUMB_W = 240, THUMB_H = 180;
// Theme types: one background kind per theme, plus any number of features.
const TYPE_GROUPS = [
  ['Background', [['bg:solid', 'Solid color'], ['bg:gradient', 'Gradient'], ['bg:single', 'Single texture'],
    ['bg:dual', 'Dual texture'], ['bg:static', 'Static RGBA16'], ['bg:ci8', 'Static CI8']]],
  ['Feature', [['frames', 'Texture frames'], ['keyframes', 'Keyframe animation'], ['cycling', 'Color cycling'],
    ['pan', 'Panning'], ['overlay', 'Overlay layer'], ['border', 'Embedded border']]],
];

function typeTags(theme) {
  const bg = theme.background, tags = new Set();
  tags.add(bg.mode !== 'static' ? `bg:${bg.mode}` : theme.artwork.staticPalette ? 'bg:ci8' : 'bg:static');
  const animations = theme.textureAnimations;
  if (animations && Object.values(animations).some(a => a.frameCount > 1)) tags.add('frames');
  if (theme.parameterAnimation) tags.add('keyframes');
  if (theme.staticPalette?.ranges.length) tags.add('cycling');
  if (theme.staticLayout?.panX || theme.staticLayout?.panY) tags.add('pan');
  if (bg.overlay) tags.add('overlay');
  if (theme.border.source === 'embedded') tags.add('border');
  return tags;
}

export function initGallery({ onSelect, setError, onFilter, onShown }) {
  const stage = document.createElement('canvas');
  stage.width = 640; stage.height = 480;
  const host = document.createElement('div');
  host.className = 'gallery-stage';
  host.append(stage);
  document.body.append(host);
  const renderer = new WebGLThemeRenderer(stage);

  const entries = [];       // { file, card, canvas, label, meta, theme, state }
  let family = 'All', type = 'all', query = '', active = null, animationStart = 0, loaded = false;

  const touchGallery=matchMedia('(hover: none), (pointer: coarse)');
  let centerDirty=true;
  function activate(entry){
    if(active===entry)return;
    if(active){delete active.card.dataset.animating;draw(active,0);}
    active=entry;animationStart=performance.now();
    if(active)active.card.dataset.animating='true';
  }
  function chooseCentral(){
    const headerBottom=document.querySelector('header').getBoundingClientRect().bottom;
    const top=Math.max(0,Math.min(innerHeight,headerBottom)),center=[innerWidth/2,(top+innerHeight)/2];
    let closest=null,best=Infinity;
    for(const entry of entries){
      if(!entry.theme||entry.card.hidden)continue;
      const rect=entry.canvas.getBoundingClientRect();
      if(rect.bottom<=top||rect.top>=innerHeight||rect.right<=0||rect.left>=innerWidth||!rect.width)continue;
      const distance=Math.hypot(rect.left+rect.width/2-center[0],rect.top+rect.height/2-center[1]);
      if(distance<best){best=distance;closest=entry;}
    }
    activate(closest);centerDirty=false;
  }
  const moved=()=>{centerDirty=true;};
  addEventListener('scroll',moved,{passive:true});addEventListener('resize',moved);
  touchGallery.addEventListener('change',()=>{activate(null);centerDirty=true;});
  new ResizeObserver(moved).observe($('galleryGrid'));

  function draw(entry, seconds) {
    if (!entry.theme) return;
    renderer.render(entry.theme, seconds, true);
    const ctx = entry.canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(stage, 0, 0, THUMB_W, THUMB_H);
  }

  async function load(entry) {
    if (entry.state) return;
    entry.state = 'loading';
    try {
      const response = await fetch(`../assets/themes/${entry.file}`);
      if (!response.ok) throw new Error(`${response.status}`);
      entry.theme = parseThemeImage(await decodePngBrowser(await response.blob()));
      entry.state = 'ready';
      entry.label.textContent = entry.theme.name;
      entry.meta.textContent = describe(entry.theme);
      entry.card.dataset.family = entry.theme.displayFamily;
      entry.tags = typeTags(entry.theme);
      updateFamilies();
      updateTypes();
      draw(entry, 0);
    } catch (error) {
      entry.state = 'error';
      entry.meta.textContent = `invalid: ${error.message}`;
      entry.card.classList.add('broken');
    }
    applyFilter();
  }

  // The family list shows only families among decoded themes, in the format's
  // order, with counts; it fills in as packages decode. Options are updated in
  // place rather than replaced, so an open dropdown is not disturbed.
  const familyOptions = new Map();
  const familyOrder = name => { const i = FAMILIES.indexOf(name); return i < 0 ? FAMILIES.length : i; };
  function familyOption(name) {
    let option = familyOptions.get(name);
    if (option) return option;
    option = Object.assign(document.createElement('option'), { value: name });
    familyOptions.set(name, option);
    const select = $('galleryFamily');
    const next = [...select.options].find(o => o.value !== 'All'
      && (familyOrder(o.value) - familyOrder(name) || o.value.localeCompare(name)) > 0);
    select.insertBefore(option, next ?? null);
    return option;
  }
  function updateFamilies() {
    const counts = new Map();
    for (const e of entries) if (e.theme) counts.set(e.theme.displayFamily, (counts.get(e.theme.displayFamily) ?? 0) + 1);
    familyOption('All').textContent = `All (${entries.length})`;
    // A family chosen before its themes decode (e.g. from the URL) stays listed.
    if (family !== 'All' && !counts.has(family)) counts.set(family, 0);
    for (const [name, option] of familyOptions) if (name !== 'All' && !counts.has(name)) { option.remove(); familyOptions.delete(name); }
    for (const [name, count] of counts) familyOption(name).textContent = `${name} (${count})`;
    $('galleryFamily').value = family;
  }

  // Types present among decoded themes, with counts. The options are rebuilt
  // only when a type first appears; otherwise just their counts change.
  let shownTypes = '';
  function updateTypes() {
    const counts = new Map();
    for (const e of entries) for (const tag of e.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const visible = TYPE_GROUPS.map(([group, items]) => [group, items.filter(([key]) => counts.has(key) || key === type)]);
    const key = visible.map(([, items]) => items.map(([k]) => k).join()).join('|');
    const select = $('galleryType');
    if (key !== shownTypes) {
      shownTypes = key;
      select.replaceChildren(Object.assign(document.createElement('option'), { value: 'all' }),
        ...visible.filter(([, items]) => items.length).map(([group, items]) => {
          const optgroup = Object.assign(document.createElement('optgroup'), { label: group });
          optgroup.append(...items.map(([value]) => Object.assign(document.createElement('option'), { value })));
          return optgroup;
        }));
    }
    const labels = new Map(TYPE_GROUPS.flatMap(([, items]) => items));
    for (const option of select.options)
      option.textContent = option.value === 'all' ? `All types (${entries.length})` : `${labels.get(option.value)} (${counts.get(option.value) ?? 0})`;
    select.value = type;
  }

  function describe(theme) {
    const bg = theme.background, parts = [theme.displayFamily];
    if (bg.mode === 'static') {
      const im = theme.artwork.staticBackground;
      parts.push(theme.artwork.staticPalette ? `CI8 ${im.width}×${im.height}` : `static ${im.width}×${im.height}`);
      if (theme.staticLayout?.panX || theme.staticLayout?.panY) parts.push('pans');
      if (theme.staticPalette?.ranges.length) parts.push('cycles');
      if (bg.overlay) parts.push('overlay');
    } else parts.push(bg.mode);
    return parts.join(' · ');
  }

  const visible = new IntersectionObserver(items => {
    for (const item of items) if (item.isIntersecting) load(entries.find(e => e.card === item.target));
  }, { rootMargin: '400px' });

  function applyFilter() {
    let shown = 0;
    for (const e of entries) {
      const name = (e.theme?.name ?? e.file).toLowerCase();
      // A card's family is known once its package is decoded (all decode in the background).
      e.card.hidden = !((family === 'All' || e.card.dataset.family === family)
        && (type === 'all' || !!e.tags?.has(type))
        && (!query || name.includes(query) || e.file.includes(query)));
      if (!e.card.hidden) shown++;
    }
    $('galleryCount').textContent = `${shown} of ${entries.length}`;centerDirty=true;
    if(active?.card.hidden)activate(null);
    onShown?.();
  }

  async function open() {
    centerDirty=true;
    if (loaded) return;
    loaded = true;
    try {
      // Static sites use the committed index; the dev server also lists live files.
      let response = await fetch('../assets/themes/index.json');
      if (!response.ok) response = await fetch('../themes-index.json');
      if (!response.ok) throw new Error('theme listing unavailable; run node tools/build-theme-index.mjs');
      const files = await response.json();
      updateFamilies();
      updateTypes();
      for (const file of files) {
        const card = document.createElement('button');
        card.type = 'button'; card.className = 'gallery-card';
        const canvas = Object.assign(document.createElement('canvas'), { width: THUMB_W, height: THUMB_H });
        const label = Object.assign(document.createElement('span'), { className: 'gallery-name', textContent: file.replace(/\.png$/, '') });
        const meta = Object.assign(document.createElement('span'), { className: 'gallery-meta', textContent: ' ' });
        card.append(canvas, label, meta);
        const entry = { file, card, canvas, label, meta, theme: null, state: null };
        const start = () => { if (entry.theme&&!touchGallery.matches)activate(entry); };
        const stop = () => { if (active===entry&&!touchGallery.matches)activate(null); };
        card.addEventListener('pointerenter', start); card.addEventListener('focus', start);
        card.addEventListener('pointerleave', stop); card.addEventListener('blur', stop);
        card.addEventListener('click', () => { if (entry.theme) onSelect(entry.theme, file); });
        entries.push(entry);
        visible.observe(card);
      }
      $('galleryGrid').replaceChildren(...entries.map(e => e.card));
      applyFilter();
      // Decode everything in the background so filters and search see every
      // theme; cards scrolled into view jump the queue through the observer.
      const queue = [...entries];
      await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await load(queue.shift()); }));
    } catch (error) {
      setError(error.message);
    }
  }

  function animate(now) {
    // One shared WebGL context animates only the hovered or central card.
    if($('galleryView').hidden){if(active)activate(null);centerDirty=true;}
    else{
      if(touchGallery.matches&&centerDirty)chooseCentral();
      if(active)draw(active,(now-animationStart)/1000);
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // Filters set from the URL before the options exist are applied once open() fills them.
  function setFilters(filters) {
    family = filters.family; type = filters.type;
    $('gallerySearch').value = filters.query;
    query = filters.query.trim().toLowerCase();
    updateFamilies();
    updateTypes();
    if (entries.length) applyFilter();
  }
  const filters = () => ({ family, type, query: $('gallerySearch').value });

  $('galleryFamily').addEventListener('change', () => { family = $('galleryFamily').value; applyFilter(); onFilter?.(); });
  $('galleryType').addEventListener('change', () => { type = $('galleryType').value; applyFilter(); onFilter?.(); });
  $('gallerySearch').addEventListener('input', () => { query = $('gallerySearch').value.trim().toLowerCase(); applyFilter(); onFilter?.(); });
  const shownFiles = () => entries.filter(e => !e.card.hidden).map(e => e.file);
  const totalFiles = () => entries.length;
  return { open, setFilters, filters, shownFiles, totalFiles };
}
