import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/controls/OrbitControls.js';
import { VRButton } from 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/webxr/VRButton.js';

// Internal state
let renderer, scene, camera, controls, sphere, material;
let modalEl, container, titleEl, statusEl,
    timelineRange, timelineLegend,
    timelineTicks,
    exposureRange, gammaRange, autoAdjustBtn, resetAdjustBtn,
    prevBtn, nextBtn, recenterBtn, closeBtn, fullscreenBtn, audioBtn, sideGallery;
let toggleLeftBtn, toggleRightBtn, viewerGridEl, centerPanelEl;
// no header-based restore; use in-card chevrons and slim handles
let infoStageEl, infoTakenEl, infoLocationEl, infoProjectTitleEl, infoStagesEl, infoMediaEl, infoDescEl, infoAudioEl;
let mixUniform;
let currentProject = null;
let stages = [];
let stageTextures = [];
let stageVideos = [];
let stagePos = 0; // float 0..(stages.length-1)
let fsOverlay;
let fsIndicatorEl;
let currentStageIndex = 0;
// relative view carry-over disabled (fronts removed)
let toastHost;
let audioEnabled = false;
let _blockZoomHandlers = [];
let loadingOverlayEl;
let _progressLoaded = 0;
let _progressTotal = 0;

// Per-stage orientation (persisted)
// Store angles instead of quaternions for OrbitControls
// orients[index] -> [theta, phi]
let stageOrients = {};
// Per-stage adjustments (persisted)
let exposureByStage = {};
let gammaByStage = {};

// Keep chevrons and aria/text in sync with collapse state
function syncCollapseUI(){
  const g = viewerGridEl || modalEl?.querySelector?.('.viewer-grid');
  const leftOn = g?.classList?.contains('collapse-left');
  const rightOn = g?.classList?.contains('collapse-right');
  if(toggleLeftBtn){
    toggleLeftBtn.setAttribute('aria-pressed', leftOn ? 'true':'false');
    toggleLeftBtn.textContent = leftOn ? '›' : '‹';
    toggleLeftBtn.title = leftOn ? 'Show Gallery' : 'Hide Gallery';
  }
  if(toggleRightBtn){
    toggleRightBtn.setAttribute('aria-pressed', rightOn ? 'true':'false');
    toggleRightBtn.textContent = rightOn ? '‹' : '›';
    toggleRightBtn.title = rightOn ? 'Show Tools' : 'Hide Tools';
  }
}
// Local persistence (per project)
const STORE_PREFIX = 'p360:proj:';
function storeKey(){ return `${STORE_PREFIX}${currentProject?.id || 'unknown'}`; }
function loadSettings(){
  try { return JSON.parse(localStorage.getItem(storeKey()) || '{}'); }
  catch { return {}; }
}
function saveSettings(partial){
  try {
    const prev = loadSettings();
    const next = { ...prev };
    for(const k of Object.keys(partial)){
      if(typeof partial[k] === 'object' && partial[k] && !Array.isArray(partial[k])){
        next[k] = { ...(prev[k]||{}), ...(partial[k]||{}) };
      }else{
        next[k] = partial[k];
      }
    }
    localStorage.setItem(storeKey(), JSON.stringify(next));
  } catch {}
}

