/** Display zoom only: the renderer and exported artwork remain 640×480. */
export function initPreviewViewport({canvas,viewport,controls,renderer}){
  let baseWidth=640,zoom=1,pinch=null;
  const $=id=>document.getElementById(id);
  function drawSize(){
    canvas.style.width=`${baseWidth*zoom}px`;canvas.style.height=`${baseWidth*zoom*.75}px`;
    $('previewZoomValue').value=`${Math.round(baseWidth*zoom/640*100)}%`;
    $('previewZoomOut').disabled=zoom<=Math.min(1,640/baseWidth)+.001;
    $('previewZoomIn').disabled=zoom>=8;
    $('previewFit').setAttribute('aria-pressed',String(Math.abs(zoom-1)<.001));
  }
  function setZoom(next,at=[viewport.clientWidth/2,viewport.clientHeight/2]){
    const anchor=[(viewport.scrollLeft+at[0])/(baseWidth*zoom),(viewport.scrollTop+at[1])/(baseWidth*zoom*.75)];
    zoom=Math.max(Math.min(1,640/baseWidth),Math.min(8,next));drawSize();
    viewport.scrollLeft=anchor[0]*baseWidth*zoom-at[0];viewport.scrollTop=anchor[1]*baseWidth*zoom*.75-at[1];
  }
  function resize(){
    const parent=viewport.parentElement,style=getComputedStyle(parent),available=parent.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
    if(available<=0)return;
    const center=[(viewport.scrollLeft+viewport.clientWidth/2)/(baseWidth*zoom),(viewport.scrollTop+viewport.clientHeight/2)/(baseWidth*zoom*.75)];
    baseWidth=Math.max(1,Math.min(available,available>=1280?1280:640));
    renderer.resize(available);viewport.style.width=`${baseWidth}px`;viewport.style.height=`${baseWidth*.75}px`;controls.style.width=`${baseWidth}px`;drawSize();
    viewport.scrollLeft=center[0]*baseWidth*zoom-viewport.clientWidth/2;viewport.scrollTop=center[1]*baseWidth*zoom*.75-viewport.clientHeight/2;
  }
  $('previewZoomIn').onclick=()=>setZoom(zoom*1.5);
  $('previewZoomOut').onclick=()=>setZoom(zoom/1.5);
  $('previewFit').onclick=()=>{zoom=1;drawSize();viewport.scrollTo(0,0);};
  $('previewActual').onclick=()=>setZoom(640/baseWidth);
  viewport.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();const rect=viewport.getBoundingClientRect();setZoom(zoom*Math.exp(-e.deltaY*.005),[e.clientX-rect.left,e.clientY-rect.top]);},{passive:false});
  function touchInfo(touches){const [a,b]=touches,rect=viewport.getBoundingClientRect();return{distance:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),at:[(a.clientX+b.clientX)/2-rect.left,(a.clientY+b.clientY)/2-rect.top]};}
  viewport.addEventListener('touchstart',e=>{
    if(e.touches.length!==2)return;e.preventDefault();const info=touchInfo(e.touches);
    pinch={...info,zoom,anchor:[(viewport.scrollLeft+info.at[0])/(baseWidth*zoom),(viewport.scrollTop+info.at[1])/(baseWidth*zoom*.75)]};
  },{passive:false});
  viewport.addEventListener('touchmove',e=>{
    if(!pinch||e.touches.length!==2)return;e.preventDefault();const info=touchInfo(e.touches);
    zoom=Math.max(Math.min(1,640/baseWidth),Math.min(8,pinch.zoom*info.distance/Math.max(1,pinch.distance)));drawSize();
    viewport.scrollLeft=pinch.anchor[0]*baseWidth*zoom-info.at[0];viewport.scrollTop=pinch.anchor[1]*baseWidth*zoom*.75-info.at[1];
  },{passive:false});
  const stopPinch=()=>{pinch=null;};viewport.addEventListener('touchend',stopPinch);viewport.addEventListener('touchcancel',stopPinch);
  return{resize,reset:()=>{$('previewFit').click();}};
}
