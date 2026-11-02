import {
  parseThemeImage, packThemeImage, themeToSerializable,
  decodePngBrowser, encodePngBrowser, imageToCanvas, COLOR_NAMES, BORDER_NAMES, INTERNAL_BORDER_GEOMETRY
} from '../src/browser.mjs';
import { FAMILIES, normalizeFamily } from '../src/utils.mjs';
import { WebGLThemeRenderer } from './webgl-renderer.mjs';
import { initExtras } from './editor-extras.mjs';
import { initGallery } from './gallery.mjs';
import { initPreviewViewport } from './preview-viewport.mjs';
import { allThemeFiles, saveBlob, zipThemes } from './theme-downloads.mjs';
import { THEME_ZIP_NAME } from '../src/zip.mjs';

const $ = id => document.getElementById(id);
let theme = null;
let renderQueued = false;
let lastTick = performance.now();
let animTime = 0;
let previewRenderer;
let playing = true, speed = 1;
const extras = initExtras({ getTheme: () => theme, queueRender: () => queueRender(), setError: s => setError(s), rebuild: () => syncUi() });

$('familyPick').replaceChildren(...['',...FAMILIES].map(name=>Object.assign(document.createElement('option'),{value:name,textContent:name,hidden:!name})));
function syncFamilyPick(){const family=$('family').value.toLowerCase();$('familyPick').value=FAMILIES.find(name=>name.toLowerCase()===family)??'';}

function hex(c){ return '#' + c.slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join(''); }
function fromHex(h){ return [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)]; }
// Packages store float32, so show at most six significant digits.
const shown=v=>Number.isInteger(v)?v:+Number(v).toPrecision(6);
function numberField(label,key,value,min,max,step='0.01') { return `<label>${label}<input data-bg="${key}" type="number" value="${shown(value)}" min="${min}" max="${max}" step="${step}"></label>`; }
function blankTexture(size=64){const data=new Uint8ClampedArray(size*size*4);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=(y*size+x)*4,v=((x>>3)^(y>>3))&1?170:65;data[i]=v;data[i+1]=v;data[i+2]=v;data[i+3]=255;}return {width:size,height:size,data};}
function blankBorder(){const im={width:24,height:24,data:new Uint8ClampedArray(24*24*4)};for(let i=0;i<im.data.length;i+=4){im.data[i+3]=0;}for(let y=0;y<24;y++)for(let x=0;x<24;x++){if(x<2||x>21||y<2||y>21){const i=(y*24+x)*4;im.data[i]=255;im.data[i+1]=255;im.data[i+2]=255;im.data[i+3]=255;}}return im;}

async function loadUrl(url){ try { setError(''); const r=await fetch(url); if(!r.ok)throw new Error(`${r.status} ${r.statusText}`); await loadBlob(await r.blob()); } catch(e){setError(e.message);} }
async function loadBlob(blob){const image=await decodePngBrowser(blob);theme=parseThemeImage(image);syncUi();queueRender();}

function setError(s){$('errors').textContent=s||'';}
function syncUi(){ if(!theme)return; $('name').value=theme.name;$('family').value=theme.family;syncFamilyPick();$('bgMode').value=theme.background.mode;$('borderSource').value=theme.border.source;$('sharedLayer').checked=theme.artwork.layer1===theme.artwork.layer0 && !!theme.artwork.layer0; buildBgFields();buildBorderFields();buildColors();updateArtwork();updateJson();extras.sync(); }