function ensureUIRefs(){
  // Always (re)bind to current DOM; do not early-return
  modalEl = document.getElementById('viewerModal');
  container = document.getElementById('viewerCanvasWrap');
  titleEl = document.getElementById('viewerProjectTitle');
  statusEl = document.getElementById('viewerStatus');
  timelineRange = document.getElementById('timelineRange');
  timelineLegend = document.getElementById('timelineLegend');
  timelineTicks = document.getElementById('timelineTicks');
  exposureRange = document.getElementById('exposureRange');
  gammaRange = document.getElementById('gammaRange');
  autoAdjustBtn = document.getElementById('autoAdjustBtn');
  resetAdjustBtn = document.getElementById('resetAdjustBtn');
  prevBtn = document.getElementById('prevBtn');
  nextBtn = document.getElementById('nextBtn');
  recenterBtn = document.getElementById('recenterBtn');
  fullscreenBtn = document.getElementById('fullscreenBtn');
  closeBtn = document.getElementById('closeViewer');
  audioBtn = document.getElementById('audioBtn');
  sideGallery = document.getElementById('sideGallery');
  infoStageEl = document.getElementById('infoStage');
  infoTakenEl = document.getElementById('infoTaken');
  infoLocationEl = document.getElementById('infoLocation');
  infoProjectTitleEl = document.getElementById('infoProjectTitle');
  infoStagesEl = document.getElementById('infoStages');
  infoMediaEl = document.getElementById('infoMedia');
  infoDescEl = document.getElementById('infoDesc');
  infoAudioEl = document.getElementById('infoAudio');
  toastHost = document.getElementById('toastHost');

  // Landscape collapsible controls (header actions, not over image)
  viewerGridEl = modalEl?.querySelector('.viewer-grid') || null;
  centerPanelEl = modalEl?.querySelector('.center-panel') || null;
  // Remove any legacy edge overlay toggles if present
  try{ centerPanelEl?.querySelectorAll?.('.edge-toggle')?.forEach(el=> el.remove()); }catch{}
  // Create in-card toggles
  const leftPanel = modalEl?.querySelector('.left-panel');
  const leftTitle = leftPanel?.querySelector('.panel-title');
  if(leftTitle){
    // Normalize header content: [spacer][label centered][chevron at right]
    leftTitle.classList.add('chev-right');
    // Ensure label + single spacer exist
    let label = leftTitle.querySelector('.panel-label');
    if(!label){
      const text = (leftTitle.textContent || '').trim() || 'Gallery';
      leftTitle.textContent = '';
      const spacer = document.createElement('span');
      spacer.className = 'panel-spacer';
      leftTitle.appendChild(spacer);
      label = document.createElement('span');
      label.className = 'panel-label';
      label.textContent = text;
      leftTitle.appendChild(label);
    }else{
      // If two spacers exist from previous runs, keep only one
      const spacers = leftTitle.querySelectorAll('.panel-spacer');
      if(spacers.length > 1){ spacers.forEach((s,i)=>{ if(i>0) s.remove(); }); }
      if(spacers.length === 0){ const sp = document.createElement('span'); sp.className='panel-spacer'; leftTitle.insertBefore(sp, label); }
    }
    toggleLeftBtn = leftTitle.querySelector('#toggleLeftBtn');
    if(!toggleLeftBtn){
      toggleLeftBtn = document.createElement('button');
      toggleLeftBtn.id = 'toggleLeftBtn';
      toggleLeftBtn.type = 'button';
      toggleLeftBtn.className = 'btn ghost toggle-btn';
      toggleLeftBtn.setAttribute('aria-pressed','false');
      leftTitle.appendChild(toggleLeftBtn);
    }
  }

  const rightRail = modalEl?.querySelector('.right-rail');
  // Remove legacy right-toggle card if it exists
  try{ rightRail?.querySelectorAll?.('.right-toggle')?.forEach(el=> el.remove()); }catch{}
  // Build a Tools header card and a tools-content container; move existing panels inside
  if(rightRail){
    let toolsHeader = rightRail.querySelector('.right-tools');
    if(!toolsHeader){
      toolsHeader = document.createElement('aside');
      toolsHeader.className = 'panel card-panel right-tools';
      const h = document.createElement('h3');
      h.className = 'panel-title chev-left';
      // label + spacer (chevron inserted first below)
      const label = document.createElement('span'); label.className = 'panel-label'; label.textContent = 'Tools';
      const spacer = document.createElement('span'); spacer.className = 'panel-spacer';
      h.appendChild(label);
      h.appendChild(spacer);
      toolsHeader.appendChild(h);
      rightRail.insertBefore(toolsHeader, rightRail.firstChild);
    }else{
      const h = toolsHeader.querySelector('.panel-title');
      if(h) h.classList.add('chev-left');
      if(h && !h.querySelector('.panel-label')){
        const label = document.createElement('span'); label.className='panel-label'; label.textContent='Tools';
        const spacer = document.createElement('span'); spacer.className='panel-spacer';
        h.appendChild(label); h.appendChild(spacer);
      }
    }
    // Insert chevron button
    const h2 = toolsHeader.querySelector('.panel-title');
    toggleRightBtn = toolsHeader.querySelector('#toggleRightBtn');
    if(!toggleRightBtn){
      toggleRightBtn = document.createElement('button');
      toggleRightBtn.id = 'toggleRightBtn';
      toggleRightBtn.type = 'button';
      toggleRightBtn.className = 'btn ghost toggle-btn';
      toggleRightBtn.setAttribute('aria-pressed','false');
      h2?.insertBefore(toggleRightBtn, h2.firstChild);
    }
    // Create tools-content card and move panels inside
    let toolsContent = rightRail.querySelector('.tools-content');
    if(!toolsContent){
      toolsContent = document.createElement('aside');
      toolsContent.className = 'panel card-panel tools-content';
      // move existing info/actions/adjustments cards into tools-content
      const info = rightRail.querySelector('.right-info');
      const actions = rightRail.querySelector('.right-actions');
      const adjust = rightRail.querySelector('.right-panel');
      if(info) toolsContent.appendChild(info);
      if(actions) toolsContent.appendChild(actions);
      if(adjust) toolsContent.appendChild(adjust);
      rightRail.appendChild(toolsContent);
    }
  }

  // No header restore buttons per design

  // Ensure a lightweight loading overlay exists over the canvas area
  try{
    if(container && !loadingOverlayEl){
      loadingOverlayEl = document.createElement('div');
      loadingOverlayEl.className = 'loading-overlay';
      loadingOverlayEl.innerHTML = '<div class="spinner"></div><div class="loading-text">Loading…</div>';
      container.appendChild(loadingOverlayEl);
      loadingOverlayEl.style.display = 'none';
    }
  }catch{}

  if(!modalEl || !container) throw new Error('Viewer UI elements not found');

  closeBtn?.addEventListener('click', closeViewer);
  timelineRange?.addEventListener('input', (e)=> setStagePos(parseFloat(e.target.value)) );
  // Snap to nearest stage when releasing the thumb
  timelineRange?.addEventListener('change', (e)=> setStagePos(Math.round(parseFloat(e.target.value))) );
  prevBtn?.addEventListener('click', ()=> nudgeStage(-1));
  nextBtn?.addEventListener('click', ()=> nudgeStage(+1));
  fullscreenBtn?.addEventListener('click', toggleFullscreen);
  exposureRange?.addEventListener('input', (e)=> setExposure(parseFloat(e.target.value)) );
  gammaRange?.addEventListener('input', (e)=> setGamma(parseFloat(e.target.value)) );
  autoAdjustBtn?.addEventListener('click', ()=> autoAdjust());
  resetAdjustBtn?.addEventListener('click', ()=> { setExposure(1.0); setGamma(1.1); });
  recenterBtn?.addEventListener('click', ()=> recenterToStageFront());
  audioBtn?.addEventListener('click', ()=> setAudioEnabled(!audioEnabled));
  // Reflect audio state styling
  if(audioBtn){ audioBtn.classList.toggle('active', !!audioEnabled); }

  // Collapse/expand handlers
  const grid = ()=> (viewerGridEl || modalEl?.querySelector('.viewer-grid'));
  toggleLeftBtn?.addEventListener('click', ()=>{ const g = grid(); if(!g) return; g.classList.toggle('collapse-left'); syncCollapseUI(); setTimeout(onResize,0); });
  toggleRightBtn?.addEventListener('click', ()=>{ const g = grid(); if(!g) return; g.classList.toggle('collapse-right'); syncCollapseUI(); setTimeout(onResize,0); });
  // Initial sync now that buttons exist
  syncCollapseUI();
}

// Toasts
function showToast(message, type = 'info', timeoutMs = 2600){
  if(!toastHost){ toastHost = document.getElementById('toastHost'); }
  if(!toastHost) return;
  const el = document.createElement('div');
  el.className = `toast ${type} toast-enter`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(()=>{
    el.classList.remove('toast-enter');
    el.classList.add('toast-exit');
    setTimeout(()=> el.remove(), 200);
  }, timeoutMs);
}

function setAudioEnabled(flag){
  audioEnabled = !!flag;
  if(audioBtn){
    audioBtn.textContent = audioEnabled ? 'Audio On' : 'Audio Off';
    audioBtn.classList.toggle('active', audioEnabled);
  }
  // update overlay button label if present
  if(fsOverlay){
    const ab = fsOverlay.querySelector('button[data-action="audio"]');
    if(ab) ab.textContent = audioEnabled ? 'Audio On' : 'Audio Off';
  }
  // Apply to current stage
  applyAudioForCurrent();
  showToast(audioEnabled ? 'Audio enabled' : 'Audio muted', 'info');
  // Update info panel status if visible
  try{ updateInfoPanel(); }catch{}
}

function applyAudioForCurrent(){
  if(!stageVideos || !stageVideos.length) return;
  // Mute all, then unmute current if enabled
  for(const v of stageVideos){ try{ if(v) v.muted = true; }catch{} }
  const v = stageVideos[currentStageIndex];
  if(audioEnabled && v){
    try{ v.muted = false; safePlay(v); }catch{}
  }
}

function safePlay(video){
  if(!video || typeof video.play !== 'function') return;
  // Defer to avoid immediate pause->play race
  setTimeout(()=>{
    try{
      const p = video.play();
      if(p && typeof p.catch === 'function') p.catch(()=>{});
    }catch{}
  }, 0);
}

function setMix(v){ if(mixUniform) mixUniform.value = v; }

function setStagePos(v, persist = true){
  if(!stages.length) return;
  const targetPos = Math.min(stages.length-1, Math.max(0, v));
  if(timelineRange) timelineRange.value = String(targetPos);
  const newIndex = Math.floor(targetPos);
  const changedIndex = (newIndex !== currentStageIndex);

  // Compute relative view delta disabled (fronts removed)

  stagePos = targetPos;
  currentStageIndex = newIndex;
  const frac = stagePos - newIndex;
  const texA = getTextureAt(newIndex);
  const texB = getTextureAt(Math.min(newIndex+1, stageTextures.length-1)) || texA;
  if(material){
    material.uniforms.map1.value = texA;
    material.uniforms.map2.value = texB;
  }
  setMix(frac);
  updateTimelineLegendHighlight(newIndex, frac);
  if(persist) saveSettings({ stagePos });
  // Update overlay indicator if visible
  if(fsOverlay && fsOverlay.style.display !== 'none') updateFsIndicator();
  updateInfoPanel();
  // Keep current view on stage change; no auto-rotate
  if(changedIndex){
    // Load per-stage adjustments (and auto if missing)
    applyAdjustmentsForStage(newIndex, true);
    // Make sure recenter has a baseline orientation for this stage
    ensureStageOrient(newIndex);
  }
  playStageMedia(currentStageIndex);
}

function getTextureAt(i){
  if(!stageTextures || !stageTextures.length) return null;
  if(stageTextures[i]) return stageTextures[i];
  for(let k=i; k>=0; k--){ if(stageTextures[k]) return stageTextures[k]; }
  for(let k=i; k<stageTextures.length; k++){ if(stageTextures[k]) return stageTextures[k]; }
  return stageTextures.find(Boolean) || null;
}

function playStageMedia(index){
  if(!stageVideos || !stageVideos.length) return;
  const keepA = index;
  const keepB = Math.min(index+1, stageVideos.length-1);
  // Pause and mute all that aren't active
  for(let i=0;i<stageVideos.length;i++){
    const v = stageVideos[i];
    if(!v) continue;
    if(i !== keepA && i !== keepB){ try{ v.pause(); v.muted = true; }catch{} }
  }
  const v1 = stageVideos[keepA];
  const v2 = stageVideos[keepB];
  if(v1) safePlay(v1);
  if(v2 && v2 !== v1) safePlay(v2);
  // If audio enabled, unmute only current stage
  if(audioEnabled && v1){ v1.muted = false; safePlay(v1); }
}

function nudgeStage(dir){
  // Use the committed stage index to avoid skipping when slider is between ticks
  const i = currentStageIndex + dir;
  setStagePos(i);
}

function updateTimelineLegend(labels=[]){
  if(!timelineLegend) return;
  timelineLegend.innerHTML = '';
  labels.forEach((lab, idx)=>{
    const span = document.createElement('span');
    span.textContent = lab;
    span.style.cursor = 'pointer';
    span.addEventListener('click', ()=> setStagePos(idx));
    timelineLegend.appendChild(span);
  });
}

function updateTimelineTicks(count){
  if(!timelineTicks) return;
  timelineTicks.innerHTML = '';
  for(let i=0;i<count;i++){
    const t = document.createElement('span');
    t.className = 'tick';
    t.title = stages[i]?.label || `Stage ${i+1}`;
    t.addEventListener('click', ()=> setStagePos(i));
    timelineTicks.appendChild(t);
  }
}

function updateTimelineLegendHighlight(i, frac){
  if(!timelineLegend) return;
  const children = timelineLegend.children;
  for(let k=0;k<children.length;k++){
    children[k].style.opacity = (k===i || (k===i+1 && frac>0)) ? '1' : '0.6';
  }
  // gallery highlight
  if(sideGallery){
    const thumbs = sideGallery.querySelectorAll('img.thumb');
    thumbs.forEach((img, idx)=>{
      img.classList.toggle('active', idx===i || (idx===i+1 && frac>0));
    });
  }
  // ticks highlight
  if(timelineTicks){
    const ticks = timelineTicks.querySelectorAll('.tick');
    ticks.forEach((tick, idx)=>{
      tick.classList.toggle('active', idx===i || (idx===i+1 && frac>0));
    });
  }
}

function toggleFullscreen(){
  if(!container) return;
  const isFS = document.fullscreenElement === container;
  if(isFS){ document.exitFullscreen?.(); }
  else{
    const opts = { navigationUI: 'hide' };
    try{ container.requestFullscreen?.(opts); }
    catch{ container.requestFullscreen?.(); }
  }
}