function buildBgFields(){const bg=theme.background,el=$('bgFields');let h='';if(bg.mode==='gradient')h=numberField('Speed','speed',bg.speed,0,2)+numberField('Warp','warp',bg.warp,0,1);else if(bg.mode==='single'||bg.overlay)h=numberField('Scale','scale',bg.scale,1/64,16)+`<div class="row">${numberField('Velocity X','velocityX',bg.velocityX,-4,4)}${numberField('Velocity Y','velocityY',bg.velocityY,-4,4)}</div>`+numberField('Rotation','rotation',bg.rotation,-0.25,0.25,'0.001')+numberField('Alpha','alpha',bg.alpha,0,255,'1');else if(bg.mode==='dual')h=numberField('Scale 0','scale0',bg.scale0,1/64,16)+numberField('Scale 1','scale1',bg.scale1,1/64,16)+`<div class="row">${numberField('Vel X 0','velocityX0',bg.velocityX0,-4,4)}${numberField('Vel Y 0','velocityY0',bg.velocityY0,-4,4)}</div><div class="row">${numberField('Vel X 1','velocityX1',bg.velocityX1,-4,4)}${numberField('Vel Y 1','velocityY1',bg.velocityY1,-4,4)}</div>`+numberField('Rotation','rotation',bg.rotation,-0.25,0.25,'0.001')+`<div class="row">${numberField('Alpha 0','alpha0',bg.alpha0,0,255,'1')}${numberField('Alpha 1','alpha1',bg.alpha1,0,255,'1')}</div>`;el.innerHTML=h;el.querySelectorAll('[data-bg]').forEach(inp=>inp.addEventListener('input',()=>{const k=inp.dataset.bg;theme.background[k]=['alpha','alpha0','alpha1'].includes(k)?Math.round(Number(inp.value)):Number(inp.value);queueRender();}));syncArtworkRows();extras.sync();}
// Show only the artwork the background mode and border actually use.
function syncArtworkRows(){const bg=theme.background,layer0=bg.mode==='single'||bg.mode==='dual'||!!bg.overlay,layer1=bg.mode==='dual',border=theme.border.source==='embedded';$('layer0Row').classList.toggle('hidden',!layer0);$('layer1Row').classList.toggle('hidden',!layer1);$('borderArtRow').classList.toggle('hidden',!border);$('artworkSection').classList.toggle('hidden',!layer0&&!layer1&&!border);}

function buildBorderFields(){const b=theme.border,el=$('borderFields');if(b.source==='internal'){el.innerHTML=`<label>Style <select id="borderId">${BORDER_NAMES.map((n,i)=>`<option value="${i}" ${i===b.id?'selected':''}>${i}: ${n}</option>`).join('')}</select></label>`;$('borderId').addEventListener('change',()=>{const id=Number($('borderId').value),g=INTERNAL_BORDER_GEOMETRY[id];theme.border={source:'internal',id,name:BORDER_NAMES[id],tabOverlap:g[0],tabJoinDepth:g[1],selectedExpansion:g[2]};queueRender();});}else{el.innerHTML=numberField('Tab overlap','tabOverlap',b.tabOverlap,0,255,1)+numberField('Join depth','tabJoinDepth',b.tabJoinDepth,0,255,1)+numberField('Selected expand','selectedExpansion',b.selectedExpansion,0,255,1);el.querySelectorAll('[data-bg]').forEach(inp=>{const k=inp.dataset.bg;inp.removeAttribute('data-bg');inp.addEventListener('input',()=>{theme.border[k]=Math.round(Number(inp.value));queueRender();});});}syncArtworkRows();}

function buildColors(){const el=$('colors');el.innerHTML='';theme.colors.forEach((c,i)=>{const row=document.createElement('div');row.className='color';row.innerHTML=`<input type="color" value="${hex(c)}" title="${COLOR_NAMES[i]}"><span title="${COLOR_NAMES[i]}">${i}. ${COLOR_NAMES[i]}</span><input type="number" min="0" max="255" value="${c[3]}" title="Alpha">`;const [pick,_,alpha]=row.children;pick.addEventListener('input',()=>{const rgb=fromHex(pick.value);theme.colors[i][0]=rgb[0];theme.colors[i][1]=rgb[1];theme.colors[i][2]=rgb[2];queueRender();});alpha.addEventListener('input',()=>{theme.colors[i][3]=Math.max(0,Math.min(255,Math.round(Number(alpha.value))));queueRender();});el.append(row);});}

function thumb(id,info,image){const c=$(id),ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);if(image){const tmp=document.createElement('canvas');imageToCanvas(image,tmp);ctx.imageSmoothingEnabled=false;const s=Math.min(c.width/image.width,c.height/image.height),w=image.width*s,h=image.height*s;ctx.drawImage(tmp,(c.width-w)/2,(c.height-h)/2,w,h);$(info).textContent=`${image.width}×${image.height}`;}else{$(info).textContent='not present';}}
function updateArtwork(){thumb('layer0Thumb','layer0Info',theme.artwork.layer0);thumb('layer1Thumb','layer1Info',theme.artwork.layer1);thumb('borderThumb','borderInfo',theme.artwork.border);}
function updateJson(){try{$('json').textContent=JSON.stringify(themeToSerializable(theme,{}),null,2);}catch{$('json').textContent='';}}

function queueRender(){if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;render();updateJson();});}
function render(){if(!theme)return;try{setError('');previewRenderer.render(theme,animTime,$('hideUi').checked);}catch(e){setError(e.message);}}