document.addEventListener('fullscreenchange', ()=>{
  if(fullscreenBtn) {
    fullscreenBtn.textContent = document.fullscreenElement ? 'Exit Full Screen' : 'Full Screen';
  }
  onResize();
  // run again after layout settles
  setTimeout(onResize, 50);
  setTimeout(onResize, 200);
  showFsOverlay(document.fullscreenElement === container || renderer?.xr?.isPresenting === true);
});

function setupXRControllers(){
  try{
    const next = renderer.xr.getController(0);
    const prev = renderer.xr.getController(1);
    next.addEventListener('select', ()=> nudgeStage(+1));
    prev.addEventListener('select', ()=> nudgeStage(-1));
    next.addEventListener('squeeze', endXRSession);
    prev.addEventListener('squeeze', endXRSession);
    scene.add(next); scene.add(prev);
  }catch{}
}

function endXRSession(){
  const s = renderer?.xr?.getSession?.();
  s?.end?.();
}

function exitXRorFS(){
  if(renderer?.xr?.isPresenting){ endXRSession(); return; }
  if(document.fullscreenElement === container){ document.exitFullscreen?.(); }
}

function showFsOverlay(show){
  if(!container) return;
  if(!fsOverlay){
    fsOverlay = document.createElement('div');
    fsOverlay.className = 'fs-overlay';
    fsOverlay.innerHTML = `
      <div class="fs-exit">
        <button class="btn ghost" data-action="audio">Audio Off</button>
        <button class="btn exit-btn" data-action="exit">Exit Full Screen</button>
      </div>
      <div class="fs-nav">
        <button class="btn big" data-action="prev">Prev</button>
        <div class="fs-indicator"></div>
        <button class="btn big" data-action="next">Next</button>
      </div>
    `;
    fsOverlay.addEventListener('click', (e)=>{
      const b = e.target.closest('button');
      if(!b) return;
      const a = b.dataset.action;
      if(a==='prev') nudgeStage(-1);
      if(a==='next') nudgeStage(+1);
      if(a==='audio') setAudioEnabled(!audioEnabled);
      if(a==='exit') exitXRorFS();
    });
    container.appendChild(fsOverlay);
    fsIndicatorEl = fsOverlay.querySelector('.fs-indicator');
    const ab = fsOverlay.querySelector('button[data-action="audio"]');
    if(ab) ab.textContent = audioEnabled ? 'Audio On' : 'Audio Off';
  }
  fsOverlay.style.display = show ? 'flex' : 'none';
  if(show) updateFsIndicator();
}

function updateFsIndicator(){
  if(!fsIndicatorEl || !stages.length) return;
  const i = Math.floor(stagePos);
  const label = stages[i]?.label || `Stage ${i+1}`;
  fsIndicatorEl.textContent = `${label} • ${i+1}/${stages.length}`;
}

// ---------- Info panel (EXIF + project meta) ----------
const exifCache = new Map(); // url -> { taken, gpsText, gps }

function updateInfoPanel(){
  if(!stages.length) return;
  const i = Math.floor(stagePos);
  const stage = stages[i];
  if(infoStageEl) infoStageEl.textContent = stage?.label || `Stage ${i+1}`;
  if(infoProjectTitleEl) infoProjectTitleEl.textContent = currentProject?.title || '-';
  if(infoStagesEl) infoStagesEl.textContent = `${stages.length}`;
  if(infoMediaEl){
    const imgs = stages.filter(s=> /\.jpg(\?|$)/i.test(s.url)).length;
    const vids = stages.filter(s=> /\.(mp4|webm|ogg)(\?|$)/i.test(s.url)).length;
    const parts = [];
    if(imgs) parts.push(`${imgs} image${imgs>1?'s':''}`);
    if(vids) parts.push(`${vids} video${vids>1?'s':''}`);
    infoMediaEl.textContent = parts.join(' • ') || '-';
  }
  if(infoDescEl){
    const desc = currentProject?.meta?.description || currentProject?.description || '';
    infoDescEl.textContent = desc || 'No description available.';
  }
  // Audio availability per stage
  if(infoAudioEl){
    const isVideo = /\.(mp4|webm|ogg)(\?|$)/i.test(stage?.url||'');
    const status = isVideo ? (audioEnabled ? 'Available • On' : 'Available • Off') : 'Not available';
    infoAudioEl.textContent = status;
  }
  // Toggle subtle attention pulse on Audio button when stage has audio but is muted
  try{
    const isVideo = /\.(mp4|webm|ogg)(\?|$)/i.test(stage?.url||'');
    if(audioBtn){ audioBtn.classList.toggle('audio-attn', !!isVideo && !audioEnabled); }
  }catch{}
  const url = stage?.url;
  if(!url){
    if(infoTakenEl) infoTakenEl.textContent = '—';
    if(infoLocationEl) infoLocationEl.textContent = currentProject?.meta?.location || '—';
    return;
  }
  if(exifCache.has(url)){
    const { taken, gpsText, gps } = exifCache.get(url);
    if(infoTakenEl) infoTakenEl.textContent = taken || '—';
    if(infoLocationEl){
      if(gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lon)){
        infoLocationEl.innerHTML = `<a href="https://www.google.com/maps?q=${gps.lat},${gps.lon}" target="_blank" rel="noopener">${gpsText}</a>`;
      } else {
        infoLocationEl.textContent = gpsText || (currentProject?.meta?.location || '—');
      }
    }
    return;
  }
  // Parse EXIF for date/time and GPS; fall back to HTTP Last-Modified
  fetch(url, { cache: 'force-cache' })
    .then(async (r)=>{
      const lastModified = r.headers.get('last-modified');
      const buf = await r.arrayBuffer();
      const meta = parseBasicExif(buf) || {};
      const exifDate = meta.dateTimeOriginal || meta.dateTimeDigitized || meta.dateTime;
      const taken = formatTaken(exifDate) || formatHttpDate(lastModified) || '';
      const gps = meta?.gps;
      const gpsText = gps ? `${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}` : '';
      exifCache.set(url, { taken, gpsText, gps });
      if(infoTakenEl) infoTakenEl.textContent = taken || '—';
      if(infoLocationEl){
        if(gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lon)){
          infoLocationEl.innerHTML = `<a href="https://www.google.com/maps?q=${gps.lat},${gps.lon}" target="_blank" rel="noopener">${gpsText}</a>`;
        } else {
          infoLocationEl.textContent = gpsText || (currentProject?.meta?.location || '—');
        }
      }
    })
    .catch(()=>{
      if(infoTakenEl) infoTakenEl.textContent = '—';
      if(infoLocationEl) infoLocationEl.textContent = currentProject?.meta?.location || '—';
    });
}

function parseBasicExif(arrayBuffer){
  const data = new DataView(arrayBuffer);
  let offset = 2;
  if(data.getUint16(0) !== 0xFFD8) return {};
  while(offset < data.byteLength){
    const marker = data.getUint16(offset); offset += 2;
    const size = data.getUint16(offset); offset += 2;
    if(marker === 0xFFE1){ // APP1
      // Check Exif header
      if(getString(data, offset, 4) !== 'Exif') break;
      const tiffOffset = offset + 6; // 'Exif\0\0'
      return readTIFF(data, tiffOffset);
    } else {
      offset += size - 2;
    }
  }
  return {};
}

function readTIFF(view, tiffOffset){
  const endian = view.getUint16(tiffOffset);
  const little = endian === 0x4949;
  const getU16 = (o)=> little? view.getUint16(o,true):view.getUint16(o,false);
  const getU32 = (o)=> little? view.getUint32(o,true):view.getUint32(o,false);
  const getRational = (o)=>{
    const num = getU32(o); const den = getU32(o+4);
    return den? num/den : 0;
  };
  const firstIFD = getU32(tiffOffset + 4) + tiffOffset;
  const base = tiffOffset;
  function readIFD(ifdOffset){
    const count = getU16(ifdOffset);
    const tags = new Map();
    let p = ifdOffset + 2;
    for(let i=0;i<count;i++){
      const tag = getU16(p); const type = getU16(p+2); const num = getU32(p+4); const valueOff = p+8;
      let valOff = getU32(valueOff) + base;
      let value = null;
      if(type === 2){ // ASCII
        value = getAscii(view, (num>4? valOff : valueOff), num);
      }else if(type === 3){ // SHORT
        value = (num>1)? Array.from({length:num}, (_,$)=> getU16(valOff+2*$)) : getU16(valueOff);
      }else if(type === 4){ // LONG
        value = (num>1)? Array.from({length:num}, (_,$)=> getU32(valOff+4*$)) : getU32(valueOff);
      }else if(type === 5){ // RATIONAL
        if(num>1){ value = Array.from({length:num}, (_,$)=> getRational(valOff+8*$)); }
        else value = getRational(valOff);
      }
      tags.set(tag, value);
      p += 12;
    }
    const next = getU32(p);
    return { tags, next: next? next+base:0 };
  }
  const ifd0 = readIFD(firstIFD);
  const exifPtr = ifd0.tags.get(0x8769);
  const gpsPtr = ifd0.tags.get(0x8825);
  let meta = {};
  if(exifPtr){
    const exifIFD = readIFD(exifPtr + base);
    const dto = exifIFD.tags.get(0x9003); // DateTimeOriginal
    const dtd = exifIFD.tags.get(0x9004); // DateTimeDigitized
    const dt0 = ifd0.tags.get(0x0132);    // ModifyDate/DateTime
    if(dto) meta.dateTimeOriginal = String(dto).trim();
    if(dtd) meta.dateTimeDigitized = String(dtd).trim();
    if(!meta.dateTimeOriginal && dt0) meta.dateTime = String(dt0).trim();
  } else {
    const dto0 = ifd0.tags.get(0x0132);
    if(dto0) meta.dateTime = String(dto0).trim();
  }
  if(gpsPtr){
    const gpsIFD = readIFD(gpsPtr + base);
    const latRef = gpsIFD.tags.get(0x0001);
    const lat = gpsIFD.tags.get(0x0002);
    const lonRef = gpsIFD.tags.get(0x0003);
    const lon = gpsIFD.tags.get(0x0004);
    if(lat && lon){
      const latVal = dmsToDeg(lat) * (latRef==='S'?-1:1);
      const lonVal = dmsToDeg(lon) * (lonRef==='W'?-1:1);
      meta.gps = { lat: latVal, lon: lonVal };
    }
  }
  return meta;
}

function dmsToDeg(arr){
  if(Array.isArray(arr)) return (arr[0] + arr[1]/60 + arr[2]/3600);
  return arr || 0;
}

function getAscii(view, offset, len){
  let s='';
  for(let i=0;i<len-1;i++) s += String.fromCharCode(view.getUint8(offset+i));
  return s;
}

function getString(view, offset, len){
  let s='';
  for(let i=0;i<len;i++) s += String.fromCharCode(view.getUint8(offset+i));
  return s;
}

function formatTaken(exifDate){
  if(!exifDate) return '';
  // EXIF format: YYYY:MM:DD HH:MM:SS
  const m = /^([0-9]{4}):([0-9]{2}):([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})/.exec(exifDate);
  if(!m) return exifDate;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  try{
    const d = new Date(iso);
    if(isNaN(d.getTime())) return exifDate;
    return d.toLocaleString();
  }catch{ return exifDate; }
}

function formatHttpDate(hdr){
  if(!hdr) return '';
  try{
    const d = new Date(hdr);
    if(isNaN(d.getTime())) return '';
    return d.toLocaleString();
  }catch{ return ''; }
}

function setExposure(v, persist = true){
  if(!material) return;
  material.uniforms.exposure.value = v;
  if(exposureRange) exposureRange.value = String(v);
  if(persist){
    exposureByStage[currentStageIndex] = v;
    saveSettings({ exposureByStage: { [currentStageIndex]: v } });
  }
}

function setGamma(v, persist = true){
  if(!material) return;
  material.uniforms.gamma.value = v;
  if(gammaRange) gammaRange.value = String(v);
  if(persist){
    gammaByStage[currentStageIndex] = v;
    saveSettings({ gammaByStage: { [currentStageIndex]: v } });
  }
}