$('name').addEventListener('input',()=>{theme.name=$('name').value;queueRender();});
$('family').addEventListener('input',()=>{theme.family=$('family').value;theme.displayFamily=normalizeFamily(theme.family);syncFamilyPick();queueRender();});
$('familyPick').addEventListener('change',()=>{$('family').value=$('familyPick').value;$('family').dispatchEvent(new Event('input'));});
$('bgMode').addEventListener('change',()=>{const mode=$('bgMode').value;if(mode==='solid')theme.background={mode:'solid'};else if(mode==='gradient')theme.background={mode:'gradient',speed:0.12,warp:0.3};else if(mode==='single'){theme.background={mode:'single',scale:1,velocityX:0.01,velocityY:0,rotation:0,alpha:255};theme.artwork.layer0??=blankTexture();}else if(mode==='static'){theme.background={mode:'static'};theme.staticLayout??={panX:0,panY:0};theme.artwork.staticBackground??=blankTexture(64);}else{theme.background={mode:'dual',scale0:1,scale1:0.5,velocityX0:0.01,velocityY0:0,velocityX1:-0.01,velocityY1:0.005,rotation:0,alpha0:255,alpha1:128};theme.artwork.layer0??=blankTexture();theme.artwork.layer1??=theme.artwork.layer0;}buildBgFields();updateArtwork();queueRender();});
$('borderSource').addEventListener('change',()=>{if($('borderSource').value==='internal'){const id=theme.border.id??0,g=INTERNAL_BORDER_GEOMETRY[id];theme.border={source:'internal',id,name:BORDER_NAMES[id],tabOverlap:g[0],tabJoinDepth:g[1],selectedExpansion:g[2]};}else{theme.border={source:'embedded',tabOverlap:2,tabJoinDepth:3,selectedExpansion:1};theme.artwork.border??=blankBorder();}buildBorderFields();updateArtwork();queueRender();});
$('hideUi').addEventListener('change',queueRender);
$('sharedLayer').addEventListener('change',()=>{if($('sharedLayer').checked){theme.artwork.layer0??=blankTexture();theme.artwork.layer1=theme.artwork.layer0;}else if(theme.artwork.layer1===theme.artwork.layer0)theme.artwork.layer1={width:theme.artwork.layer0.width,height:theme.artwork.layer0.height,data:new Uint8ClampedArray(theme.artwork.layer0.data)};updateArtwork();queueRender();});
$('importPng').addEventListener('change',async e=>{if(e.target.files[0]){await loadBlob(e.target.files[0]);currentFile=null;navigate(false);}e.target.value='';});
for(const [id,key] of [['layer0File','layer0'],['layer1File','layer1'],['borderFile','border']])$(id).addEventListener('change',async e=>{try{if(e.target.files[0]){const im=await decodePngBrowser(e.target.files[0]);theme.artwork[key]=im;if(key==='layer0'&&$('sharedLayer').checked)theme.artwork.layer1=im;updateArtwork();queueRender();}}catch(err){setError(err.message);}e.target.value='';});
function setView(gallery){$('galleryView').hidden=!gallery;$('editorView').hidden=gallery;$('showGallery').setAttribute('aria-pressed',String(gallery));$('showEditor').setAttribute('aria-pressed',String(!gallery));if(gallery)gallery$.open();else resizePreview();syncDownloads();}
// Edits change the theme in place, so the editor gets a copy of the gallery's.
const gallery$=initGallery({onSelect:(selected,file)=>{setTheme(structuredClone(selected),file);navigate(false);},setError:s=>setError(s),onFilter:()=>history.replaceState(history.state,'',urlFor(true)),onShown:()=>syncDownloads()});
$('showGallery').addEventListener('click',()=>navigate(true));
$('showEditor').addEventListener('click',()=>navigate(false));