// Apply saved (or default/auto) adjustments for a given stage
function applyAdjustmentsForStage(index, allowAuto = true){
  const eSaved = (exposureByStage && typeof exposureByStage[index] === 'number') ? exposureByStage[index] : null;
  const gSaved = (gammaByStage && typeof gammaByStage[index] === 'number') ? gammaByStage[index] : null;
  const e = eSaved ?? 1.0;
  const g = gSaved ?? 1.3;
  // Apply without persisting
  setExposure(e, false);
  setGamma(g, false);
  if(allowAuto && (eSaved == null || gSaved == null)){
    const i = index;
    const url = (currentProject?.stages?.[i]?.url) || (currentProject?.stages?.[0]?.url);
    if(url){
      analyzeImage(url).then(({ exposure, gamma })=>{
        if(eSaved == null){
          if(currentStageIndex === i) setExposure(exposure);
          else { exposureByStage[i] = exposure; saveSettings({ exposureByStage: { [i]: exposure } }); }
        }
        if(gSaved == null){
          if(currentStageIndex === i) setGamma(gamma);
          else { gammaByStage[i] = gamma; saveSettings({ gammaByStage: { [i]: gamma } }); }
        }
      }).catch(()=>{});
    }
  }
}

function initRenderer(){
  if(renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha:false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setSize(w, h);
  renderer.xr.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  // Add VR button only when WebXR is available
  const host = document.createElement('div');
  host.className = 'vr-button-host';
  const vrBtn = VRButton.createButton(renderer);
  // Ensure the button sits fully inside the container (avoid clipping)
  vrBtn.style.position = 'static';
  vrBtn.style.right = '';
  vrBtn.style.bottom = '';
  host.appendChild(vrBtn);
  container.appendChild(host);

  // Resize when container dimensions change (e.g., modal opens, fullscreen)
  if (typeof ResizeObserver !== 'undefined'){
    const ro = new ResizeObserver(()=> onResize());
    ro.observe(container);
  }

  // Hook XR session events
  renderer.xr.addEventListener('sessionstart', ()=>{
    showFsOverlay(true);
    setupXRControllers();
  });
  renderer.xr.addEventListener('sessionend', ()=>{
    showFsOverlay(document.fullscreenElement === container);
  });
}

function getAngles(){
  if(!controls) return { theta:0, phi:Math.PI/2 };
  return { theta: controls.getAzimuthalAngle(), phi: controls.getPolarAngle() };
}
function normAngle(a){
  if(!isFinite(a)) return 0;
  while(a <= -Math.PI) a += Math.PI*2;
  while(a > Math.PI) a -= Math.PI*2;
  return a;
}
function setAngles(theta, phi){
  if(!controls) return;
  const curr = getAngles();
  const dTheta = curr.theta - theta;
  const dPhi = curr.phi - phi;
  // Use API methods to avoid touching internals
  if(typeof controls.rotateLeft === 'function') controls.rotateLeft(dTheta);
  if(typeof controls.rotateUp === 'function') controls.rotateUp(dPhi);
  controls.update();
}

function applySavedOrientationForStage(index){
  if(stageOrients && stageOrients[index]){
    const a = stageOrients[index];
    setAngles(a[0], a[1]);
    // Make this the reset baseline so Recenter works reliably
    try{ controls?.saveState?.(); }catch{}
    return;
  }
}

// Ensure there is a baseline orientation saved for a stage
function ensureStageOrient(index){
  if(!controls) return;
  if(!stageOrients) stageOrients = {};
  if(typeof stageOrients[index] === 'undefined'){
    const ang = getAngles();
    stageOrients[index] = [ang.theta, ang.phi];
    saveSettings({ orients: { [index]: stageOrients[index] } });
    // Also set the current state as the reset baseline
    try{ controls?.saveState?.(); }catch{}
  }
}

function recenterToStageFront(){
  // Prefer the controls reset baseline for smooth, reliable recentering
  if(controls?.reset){ controls.reset(); return; }
  // Fallback: use saved orientation or sensible default
  const a = stageOrients?.[currentStageIndex];
  if(a){ setAngles(a[0], a[1]); }
  else { setAngles(0, Math.PI/2); ensureStageOrient(currentStageIndex); }
}

function onResize(){
  if(!renderer) return;
  const elem = document.fullscreenElement || container;
  let w = elem?.clientWidth || window.innerWidth;
  let h = elem?.clientHeight || window.innerHeight;
  if(!w || !h){
    const r = elem?.getBoundingClientRect?.();
    w = r?.width || container.clientWidth;
    h = r?.height || container.clientHeight;
  }
  const W = Math.max(1, Math.floor(w)), H = Math.max(1, Math.floor(h));
  renderer.setSize(W, H);
  if(camera){
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
  }
}

function animate(){
  renderer.setAnimationLoop(()=>{
    renderer.render(scene, camera);
  });
}

function EquirectBlendMaterial(texA, texB){
  return new THREE.ShaderMaterial({
    uniforms:{
      map1:{ value: texA },
      map2:{ value: texB },
      mixAmount:{ value: 0.0 },
      exposure:{ value: 1.0 },
      gamma:{ value: 1.0 }
    },
    vertexShader:`
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader:`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D map1;
      uniform sampler2D map2;
      uniform float mixAmount;
      uniform float exposure;
      uniform float gamma;
      vec3 srgb_to_linear(vec3 c){
        bvec3 cutoff = lessThanEqual(c, vec3(0.04045));
        vec3 low = c / 12.92;
        vec3 high = pow((c + 0.055) / 1.055, vec3(2.4));
        return mix(high, low, vec3(cutoff));
      }
      vec3 linear_to_srgb(vec3 c){
        bvec3 cutoff = lessThanEqual(c, vec3(0.0031308));
        vec3 low = 12.92 * c;
        vec3 high = 1.055 * pow(c, vec3(1.0/2.4)) - 0.055;
        return mix(high, low, vec3(cutoff));
      }
      void main(){
        vec2 uv = vec2(1.0 - vUv.x, vUv.y);
        vec3 a = texture2D(map1, uv).rgb;
        vec3 b = texture2D(map2, uv).rgb;
        a = srgb_to_linear(a);
        b = srgb_to_linear(b);
        vec3 col = mix(a, b, clamp(mixAmount, 0.0, 1.0));
        col *= exposure;
        // Apply display gamma so higher gamma brightens (consistent with Exposure)
        col = pow(max(col, 1e-6), vec3(1.0 / max(gamma, 1e-6)));
        col = linear_to_srgb(col);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    toneMapped: false
  });
}

// Estimate exposure/gamma from the active image by sampling luminance
async function autoAdjust(){
  if(!currentProject) return;
  const i = Math.floor(stagePos);
  const url = (currentProject.stages?.[i]?.url) || (currentProject.stages?.[0]?.url);
  try{
    const { exposure, gamma } = await analyzeImage(url);
    setExposure(exposure);
    setGamma(gamma);
    if(statusEl) statusEl.textContent = 'Auto adjustment applied';
    showToast('Auto adjustment applied', 'success');
  }catch(err){
    console.warn('Auto adjust failed', err);
    if(statusEl) statusEl.textContent = 'Auto adjustment failed';
    showToast('Auto adjustment failed', 'error');
  }
}

function srgbToLinearScalar(c){
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

async function analyzeImage(url){
  const img = await loadImage(url);
  const w = 256;
  const h = Math.max(1, Math.round((img.height / img.width) * w));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0,0,w,h).data;
  let sum = 0;
  for(let i=0;i<data.length;i+=4){
    const r = data[i] / 255, g = data[i+1]/255, b = data[i+2]/255;
    const rl = srgbToLinearScalar(r), gl = srgbToLinearScalar(g), bl = srgbToLinearScalar(b);
    const Y = 0.2126*rl + 0.7152*gl + 0.0722*bl;
    sum += Y;
  }
  const mean = sum / (w*h);
  const target = 0.32; // even brighter middle gray target in linear space
  const exposure = Math.min(2.0, Math.max(0.5, target / Math.max(1e-6, mean)));
  const gamma = 1.2; // brighter default gamma
  return { exposure, gamma };
}

function loadImage(url){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = ()=> resolve(img);
    img.onerror = reject;
    // Allow caching so subsequent openings are instant
    img.src = url;
  });
}

async function loadStages(urls){
  // Retained for compatibility (full preloading), but buildScene uses progressive load
  const loader = new THREE.TextureLoader();
  const loadTex = (url)=> new Promise((res,rej)=> loader.load(url, (t)=> res(t), undefined, rej));
  const texs = [];
  stageVideos = [];
  for(const url of urls){
    try{
      if(/\.(mp4|webm|ogg)(\?|$)/i.test(url)){
        const video = document.createElement('video');
        video.src = url;
        video.crossOrigin = 'anonymous';
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        const tex = new THREE.VideoTexture(video);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        texs.push(tex);
        stageVideos.push(video);
      } else {
        const t = await loadTex(url);
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        texs.push(t);
        stageVideos.push(null);
      }
    }catch(err){
      console.warn('Failed to load stage', url, err);
      texs.push(texs[texs.length-1] || null);
      stageVideos.push(stageVideos[stageVideos.length-1] || null);
    }
  }
  for(let i=0;i<texs.length;i++) if(!texs[i]) { texs[i] = texs[i-1] || texs.find(Boolean); stageVideos[i] = stageVideos[i-1] || null; }
  return texs;
}

function showLoadingOverlay(show, text){
  try{
    if(loadingOverlayEl){
      // ensure overlay is top-most child over canvas
      if(container && loadingOverlayEl.parentNode !== container){ container.appendChild(loadingOverlayEl); }
      else if(container && container.lastElementChild !== loadingOverlayEl){ container.appendChild(loadingOverlayEl); }
      loadingOverlayEl.style.display = show ? 'flex' : 'none';
      const t = loadingOverlayEl.querySelector('.loading-text');
      if(t && text) t.textContent = text;
    }
  }catch{}
}

function updateProgress(){
  if(!_progressTotal) return;
  const msg = _progressLoaded >= _progressTotal ? 'Ready' : `Loading ${_progressLoaded}/${_progressTotal}…`;
  if(statusEl) statusEl.textContent = msg;
  if(loadingOverlayEl && loadingOverlayEl.style.display !== 'none'){
    const t = loadingOverlayEl.querySelector('.loading-text');
    if(t) t.textContent = msg;
  }
}

function loadOneStage(index, url){
  return new Promise((resolve)=>{
    const finish = ()=>{ _progressLoaded++; updateProgress(); resolve(); };
    try{
      if(/\.(mp4|webm|ogg)(\?|$)/i.test(url)){
        const video = document.createElement('video');
        video.src = url;
        video.crossOrigin = 'anonymous';
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        const tex = new THREE.VideoTexture(video);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        stageVideos[index] = video;
        stageTextures[index] = tex;
        finish();
      } else {
        const loader = new THREE.TextureLoader();
        loader.load(url, (t)=>{
          try{
            t.colorSpace = THREE.SRGBColorSpace;
            t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
            stageTextures[index] = t;
          }catch{}
          finish();
        }, undefined, ()=>{ finish(); });
      }
    }catch{
      finish();
    }
  });
}

function populateSideGallery(){
  if(!sideGallery) return;
  sideGallery.innerHTML = '';
  stages.forEach((s, idx)=>{
    const img = document.createElement('img');
    img.src = s.url;
    img.alt = s.label || `Stage ${idx+1}`;
    img.className = 'thumb';
    try{ img.loading = 'lazy'; img.decoding = 'async'; }catch{}
    img.addEventListener('click', ()=> setStagePos(idx));
    sideGallery.appendChild(img);
  });
}