// Navigation: the view, gallery filters and loaded package live in the query
// string (?view=gallery&family=…&q=… or ?theme=<file>), so links,
// reloads and the back button restore them. Each editor history entry keeps its
// theme object, so going back to it keeps its edits (and imported PNGs).
const PACKAGE_DIR='../assets/themes/';
const DEFAULT_THEME='water.png';
const entryThemes=new Map();
let currentFile=null,entryCount=0;
// Keys are unique per page load, so entries left from before a reload never match.
const newKey=()=>`${performance.timeOrigin}-${++entryCount}`;
history.scrollRestoration='manual';
function setTheme(next,file){theme=next;currentFile=file;animTime=0;previewViewport.reset();syncUi();queueRender();}
function urlFor(gallery){const p=new URLSearchParams();if(gallery){const f=gallery$.filters();p.set('view','gallery');if(f.family!=='All')p.set('family',f.family);if(f.type!=='all')p.set('type',f.type);if(f.query)p.set('q',f.query);}else if(currentFile)p.set('theme',currentFile);return p.size?`?${p}`:location.pathname;}
function navigate(gallery){
  history.replaceState({...history.state,scroll:scrollY},'');
  const state={gallery,scroll:0};
  if(!gallery){state.key=newKey();entryThemes.set(state.key,{theme,file:currentFile});}
  setView(gallery);scrollTo(0,0);
  const url=new URL(urlFor(gallery),location.href).href;
  history[url===location.href&&!!history.state?.gallery===gallery?'replaceState':'pushState'](state,'',url);
}
async function applyLocation(state){
  const p=new URLSearchParams(location.search),gallery=p.get('view')==='gallery';
  if(gallery)gallery$.setFilters({family:p.get('family')??'All',type:p.get('type')??'all',query:p.get('q')??''});
  else{
    const saved=entryThemes.get(state?.key),file=p.get('theme');
    if(saved?.theme){if(saved.theme!==theme)setTheme(saved.theme,saved.file);}
    else if(file&&/^[\w.-]+\.png$/.test(file)&&file!==currentFile){await loadUrl(PACKAGE_DIR+file);setTheme(theme,file);}
  }
  setView(gallery);
  requestAnimationFrame(()=>scrollTo(0,state?.scroll??0));
}
addEventListener('popstate',e=>applyLocation(e.state));
$('downloadTheme').addEventListener('click',async()=>{try{setError('');const packed=packThemeImage(theme,theme.artwork),blob=await encodePngBrowser(packed.image),safe=(theme.name||'theme').toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-|-$/g,'')||'theme';saveBlob(blob,`${safe}.png`);}catch(e){setError(e.message);}});
// In the gallery the ZIP holds the themes the filters show; in the editor, all of them.
let zipping=false;
function syncDownloads(){
  const inGallery=!$('galleryView').hidden,shown=gallery$.shownFiles().length,filtered=inGallery&&shown<gallery$.totalFiles();
  $('downloadTheme').hidden=inGallery;
  if(zipping)return;
  $('downloadThemes').disabled=filtered&&!shown;
  $('downloadThemes').textContent=filtered?`Download ${shown} theme${shown===1?'':'s'} (.zip)`:'Download all themes (.zip)';
}
$('downloadThemes').addEventListener('click',async()=>{
  const button=$('downloadThemes');
  zipping=true;button.disabled=true;setError('');
  try{
    const filtered=!$('galleryView').hidden&&gallery$.shownFiles().length<gallery$.totalFiles();
    const files=filtered?gallery$.shownFiles():await allThemeFiles();
    button.textContent=`Zipping 0/${files.length}…`;
    const zip=await zipThemes(files,(done,total)=>{button.textContent=`Zipping ${done}/${total}…`;});
    saveBlob(new Blob([zip],{type:'application/zip'}),THEME_ZIP_NAME);
  }catch(e){setError(e.message);}
  zipping=false;button.disabled=false;syncDownloads();
});

function animationLoop(now){const dt=Math.min((now-lastTick)/1000,.1);if(theme&&!$('editorView').hidden){if(playing)animTime+=dt*speed;$('scrub').max=Math.max(Number($('scrub').max),Math.ceil(animTime));$('scrub').value=animTime;$('timeReadout').textContent=`${animTime.toFixed(2)} s`;render();}lastTick=now;requestAnimationFrame(animationLoop);}
$('playPause').addEventListener('click',()=>{playing=!playing;$('playPause').textContent=playing?'Pause':'Play';});
$('scrub').addEventListener('input',()=>{animTime=Number($('scrub').value);});
$('speed').addEventListener('change',()=>{speed=Number($('speed').value);});
function resizePreview(){previewViewport.resize();}
previewRenderer=new WebGLThemeRenderer($('preview'));
const previewViewport=initPreviewViewport({canvas:$('preview'),viewport:$('previewViewport'),controls:document.querySelector('.preview-controls'),renderer:previewRenderer});
new ResizeObserver(resizePreview).observe($('previewViewport').parentElement);resizePreview();requestAnimationFrame(animationLoop);
await applyLocation(history.state);
if(!theme){await loadUrl(PACKAGE_DIR+DEFAULT_THEME);currentFile=DEFAULT_THEME;}
// Record the first entry like navigate() does for later ones.
{const gallery=new URLSearchParams(location.search).get('view')==='gallery',state={scroll:0,...history.state,gallery};
if(!gallery){state.key=newKey();entryThemes.set(state.key,{theme,file:currentFile});}
history.replaceState(state,'');}