async function buildScene({ title, stages: stageDefs }){
  scene = new THREE.Scene();
  const { clientWidth: w, clientHeight: h } = container;
  camera = new THREE.PerspectiveCamera(75, w / Math.max(1,h), 0.1, 2000);
  camera.position.set(0, 0, 0.1);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.rotateSpeed = 0.3;
  controls.addEventListener('change', ()=> {
    if(!stages.length) return;
    const ang = getAngles();
    stageOrients[currentStageIndex] = [ang.theta, ang.phi];
    saveSettings({ orients: { [currentStageIndex]: stageOrients[currentStageIndex] } });
  });

  // Determine stages list from project
  stages = Array.isArray(stageDefs) ? stageDefs.filter(s=> !!s?.url) : [];
  if(!stages.length){
    if(statusEl) statusEl.textContent = 'No images found';
    return;
  }
  // Progressive load: first show stage 0 ASAP, then fill the rest
  stageTextures = new Array(stages.length).fill(null);
  stageVideos = new Array(stages.length).fill(null);
  _progressLoaded = 0;
  _progressTotal = stages.length;

  const urls = stages.map(s=> s.url);
  // Load first stage first for immediate display
  await loadOneStage(0, urls[0]);
  if(timelineRange){
    timelineRange.min = '0';
    timelineRange.max = String(Math.max(0, stages.length-1));
    timelineRange.step = stages.length > 1 ? '0.001' : '1';
  }
  updateTimelineLegend(stages.map(s=> s.label || 'Stage'));
  updateTimelineTicks(stages.length);
  populateSideGallery();

  const texA = getTextureAt(0);
  const texB = getTextureAt(Math.min(1, stageTextures.length-1)) || texA;
  material = EquirectBlendMaterial(texA, texB);
  mixUniform = material.uniforms.mixAmount;

  const geom = new THREE.SphereGeometry(500, 64, 48);
  sphere = new THREE.Mesh(geom, material);
  scene.add(sphere);

  // Hide overlay once first frame is ready, continue background loading
  showLoadingOverlay(false);
  updateProgress();
  if(_progressLoaded >= _progressTotal){ if(statusEl) statusEl.textContent = 'Ready'; }
  if(titleEl) titleEl.textContent = title || 'Project';
  // Initialize defaults without persisting over saved settings
  setStagePos(0.0, false);
  updateInfoPanel();
  // Restore saved per-stage orientations & adjustments
  const saved = loadSettings();
  stageOrients = saved.orients || {};
  exposureByStage = saved.exposureByStage || {};
  gammaByStage = saved.gammaByStage || {};
  applySavedOrientationForStage(0);
  ensureStageOrient(0);
  applyAdjustmentsForStage(0, true);
  // start initial video(s)
  playStageMedia(0);
  animate();

  // Kick off background loading for remaining stages (including stage 1)
  const tasks = [];
  for(let i=1;i<urls.length;i++) tasks.push(loadOneStage(i, urls[i]));
  Promise.all(tasks).then(()=>{ updateProgress(); if(statusEl) statusEl.textContent = 'Ready'; playStageMedia(currentStageIndex); });
}

export async function openViewer(project){
  ensureUIRefs();
  currentProject = project;
  // project.stages should be provided by the caller (main.js discovery)

  // Show modal
  modalEl.setAttribute('aria-hidden', 'false');
  // Reset collapsed state on open (landscape/desktop)
  const g = viewerGridEl || modalEl.querySelector('.viewer-grid');
  g?.classList.remove('collapse-left','collapse-right');
  // Ensure chevrons show immediately
  syncCollapseUI();
  // Update toggle state after DOM settles
  setTimeout(()=>{ syncCollapseUI(); },0);
  document.body.classList.add('viewer-open');
  if(statusEl) statusEl.textContent = 'Loading…';
  if(titleEl) titleEl.textContent = project.title || 'Project';

  // Ensure renderer exists now that container is visible
  initRenderer();
  // Show overlay immediately while first texture prepares
  showLoadingOverlay(true, 'Loading…');
  // Block browser zoom gestures while viewer is open (mobile/tablet)
  try{
    const prevent = (e)=> { e.preventDefault(); };
    const onTouchEnd = (()=>{ let lt=0; return (e)=>{ const now=Date.now(); if(now-lt<300){ e.preventDefault(); } lt=now; }; })();
    document.addEventListener('gesturestart', prevent, { passive:false });
    document.addEventListener('gesturechange', prevent, { passive:false });
    document.addEventListener('gestureend', prevent, { passive:false });
    modalEl.addEventListener('touchend', onTouchEnd, { passive:false });
    _blockZoomHandlers = [
      ['gesturestart', prevent],['gesturechange', prevent],['gestureend', prevent],['touchend', onTouchEnd]
    ];
  }catch{}
  // Keyboard shortcuts for navigation in fullscreen/VR
  const onKey = (e)=>{
    if(e.key === 'ArrowRight') nudgeStage(+1);
    else if(e.key === 'ArrowLeft') nudgeStage(-1);
    else if(e.key === 'Escape') exitXRorFS();
  };
  window.addEventListener('keydown', onKey);
  closeViewer._onKey = onKey;

  // (Re)size renderer to container
  onResize();
  window.addEventListener('resize', onResize);

  // Dispose previous scene if any
  if(renderer) renderer.setAnimationLoop(null);
  if(scene){
    scene.traverse(obj=> {
      if(obj.isMesh){ obj.geometry?.dispose(); obj.material?.dispose?.(); }
    });
    scene = null;
  }

  try{
    await buildScene(project);
    // After camera is ready, force a resize to update aspect
    onResize();
    // Apply saved adjustments and position if present (per stage)
    const saved = loadSettings();
    // Load saved maps
    stageOrients = saved.orients || {};
    exposureByStage = saved.exposureByStage || {};
    gammaByStage = saved.gammaByStage || {};
    applySavedOrientationForStage(currentStageIndex);
    applyAdjustmentsForStage(currentStageIndex, true);
  }catch(err){
    console.error(err);
    if(statusEl) statusEl.textContent = 'Failed to load images';
  }
}

export function closeViewer(){
  if(!modalEl) return;
  modalEl.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('viewer-open');
  window.removeEventListener('resize', onResize);
  if(closeViewer._onKey){ window.removeEventListener('keydown', closeViewer._onKey); closeViewer._onKey = null; }
  if(renderer){ renderer.setAnimationLoop(null); }
  // pause any videos
  if(stageVideos && stageVideos.length){ for(const v of stageVideos){ try{ v && v.pause(); }catch{} } }
  // leave canvas & VR button mounted for faster reopen
  // Remove zoom blockers
  try{
    for(const [ev, fn] of _blockZoomHandlers){
      if(ev.startsWith('gesture')) document.removeEventListener(ev, fn, { passive:false });
      else if(ev==='touchend') modalEl?.removeEventListener(ev, fn, { passive:false });
    }
    _blockZoomHandlers = [];
  }catch{}
}
