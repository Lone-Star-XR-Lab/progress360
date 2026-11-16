// Progress360 viewer
// Renders a project's stages (equirectangular images or videos) on the inside of a sphere,
// cross-fades between stages, shows them side by side (split view), and supports per-stage
// alignment, hotspots, share/embed links and an in-browser editor (?edit).
//
// Colour pipeline (see docs/architecture.md):
//   texture (sRGB, decoded to linear by the GPU) -> stage cross-fade / split (linear)
//   -> exposure (linear, in EV stops) -> midtones / contrast / saturation (display space)
//   -> three.js output encoding (back to sRGB for the canvas / XR layer).
// With every adjustment at its default the image on screen is pixel-for-pixel the source file.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { readExif } from './exif.js';

const VIDEO_RE = /\.(mp4|webm|ogv|mov)(\?|#|$)/i;
const JPEG_RE = /\.jpe?g(\?|#|$)/i;
const isVideoUrl = (u)=> VIDEO_RE.test(u || '');

const PARAMS = new URLSearchParams(location.search);
export const EDIT_MODE = PARAMS.has('edit');
export const EMBED_MODE = PARAMS.has('embed');

const STORE_PREFIX = 'p360:v2:';            // v2: old (pre colour-fix) settings are ignored
const DRAFT_PREFIX = 'p360:draft:';
const DEFAULT_FOV = 75;
const MIN_FOV = 30;
const MAX_FOV = 100;
const TWEEN_MS = 450;          // manual stage change (‹ › / filmstrip / keys)
const PLAY_FADE_MS = 4000;     // cross-fade length while playing (slow dissolve)
const PLAY_HOLD_MS = 3000;     // how long each stage is held while playing

const signed = (v)=> `${v > 0 ? '+' : ''}${Math.round(v)}`;
export const ADJUSTMENTS = {
  exposure:   { label: 'Exposure',   min: -2,   max: 2,   step: 0.05, fmt: (v)=> `${v > 0 ? '+' : ''}${v.toFixed(2)} EV` },
  contrast:   { label: 'Contrast',   min: -50,  max: 50,  step: 1,    fmt: signed },
  midtones:   { label: 'Midtones',   min: -50,  max: 50,  step: 1,    fmt: signed },
  saturation: { label: 'Saturation', min: -100, max: 100, step: 1,    fmt: signed },
};
const DEFAULT_ADJ = { exposure: 0, contrast: 0, midtones: 0, saturation: 0 };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const ui = {};
let bound = false;
let renderer, scene, camera, controls, material;
let onRequestClose = null;
let lastFocus = null;
let saveTimer = 0;
let hintTimer = 0;
let directory = {};            // project id -> title (for hotspot links)

const state = {
  open: false,
  token: 0,              // increments per project load; stale async work checks it
  project: null,
  stages: [],
  textures: [],
  videos: [],
  failed: [],
  full: [],              // true once the full-resolution texture is in (vs. a preview)
  loaded: 0,
  pos: 0,                // float 0..stages.length-1
  index: 0,              // floor(pos)
  tween: null,           // { from, to, start, dur, wrap }
  playing: false,
  nextAt: 0,
  adj: { ...DEFAULT_ADJ },
  comparing: false,
  audio: false,
  sidebarOpen: true,
  split: { on: false, left: 0, pos: 0.5 },
  aligning: false,
  draft: null,           // editor draft: { view?, align?, hotspots? } (each replaces the project's field)
  hotspots: [],          // [{ el, dir }]
};

const narrowMQ = window.matchMedia('(max-width: 960px)');
const clamp = (v, lo, hi)=> Math.min(hi, Math.max(lo, v));
const rad = (d)=> d * Math.PI / 180;
const deg = (r)=> r * 180 / Math.PI;
const round1 = (v)=> Math.round(v * 10) / 10;

/** Let the host page decide what "close" means (e.g. clear the URL hash). */
export function setCloseHandler(fn){ onRequestClose = typeof fn === 'function' ? fn : null; }
function requestClose(){ (onRequestClose || closeViewer)(); }

/** id -> title map of all projects, used to label hotspot links. */
export function setProjectDirectory(map){ directory = { ...map }; }

// ---------------------------------------------------------------------------
// Persistence (per project, browser-local)
// ---------------------------------------------------------------------------
function storeKey(id){ return `${STORE_PREFIX}${id || 'unknown'}`; }
function loadSettings(id){
  try { return JSON.parse(localStorage.getItem(storeKey(id)) || '{}') || {}; }
  catch { return {}; }
}
function saveSoon(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
function saveNow(){
  clearTimeout(saveTimer);
  if(!state.project) return;
  const data = {
    pos: Math.round(state.pos),
    look: camera ? (({ yaw, pitch })=> [round1(yaw), round1(pitch)])(currentYawPitch()) : undefined,
    fov: camera ? camera.fov : DEFAULT_FOV,
    adj: state.adj,
  };
  try { localStorage.setItem(storeKey(state.project.id), JSON.stringify(data)); } catch {}
}
function pref(key, fallback){
  try { const v = localStorage.getItem(`p360:${key}`); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function setPref(key, value){ try { localStorage.setItem(`p360:${key}`, JSON.stringify(value)); } catch {} }

// ---------------------------------------------------------------------------
// Project data helpers (alignment, hotspots, start view; editor draft overrides)
// ---------------------------------------------------------------------------
function stageKey(i){
  const url = state.stages[i]?.url || '';
  const name = url.split(/[?#]/)[0].split('/').pop();
  try { return decodeURIComponent(name); } catch { return name; }
}
function field(name){
  if(state.draft && name in state.draft) return state.draft[name];
  return state.project?.[name];
}
function alignDeg(i){ return Number(field('align')?.[stageKey(i)]) || 0; }
function hotspotList(){ return Array.isArray(field('hotspots')) ? field('hotspots') : []; }
function startView(){
  const v = field('view') || {};
  return { yaw: Number(v.yaw) || 0, pitch: Number(v.pitch) || 0, fov: Number(v.fov) || DEFAULT_FOV };
}

// ---------------------------------------------------------------------------
// UI binding (runs once)
// ---------------------------------------------------------------------------
function bindUI(){
  if(bound) return;
  const $ = (id)=> document.getElementById(id);
  Object.assign(ui, {
    modal: $('viewerModal'),
    stageArea: $('stageArea'),
    wrap: $('viewerCanvasWrap'),
    title: $('viewerProjectTitle'),
    stageLabel: $('viewerStageLabel'),
    status: $('viewerStatus'),
    loading: $('loadingOverlay'),
    loadingText: $('loadingText'),
    dragHint: $('dragHint'),
    hotspotLayer: $('hotspotLayer'),
    splitUi: $('splitUi'),
    splitHandle: $('splitHandle'),
    splitLeft: $('splitLeft'),
    splitRight: $('splitRight'),
    range: $('timelineRange'),
    filmstrip: $('filmstrip'),
    play: $('playBtn'),
    prev: $('prevBtn'),
    next: $('nextBtn'),
    close: $('closeViewer'),
    openFull: $('openFullBtn'),
    audio: $('audioBtn'),
    split: $('splitBtn'),
    share: $('shareBtn'),
    sharePanel: $('sharePanel'),
    recenter: $('recenterBtn'),
    fullscreen: $('fullscreenBtn'),
    sidebarBtn: $('sidebarBtn'),
    sidebarClose: $('sidebarCloseBtn'),
    sidebar: $('viewerSidebar'),
    infoDesc: $('infoDesc'),
    infoTags: $('infoTags'),
    infoStage: $('infoStage'),
    infoTaken: $('infoTaken'),
    infoLocation: $('infoLocation'),
    infoPlace: $('infoPlace'),
    infoPhase: $('infoPhase'),
    infoUpdated: $('infoUpdated'),
    infoMedia: $('infoMedia'),
    adjState: $('adjState'),
    autoBtn: $('autoAdjustBtn'),
    compareBtn: $('compareBtn'),
    resetBtn: $('resetAdjustBtn'),
    editor: $('editorPanel'),
    toastHost: $('toastHost'),
  });
  if(!ui.modal || !ui.wrap) throw new Error('Viewer markup not found');
  bound = true;
  if(EMBED_MODE) document.body.classList.add('embed');

  ui.adj = {};
  for(const key of Object.keys(ADJUSTMENTS)){
    const input = $(`adj-${key}`);
    const out = $(`adj-${key}-val`);
    ui.adj[key] = { input, out };
    input?.addEventListener('input', ()=> setAdjustment(key, parseFloat(input.value)));
    input?.addEventListener('dblclick', ()=> setAdjustment(key, DEFAULT_ADJ[key]));
  }

  ui.close?.addEventListener('click', requestClose);
  ui.play?.addEventListener('click', ()=> setPlaying(!state.playing));
  ui.prev?.addEventListener('click', ()=> nudge(-1));
  ui.next?.addEventListener('click', ()=> nudge(+1));
  ui.range?.addEventListener('input', ()=> { setPlaying(false); state.tween = null; setStagePos(parseFloat(ui.range.value)); });
  ui.range?.addEventListener('change', ()=> animateTo(Math.round(parseFloat(ui.range.value))));
  ui.audio?.addEventListener('click', ()=> setAudio(!state.audio));
  ui.split?.addEventListener('click', ()=> setSplit(!state.split.on));
  ui.recenter?.addEventListener('click', recenter);
  ui.fullscreen?.addEventListener('click', toggleFullscreen);
  ui.sidebarBtn?.addEventListener('click', ()=> setSidebar(!state.sidebarOpen, true));
  ui.sidebarClose?.addEventListener('click', ()=> setSidebar(false, true));
  ui.autoBtn?.addEventListener('click', autoAdjust);
  ui.resetBtn?.addEventListener('click', ()=> { setAdjustments({ ...DEFAULT_ADJ }); showToast('Adjustments reset to original', 'info'); });

  // Hold to compare against the untouched original
  const cmpOn = (e)=> { e.preventDefault?.(); setComparing(true); };
  const cmpOff = ()=> setComparing(false);
  ui.compareBtn?.addEventListener('pointerdown', cmpOn);
  ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach((ev)=> ui.compareBtn?.addEventListener(ev, cmpOff));
  ui.compareBtn?.addEventListener('keydown', (e)=> { if((e.key === ' ' || e.key === 'Enter') && !e.repeat) cmpOn(e); });
  ui.compareBtn?.addEventListener('keyup', (e)=> { if(e.key === ' ' || e.key === 'Enter') cmpOff(); });

  // Split view: divider drag + stage pickers
  const dragSplit = (e)=>{
    const r = ui.wrap.getBoundingClientRect();
    setSplitPos((e.clientX - r.left) / r.width);
  };
  ui.splitHandle?.addEventListener('pointerdown', (e)=>{
    e.preventDefault();
    ui.splitHandle.setPointerCapture(e.pointerId);
    ui.splitHandle.addEventListener('pointermove', dragSplit);
  });
  ['pointerup', 'pointercancel'].forEach((ev)=> ui.splitHandle?.addEventListener(ev, ()=> ui.splitHandle.removeEventListener('pointermove', dragSplit)));
  ui.splitHandle?.addEventListener('keydown', (e)=>{
    if(e.key === 'ArrowLeft'){ setSplitPos(state.split.pos - 0.05); e.preventDefault(); e.stopPropagation(); }
    if(e.key === 'ArrowRight'){ setSplitPos(state.split.pos + 0.05); e.preventDefault(); e.stopPropagation(); }
  });
  ui.splitLeft?.addEventListener('change', ()=> { state.split.left = +ui.splitLeft.value; refreshTextures(); });
  ui.splitRight?.addEventListener('change', ()=> setStagePos(+ui.splitRight.value));

  // Share
  ui.share?.addEventListener('click', (e)=> { e.stopPropagation(); toggleSharePanel(); });
  ui.sharePanel?.addEventListener('click', (e)=>{
    const b = e.target.closest('button[data-share]');
    if(!b) return;
    shareAction(b.dataset.share);
    toggleSharePanel(false);
  });
  document.addEventListener('click', (e)=> { if(ui.sharePanel && !ui.sharePanel.hidden && !ui.sharePanel.contains(e.target)) toggleSharePanel(false); });

  // Zoom (field of view): wheel + pinch
  ui.wrap.addEventListener('wheel', (e)=> { e.preventDefault(); zoomBy(e.deltaY * 0.04); }, { passive: false });
  let pinch = 0;
  const dist = (t)=> Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  ui.wrap.addEventListener('touchstart', (e)=> { if(e.touches.length === 2) pinch = dist(e.touches); }, { passive: true });
  ui.wrap.addEventListener('touchmove', (e)=>{
    if(e.touches.length !== 2 || !pinch) return;
    const d = dist(e.touches);
    zoomBy((pinch - d) * 0.15);
    pinch = d;
  }, { passive: true });
  ui.wrap.addEventListener('touchend', ()=> { pinch = 0; }, { passive: true });
  ui.wrap.addEventListener('pointerdown', hideDragHint);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // Block page pinch-zoom (iOS) while the viewer is open
  const blockGesture = (e)=> { if(state.open) e.preventDefault(); };
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev)=> document.addEventListener(ev, blockGesture, { passive: false }));

  const onFsChange = ()=>{
    const on = !!fullscreenElement();
    ui.fullscreen?.setAttribute('aria-pressed', String(on));
    ui.fullscreen?.setAttribute('title', on ? 'Exit full screen (F)' : 'Full screen (F)');
    ui.modal.classList.toggle('is-fullscreen', on);
    requestAnimationFrame(onResize);
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  if(!canFullscreen() && ui.fullscreen) ui.fullscreen.hidden = true;
  if(ui.share && !navigator.share) ui.sharePanel?.querySelector('[data-share="native"]')?.setAttribute('hidden', '');

  narrowMQ.addEventListener?.('change', ()=> setSidebar(narrowMQ.matches ? false : pref('sidebar', true)));
  if(EDIT_MODE) bindEditor();
  renderAdjustmentUI();
}

// ---------------------------------------------------------------------------
// Renderer / scene (created once, reused across projects)
// ---------------------------------------------------------------------------
function initRenderer(){
  if(renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.xr.enabled = true;
  renderer.domElement.classList.add('viewer-canvas');
  ui.wrap.prepend(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.1, 2000);
  camera.position.set(0, 0, 0.1);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.rotateSpeed = 0.35;
  controls.addEventListener('change', saveSoon);

  material = createPanoMaterial();
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(500, 96, 64), material));

  if(typeof ResizeObserver !== 'undefined') new ResizeObserver(onResize).observe(ui.wrap);
  window.addEventListener('resize', onResize);

  // XR: trigger = next stage, other trigger = previous, squeeze = exit
  try{
    const c0 = renderer.xr.getController(0);
    const c1 = renderer.xr.getController(1);
    c0.addEventListener('select', ()=> nudge(+1));
    c1.addEventListener('select', ()=> nudge(-1));
    c0.addEventListener('squeeze', endXR);
    c1.addEventListener('squeeze', endXR);
    scene.add(c0, c1);
  }catch{}
  renderer.xr.addEventListener('sessionstart', ()=> { setSplit(false); stopAligning(); });

  // Only show the VR button where immersive VR is actually available
  navigator.xr?.isSessionSupported?.('immersive-vr').then((ok)=>{
    if(!ok) return;
    const host = document.createElement('div');
    host.className = 'vr-button-host';
    const btn = VRButton.createButton(renderer);
    btn.removeAttribute('style');
    btn.className = 'btn vr-btn';
    host.appendChild(btn);
    ui.wrap.appendChild(host);
  }).catch(()=>{});
}

function createPanoMaterial(){
  return new THREE.ShaderMaterial({
    uniforms: {
      map1: { value: null },
      map2: { value: null },
      off1: { value: 0 },         // per-stage alignment (fraction of a full turn)
      off2: { value: 0 },
      mixAmount: { value: 0 },
      split: { value: -1 },       // split-view divider in device pixels; <0 = off
      exposure: { value: 0 },     // EV stops
      contrast: { value: 1 },     // multiplier around mid grey
      midtones: { value: 1 },     // gamma exponent (<1 brightens)
      saturation: { value: 1 },   // multiplier
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D map1;
      uniform sampler2D map2;
      uniform float off1;
      uniform float off2;
      uniform float mixAmount;
      uniform float split;
      uniform float exposure;
      uniform float contrast;
      uniform float midtones;
      uniform float saturation;

      vec3 toDisplay(vec3 c){
        c = max(c, 0.0);
        return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
      }
      vec3 toLinear(vec3 c){
        c = max(c, 0.0);
        return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045))));
      }

      void main(){
        vec2 uv = vec2(1.0 - vUv.x, vUv.y);
        // Textures are tagged sRGB, so the GPU hands us linear values here. Do NOT decode again.
        vec3 a = texture2D(map1, vec2(uv.x + off1, uv.y)).rgb;
        vec3 b = texture2D(map2, vec2(uv.x + off2, uv.y)).rgb;
        float m = split >= 0.0 ? step(split, gl_FragCoord.x) : clamp(mixAmount, 0.0, 1.0);
        vec3 col = mix(a, b, m);
        col *= exp2(exposure);

        // Tone controls feel natural in display (perceptual) space
        vec3 d = clamp(toDisplay(col), 0.0, 1.0);
        d = pow(d, vec3(midtones));
        d = (d - 0.5) * contrast + 0.5;
        float l = dot(d, vec3(0.2126, 0.7152, 0.0722));
        d = mix(vec3(l), d, saturation);

        gl_FragColor = vec4(toLinear(clamp(d, 0.0, 1.0)), 1.0);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
  });
}

function configureTexture(t){
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;           // seamless 0/360° join, and lets alignment wrap around
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.needsUpdate = true;
  return t;
}

function render(){
  const now = performance.now();
  if(state.tween){
    const { from, to, start, dur, wrap } = state.tween;
    const k = clamp((now - start) / dur, 0, 1);
    // Long playback fades use a gentle sine curve; short manual steps use a snappier quad
    const e = dur > TWEEN_MS * 2
      ? 0.5 - Math.cos(Math.PI * k) / 2
      : (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
    if(wrap && k < 1){
      // Last stage → first stage: fade directly instead of rewinding through every stage
      setSlots(from, to);
      material.uniforms.mixAmount.value = e;
    } else {
      setStagePos(from + (to - from) * e, { persist: k >= 1 });
    }
    if(k >= 1){
      state.tween = null;
      if(state.playing) holdStage(now);
    }
  } else if(state.playing && now >= state.nextAt){
    advancePlayback(now);
  }
  controls.update();
  if(state.hotspots.length) positionHotspots();
  renderer.render(scene, camera);
}

function onResize(){
  if(!renderer || !ui.wrap) return;
  const w = Math.max(1, Math.floor(ui.wrap.clientWidth));
  const h = Math.max(1, Math.floor(ui.wrap.clientHeight));
  if(renderer.xr.isPresenting) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if(state.split.on) refreshTextures();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
const headCache = new Map();
function headExists(url){
  if(!headCache.has(url)){
    headCache.set(url, fetch(url, { method: 'HEAD' }).then((r)=> r.ok).catch(()=> false));
  }
  return headCache.get(url);
}

// Phones and GPUs limited to 4096 px textures get the <name>-4k.jpg variant when it exists
function preferSmall(){
  return renderer.capabilities.maxTextureSize <= 4096 || window.matchMedia('(max-width: 900px)').matches;
}

function loadTexture(url){
  return new Promise((resolve)=> new THREE.TextureLoader().load(url, (t)=> resolve(configureTexture(t)), undefined, ()=> resolve(null)));
}

async function loadStage(i, url, token, { preview = false } = {}){
  const stale = ()=> token !== state.token;
  const accept = (tex, video, isFull)=>{
    const prev = state.textures[i];
    if(prev && prev !== tex) prev.dispose();
    state.textures[i] = tex || null;
    state.videos[i] = video || null;
    state.full[i] = !!isFull;
    refreshTextures();
    syncMedia();
    updateFilmstrip();
  };
  const finish = (tex, video)=>{
    if(stale()){ tex?.dispose(); disposeVideo(video); return; }
    if(tex) accept(tex, video, true);
    else if(!state.textures[i]) state.failed[i] = true;
    state.loaded++;
    updateProgress();
    updateFilmstrip();
  };

  if(isVideoUrl(url)){
    await new Promise((resolve)=>{
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.loop = true;
      v.muted = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.preload = 'auto';
      v.src = url;
      let settled = false;
      const tex = configureTexture(new THREE.VideoTexture(v));
      v.addEventListener('error', ()=>{
        if(settled){ // failed after we had already accepted it
          if(state.textures[i] === tex){ state.failed[i] = true; state.textures[i] = null; tex.dispose(); refreshTextures(); updateFilmstrip(); }
          return;
        }
        settled = true; tex.dispose(); finish(null, null); resolve();
      }, { once: true });
      const ok = ()=> { if(!settled){ settled = true; finish(tex, v); resolve(); } };
      v.addEventListener('loadeddata', ok, { once: true });
      setTimeout(ok, 2500);          // some mobile browsers won't fire loadeddata until play()
      try { v.load(); } catch {}
    });
    return;
  }

  let src = url;
  if(JPEG_RE.test(url) && preferSmall()){
    const small = url.replace(/\.jpe?g(?=([?#]|$))/i, '-4k.jpg');
    if(await headExists(small)) src = small;
    if(stale()) return;
  }
  // Show the small card thumbnail first (if there is one) while the full panorama downloads
  if(preview && JPEG_RE.test(url)){
    const thumbUrl = url.replace(/\.jpe?g(?=([?#]|$))/i, '-thumb.jpg');
    const fullP = loadTexture(src);
    if(await headExists(thumbUrl)){
      const thumb = await Promise.race([loadTexture(thumbUrl), fullP.then(()=> null)]);
      if(thumb && !stale() && !state.full[i]){
        accept(thumb, null, false);
        showLoading(false);
        if(ui.status){ ui.status.hidden = false; ui.status.textContent = 'Loading full resolution…'; }
      } else thumb?.dispose();
    }
    finish(await fullP, null);
    return;
  }
  finish(await loadTexture(src), null);
}

function disposeVideo(v){
  if(!v) return;
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
}

function teardownProject(){
  state.tween = null;
  state.textures.forEach((t)=> t?.dispose());
  state.videos.forEach(disposeVideo);
  state.textures = []; state.videos = []; state.failed = []; state.full = [];
  state.loaded = 0;
  state.split.on = false;
  state.aligning = false;
  ui.modal?.classList.remove('is-split', 'is-aligning');
  if(material){ material.uniforms.map1.value = null; material.uniforms.map2.value = null; material.uniforms.split.value = -1; }
  if(ui.filmstrip) ui.filmstrip.replaceChildren();
  clearHotspots();
}

function updateProgress(){
  const n = state.stages.length;
  const loading = state.loaded < n;
  if(ui.status){
    ui.status.textContent = loading ? `Loading ${state.loaded}/${n}…` : '';
    ui.status.hidden = !loading;
  }
  const anyReady = state.textures.some(Boolean);
  if(anyReady) showLoading(false);
  else if(!loading) showLoading(true, 'This project’s media could not be loaded.', true);
  if(!loading){
    const bad = state.failed.filter(Boolean).length;
    if(bad && anyReady) showToast(`${bad} stage${bad > 1 ? 's' : ''} could not be loaded`, 'error', 4000);
  }
}

function showLoading(show, text, isError = false){
  if(!ui.loading) return;
  ui.loading.hidden = !show;
  ui.loading.classList.toggle('is-error', !!isError);
  if(text && ui.loadingText) ui.loadingText.textContent = text;
}

// Index of the nearest stage that has a texture (stages stream in), or -1
function loadedIndexNear(i){
  const t = state.textures;
  if(t[i]) return i;
  for(let d = 1; d < t.length; d++){
    if(t[i - d]) return i - d;
    if(t[i + d]) return i + d;
  }
  return -1;
}

function setSlots(i, j){
  const u = material.uniforms;
  const a = loadedIndexNear(i);
  const b = loadedIndexNear(j);
  const bb = b < 0 ? a : b;
  u.map1.value = a < 0 ? null : state.textures[a];
  u.map2.value = bb < 0 ? null : state.textures[bb];
  u.off1.value = a < 0 ? 0 : alignDeg(a) / 360;
  u.off2.value = bb < 0 ? 0 : alignDeg(bb) / 360;
}

function refreshTextures(){
  if(!material) return;
  const u = material.uniforms;
  const n = state.stages.length;
  if(state.split.on){
    setSlots(state.split.left, state.index);
    u.mixAmount.value = 0;
    u.split.value = state.split.pos * renderer.domElement.width;
    return;
  }
  u.split.value = -1;
  if(state.aligning && state.index > 0){
    setSlots(state.index - 1, state.index);
    u.mixAmount.value = 0.5;
    return;
  }
  setSlots(state.index, Math.min(state.index + 1, n - 1));
  u.mixAmount.value = state.pos - state.index;
}

// ---------------------------------------------------------------------------
// Stages / timeline
// ---------------------------------------------------------------------------
function setStagePos(v, { persist = true } = {}){
  const n = state.stages.length;
  if(!n) return;
  const pos = clamp(v, 0, n - 1);
  const index = Math.min(n - 1, Math.floor(pos + 1e-6));
  const changed = index !== state.index;
  state.pos = pos;
  state.index = index;
  if(ui.range){
    ui.range.value = String(pos);
    ui.range.style.setProperty('--fill-to', `${n > 1 ? (pos / (n - 1)) * 100 : 0}%`);
  }
  refreshTextures();
  if(changed) syncMedia();
  updateStageUI();
  if(persist) saveSoon();
}

function animateTo(target, dur = TWEEN_MS){
  const n = state.stages.length;
  if(!n) return;
  const to = clamp(Math.round(target), 0, n - 1);
  if(Math.abs(to - state.pos) < 1e-3){ setStagePos(to); return; }
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if(reduce || !state.open || state.split.on || state.aligning){ setStagePos(to); return; }
  state.tween = { from: state.pos, to, start: performance.now(), dur };
}

// ---------------------------------------------------------------------------
// Playback: fade through the stages in order, hold on each, loop back to the start
// ---------------------------------------------------------------------------
function setPlaying(on){
  const n = state.stages.length;
  on = !!on && n > 1 && !state.split.on && !state.aligning;
  if(state.playing === on) return;
  state.playing = on;
  ui.play?.setAttribute('aria-pressed', String(on));
  ui.play?.setAttribute('title', on ? 'Pause (Space)' : 'Play through stages (Space)');
  ui.play?.setAttribute('aria-label', on ? 'Pause' : 'Play through stages');
  ui.modal?.classList.toggle('is-playing', on);
  if(on){
    state.nextAt = performance.now() + 350;
    if(!state.tween) showHold(350);
  } else {
    clearHold();
  }
}

function advancePlayback(now){
  const n = state.stages.length;
  let next = (nearestIndex() + 1) % n;
  for(let tries = 0; tries < n && state.failed[next]; tries++) next = (next + 1) % n;
  if(!state.textures[next]){ state.nextAt = now + 250; return; }
  clearHold();
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if(next < nearestIndex() && !reduce){
    state.tween = { from: nearestIndex(), to: next, start: now, dur: PLAY_FADE_MS, wrap: true };
    const v = state.videos[next];
    if(v){ v.muted = true; safePlay(v); }
    return;
  }
  animateTo(next, PLAY_FADE_MS);
  if(!state.tween) holdStage(now);
}

function holdStage(now){
  state.nextAt = now + PLAY_HOLD_MS;
  showHold(PLAY_HOLD_MS);
}

function showHold(ms){
  clearHold();
  const el = ui.filmstrip?.children[nearestIndex()];
  if(!el) return;
  el.style.setProperty('--hold', `${ms}ms`);
  void el.offsetWidth;
  el.classList.add('is-holding');
}
function clearHold(){
  ui.filmstrip?.querySelectorAll('.is-holding').forEach((el)=> el.classList.remove('is-holding'));
}

function nudge(dir){
  setPlaying(false);
  const base = state.tween ? state.tween.to : state.pos;
  const target = dir > 0 ? Math.floor(base + 1e-6) + 1 : Math.ceil(base - 1e-6) - 1;
  animateTo(target);
}

function nearestIndex(){ return clamp(Math.round(state.pos), 0, Math.max(0, state.stages.length - 1)); }

let lastUiKey = '';
function updateStageUI(force = false){
  const n = state.stages.length;
  const i = nearestIndex();
  const stage = state.stages[i];
  if(ui.prev) ui.prev.disabled = state.pos <= 0.001;
  if(ui.next) ui.next.disabled = state.pos >= n - 1.001;
  // Everything below only needs to change when the nearest stage changes (not every tween frame)
  const key = `${state.token}:${n}:${i}`;
  if(key === lastUiKey && !force) return;
  lastUiKey = key;
  if(ui.stageLabel) ui.stageLabel.textContent = n ? `${stage?.label || `Stage ${i + 1}`} · ${i + 1} of ${n}` : '';
  if(ui.filmstrip){
    const items = ui.filmstrip.children;
    for(let k = 0; k < items.length; k++){
      const active = k === i;
      if(items[k].classList.contains('is-active') !== active){
        items[k].classList.toggle('is-active', active);
        items[k].setAttribute('aria-current', active ? 'step' : 'false');
        if(active) items[k].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
    }
  }
  if(ui.splitRight) ui.splitRight.value = String(i);
  updateAudioUI();
  updateInfo();
  buildHotspots();
  if(EDIT_MODE) renderEditor();
}

function stageLabel(i){ return state.stages[i]?.label || `Stage ${i + 1}`; }

function buildFilmstrip(){
  if(!ui.filmstrip) return;
  const frag = document.createDocumentFragment();
  state.stages.forEach((s, idx)=>{
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'film';
    b.title = stageLabel(idx);
    b.addEventListener('click', ()=> { setPlaying(false); animateTo(idx); });
    let media;
    if(isVideoUrl(s.url)){
      media = document.createElement('video');
      media.muted = true; media.playsInline = true; media.preload = 'metadata';
      media.src = `${s.url}#t=0.5`;
    } else {
      media = document.createElement('img');
      media.src = s.url.replace(/\.jpe?g(?=([?#]|$))/i, '-thumb.jpg');
      media.onerror = ()=> { media.onerror = null; media.src = s.url; };   // no thumb: use the full image
      media.alt = '';
      media.loading = 'lazy';
      media.decoding = 'async';
    }
    media.className = 'film-media';
    const label = document.createElement('span');
    label.className = 'film-label';
    label.textContent = stageLabel(idx);
    b.append(media, label);
    if(isVideoUrl(s.url)){
      const tag = document.createElement('span');
      tag.className = 'film-tag';
      tag.textContent = 'Video';
      b.appendChild(tag);
    }
    frag.appendChild(b);
  });
  ui.filmstrip.replaceChildren(frag);

  // Split-view pickers
  for(const sel of [ui.splitLeft, ui.splitRight]){
    if(!sel) continue;
    sel.replaceChildren(...state.stages.map((_, i)=> new Option(stageLabel(i), String(i))));
  }
}

function updateFilmstrip(){
  if(!ui.filmstrip) return;
  [...ui.filmstrip.children].forEach((el, i)=>{
    el.classList.toggle('is-failed', !!state.failed[i]);
    el.classList.toggle('is-pending', !state.textures[i] && !state.failed[i]);
  });
}

// ---------------------------------------------------------------------------
// Split view (side-by-side compare)
// ---------------------------------------------------------------------------
function setSplit(on){
  const n = state.stages.length;
  on = !!on && n > 1 && !renderer?.xr?.isPresenting;
  if(on){
    setPlaying(false);
    stopAligning();
    state.tween = null;
    if(state.split.left >= n) state.split.left = 0;
    let right = nearestIndex();
    if(right === state.split.left) right = state.split.left === n - 1 ? 0 : n - 1;
    state.split.on = true;
    if(ui.splitLeft) ui.splitLeft.value = String(state.split.left);
    setStagePos(right);
  } else {
    state.split.on = false;
  }
  ui.modal?.classList.toggle('is-split', state.split.on);
  ui.split?.setAttribute('aria-pressed', String(state.split.on));
  if(ui.splitUi) ui.splitUi.hidden = !state.split.on;
  setSplitPos(state.split.pos);
  refreshTextures();
}

function setSplitPos(p){
  state.split.pos = clamp(p, 0.02, 0.98);
  if(ui.splitUi) ui.splitUi.style.setProperty('--split', `${state.split.pos * 100}%`);
  if(state.split.on) refreshTextures();
}

// ---------------------------------------------------------------------------
// Video + audio
// ---------------------------------------------------------------------------
function syncMedia(){
  const vids = state.videos;
  if(!vids.some(Boolean)) return;
  const a = state.index;
  const b = state.split.on ? state.split.left : (state.pos - a > 0.001 ? a + 1 : a);
  vids.forEach((v, i)=>{
    if(!v) return;
    if(i === a || i === b){
      v.muted = !(state.audio && i === nearestIndex());
      if(state.open) safePlay(v); else v.pause();
    } else {
      v.muted = true;
      v.pause();
    }
  });
}

function safePlay(v){
  if(!v.paused) return;
  try { const p = v.play(); p?.catch?.(()=>{}); } catch {}
}

function setAudio(on){
  state.audio = !!on;
  syncMedia();
  updateAudioUI();
  showToast(state.audio ? 'Sound on' : 'Sound off', 'info', 1400);
}

function updateAudioUI(){
  if(!ui.audio) return;
  const anyVideo = state.stages.some((s)=> isVideoUrl(s.url));
  ui.audio.hidden = !anyVideo;
  const here = isVideoUrl(state.stages[nearestIndex()]?.url);
  ui.audio.disabled = !here;
  ui.audio.setAttribute('aria-pressed', String(state.audio));
  ui.audio.classList.toggle('is-on', state.audio);
  ui.audio.title = here ? (state.audio ? 'Mute (M)' : 'Unmute (M)') : 'No audio for this stage';
  ui.audio.classList.toggle('attn', here && !state.audio);
}

// ---------------------------------------------------------------------------
// Camera: yaw/pitch in degrees. yaw 0 = the panorama's centre, positive = to the right;
// pitch positive = up. Hotspots, start views and share links all use this convention.
// ---------------------------------------------------------------------------
function dirFromYawPitch(yaw, pitch){
  const y = rad(yaw), p = rad(pitch);
  return new THREE.Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
}
function currentYawPitch(){
  const d = camera.position.clone().negate().normalize();
  return { yaw: deg(Math.atan2(d.x, -d.z)), pitch: deg(Math.asin(clamp(d.y, -1, 1))) };
}
function lookAt(yaw, pitch){
  if(!camera || !controls) return;
  camera.position.copy(dirFromYawPitch(yaw, clamp(pitch, -89, 89)).multiplyScalar(-0.1));
  controls.update();
}
function recenter(){
  const v = startView();
  lookAt(v.yaw, v.pitch);
  setFov(v.fov);
  saveSoon();
}
function setFov(f){
  if(!camera) return;
  camera.fov = clamp(f, MIN_FOV, MAX_FOV);
  camera.updateProjectionMatrix();
}
function zoomBy(delta){ setFov(camera.fov + delta); saveSoon(); }

// ---------------------------------------------------------------------------
// Hotspots
// projects.json: "hotspots": [{ "yaw": 30, "pitch": -5, "title": "New lighting", "text": "…",
//                              "link": "<project id>", "stage": "<file name>" }]
// `stage` limits a hotspot to one stage; `link` adds a button that opens another project.
// ---------------------------------------------------------------------------
function clearHotspots(){
  state.hotspots = [];
  ui.hotspotLayer?.replaceChildren();
}

function buildHotspots(){
  clearHotspots();
  if(!ui.hotspotLayer || !state.stages.length) return;
  const key = stageKey(nearestIndex());
  hotspotList().forEach((h, idx)=>{
    if(h.stage && h.stage !== key) return;
    if(!Number.isFinite(+h.yaw)) return;
    const el = document.createElement('div');
    el.className = 'hotspot';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hotspot-dot';
    btn.setAttribute('aria-label', h.title || 'Point of interest');
    btn.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span');
    label.className = 'hotspot-label';
    label.textContent = h.title || '';
    const pop = document.createElement('div');
    pop.className = 'hotspot-pop';
    pop.hidden = true;
    if(h.title){ const t = document.createElement('strong'); t.textContent = h.title; pop.appendChild(t); }
    if(h.text){ const p = document.createElement('p'); p.textContent = h.text; pop.appendChild(p); }
    if(h.link){
      const a = document.createElement('a');
      a.href = `#/${encodeURIComponent(h.link)}`;
      a.className = 'btn';
      a.textContent = `Go to ${directory[h.link] || h.link} →`;
      pop.appendChild(a);
    }
    if(EDIT_MODE){
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'btn ghost small'; rm.textContent = 'Remove (editor)';
      rm.addEventListener('click', ()=> editRemoveHotspot(idx));
      pop.appendChild(rm);
    }
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const open = pop.hidden;
      ui.hotspotLayer.querySelectorAll('.hotspot-pop').forEach((p)=> { p.hidden = true; });
      ui.hotspotLayer.querySelectorAll('.hotspot-dot').forEach((b)=> b.setAttribute('aria-expanded', 'false'));
      pop.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });
    el.append(btn, label, pop);
    ui.hotspotLayer.appendChild(el);
    state.hotspots.push({ el, dir: dirFromYawPitch(+h.yaw, +h.pitch || 0) });
  });
}

const _v = new THREE.Vector3();
const _look = new THREE.Vector3();
function positionHotspots(){
  const w = ui.wrap.clientWidth, h = ui.wrap.clientHeight;
  camera.getWorldDirection(_look);
  for(const hs of state.hotspots){
    const facing = hs.dir.dot(_look);
    _v.copy(hs.dir).multiplyScalar(100).project(camera);
    const visible = facing > 0.05 && Math.abs(_v.x) <= 1.1 && Math.abs(_v.y) <= 1.1;
    hs.el.style.visibility = visible ? 'visible' : 'hidden';
    if(visible) hs.el.style.transform = `translate(${((_v.x + 1) / 2) * w}px, ${((1 - _v.y) / 2) * h}px)`;
  }
}

// ---------------------------------------------------------------------------
// Adjustments (shared by every stage of a project so before/after stay comparable)
// ---------------------------------------------------------------------------
function setAdjustment(key, value){
  if(!(key in ADJUSTMENTS) || !Number.isFinite(value)) return;
  const d = ADJUSTMENTS[key];
  setAdjustments({ ...state.adj, [key]: clamp(value, d.min, d.max) });
}

function setAdjustments(next, { persist = true } = {}){
  state.adj = { ...DEFAULT_ADJ, ...next };
  applyAdjustments();
  renderAdjustmentUI();
  if(persist) saveSoon();
}

function isNeutral(a){ return Object.keys(DEFAULT_ADJ).every((k)=> Math.abs((a[k] ?? 0) - DEFAULT_ADJ[k]) < 1e-6); }

function applyAdjustments(){
  if(!material) return;
  const a = state.comparing ? DEFAULT_ADJ : state.adj;
  const u = material.uniforms;
  u.exposure.value = a.exposure;
  u.contrast.value = 1 + a.contrast / 100;
  u.midtones.value = Math.pow(2, -a.midtones / 50);
  u.saturation.value = 1 + a.saturation / 100;
}

function renderAdjustmentUI(){
  if(!ui.adj) return;
  for(const [key, d] of Object.entries(ADJUSTMENTS)){
    const { input, out } = ui.adj[key] || {};
    const v = state.adj[key] ?? 0;
    if(input){
      input.value = String(v);
      const pct = ((v - d.min) / (d.max - d.min)) * 100;
      const zero = ((0 - d.min) / (d.max - d.min)) * 100;
      input.style.setProperty('--fill-from', `${Math.min(pct, zero)}%`);
      input.style.setProperty('--fill-to', `${Math.max(pct, zero)}%`);
    }
    if(out){
      out.textContent = d.fmt(v);
      out.classList.toggle('is-changed', Math.abs(v) > 1e-6);
    }
  }
  const neutral = isNeutral(state.adj);
  if(ui.adjState){
    ui.adjState.textContent = state.comparing ? 'Showing original' : (neutral ? 'Original' : 'Adjusted');
    ui.adjState.classList.toggle('is-adjusted', !neutral && !state.comparing);
  }
  if(ui.resetBtn) ui.resetBtn.disabled = neutral;
  if(ui.compareBtn) ui.compareBtn.disabled = neutral;
}

function setComparing(on){
  if(state.comparing === !!on) return;
  state.comparing = !!on;
  ui.compareBtn?.classList.toggle('is-active', state.comparing);
  applyAdjustments();
  renderAdjustmentUI();
}

// Suggest a gentle exposure/contrast correction from all loaded stages (averaged, so every
// stage gets the same treatment). Only runs when the user asks for it.
async function autoAdjust(){
  const sources = state.textures.map((t)=> t?.image).filter(Boolean);
  if(!sources.length){ showToast('Wait for the images to finish loading', 'info'); return; }
  try{
    const W = 256, H = 128;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let logSum = 0, count = 0;
    const lumas = [];
    for(const src of sources){
      if(src instanceof HTMLVideoElement && src.readyState < 2) continue;
      ctx.drawImage(src, 0, 0, W, H);
      const y0 = Math.floor(H * 0.2), y1 = Math.ceil(H * 0.8);   // skip the stretched poles
      const data = ctx.getImageData(0, y0, W, y1 - y0).data;
      for(let p = 0; p < data.length; p += 16){
        const r = srgbToLinear(data[p] / 255), g = srgbToLinear(data[p + 1] / 255), b = srgbToLinear(data[p + 2] / 255);
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        logSum += Math.log(1e-4 + Y);
        lumas.push(Y);
        count++;
      }
    }
    if(!count) throw new Error('no pixels');
    const key = Math.exp(logSum / count);
    const exposure = roundTo(clamp(Math.log2(0.18 / key) * 0.7, -1.5, 1.5), 0.05);
    lumas.sort((a, b)=> a - b);
    const lo = linearToSrgb(lumas[Math.floor(lumas.length * 0.05)] * Math.pow(2, exposure));
    const hi = linearToSrgb(lumas[Math.floor(lumas.length * 0.95)] * Math.pow(2, exposure));
    const spread = clamp(hi, 0, 1) - clamp(lo, 0, 1);
    const contrast = Math.round(clamp((0.75 / Math.max(spread, 0.05) - 1) * 25, 0, 20));
    setAdjustments({ ...state.adj, exposure, contrast, midtones: 0 });
    showToast(`Auto: ${ADJUSTMENTS.exposure.fmt(exposure)}, contrast ${signed(contrast)}`, 'success');
  }catch(err){
    console.warn('Auto adjust failed', err);
    showToast('Auto adjust is not available for this media', 'error');
  }
}
const roundTo = (v, s)=> Math.round(v / s) * s;
const srgbToLinear = (c)=> c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const linearToSrgb = (c)=> c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------
function toggleSharePanel(force){
  if(!ui.sharePanel) return;
  const open = force ?? ui.sharePanel.hidden;
  ui.sharePanel.hidden = !open;
  ui.share?.setAttribute('aria-expanded', String(open));
}

function shareUrl({ embed = false } = {}){
  const { yaw, pitch } = currentYawPitch();
  const base = `${location.origin}${location.pathname}`;
  const id = encodeURIComponent(state.project?.id || '');
  if(embed) return `${base}?embed=1#/${id}`;
  const q = new URLSearchParams({ stage: String(nearestIndex() + 1), yaw: String(Math.round(yaw)), pitch: String(Math.round(pitch)) });
  return `${base}#/${id}?${q}`;
}

async function copyText(text, okMsg){
  try { await navigator.clipboard.writeText(text); showToast(okMsg, 'success'); return; }
  catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  if(ok) showToast(okMsg, 'success'); else window.prompt('Copy this:', text);
}

function shareAction(kind){
  if(kind === 'link') copyText(shareUrl(), 'Link copied — it opens this stage and view');
  else if(kind === 'embed'){
    const code = `<iframe src="${shareUrl({ embed: true })}" title="${(state.project?.title || 'Progress360').replace(/"/g, '&quot;')}" width="100%" height="480" style="border:0;border-radius:12px" allow="fullscreen; xr-spatial-tracking" allowfullscreen></iframe>`;
    copyText(code, 'Embed code copied');
  } else if(kind === 'native' && navigator.share){
    navigator.share({ title: state.project?.title || 'Progress360', url: shareUrl() }).catch(()=>{});
  }
}

// ---------------------------------------------------------------------------
// Editor (?edit): alignment, start view and hotspots. Changes are kept as a draft in this
// browser and exported as JSON to paste into the project's entry in projects.json.
// ---------------------------------------------------------------------------
const ed = {};
function bindEditor(){
  if(!ui.editor) return;
  ui.editor.hidden = false;
  const $ = (id)=> document.getElementById(id);
  Object.assign(ed, {
    alignBtn: $('edAlignBtn'), alignBox: $('edAlignBox'), alignLabel: $('edAlignLabel'),
    alignRange: $('edAlignRange'), alignVal: $('edAlignVal'),
    viewBtn: $('edViewBtn'), hsTitle: $('edHsTitle'), hsText: $('edHsText'), hsLink: $('edHsLink'),
    hsStage: $('edHsStage'), hsAdd: $('edHsAdd'), hsList: $('edHsList'),
    json: $('edJson'), copy: $('edCopy'), discard: $('edDiscard'),
  });
  ed.alignBtn?.addEventListener('click', ()=> state.aligning ? stopAligning() : startAligning());
  ed.alignRange?.addEventListener('input', ()=> setAlign(parseFloat(ed.alignRange.value)));
  document.querySelectorAll('[data-align-step]').forEach((b)=> b.addEventListener('click', ()=>{
    setAlign(alignDeg(nearestIndex()) + parseFloat(b.dataset.alignStep));
  }));
  ed.viewBtn?.addEventListener('click', ()=>{
    const { yaw, pitch } = currentYawPitch();
    editDraft('view', { yaw: round1(yaw), pitch: round1(pitch), fov: Math.round(camera.fov) });
    showToast('Start view set (draft)', 'success');
  });
  ed.hsAdd?.addEventListener('click', ()=>{
    const { yaw, pitch } = currentYawPitch();
    const h = { yaw: round1(yaw), pitch: round1(pitch), title: ed.hsTitle.value.trim() || 'Point of interest' };
    if(ed.hsText.value.trim()) h.text = ed.hsText.value.trim();
    if(ed.hsLink.value) h.link = ed.hsLink.value;
    if(ed.hsStage.checked) h.stage = stageKey(nearestIndex());
    editDraft('hotspots', [...hotspotList(), h]);
    ed.hsTitle.value = ''; ed.hsText.value = '';
    showToast('Hotspot added at the centre of the view (draft)', 'success');
  });
  ed.copy?.addEventListener('click', ()=> copyText(ed.json.value, 'JSON copied — paste it into this project in projects.json'));
  ed.discard?.addEventListener('click', ()=>{
    if(!confirm('Discard all draft edits for this project?')) return;
    state.draft = null;
    try { localStorage.removeItem(DRAFT_PREFIX + state.project.id); } catch {}
    stopAligning();
    refreshTextures(); buildHotspots(); renderEditor();
  });
}

function editDraft(name, value){
  state.draft = { ...(state.draft || {}), [name]: value };
  try { localStorage.setItem(DRAFT_PREFIX + state.project.id, JSON.stringify(state.draft)); } catch {}
  refreshTextures();
  buildHotspots();
  renderEditor();
}

function editRemoveHotspot(idx){
  const list = hotspotList().slice();
  list.splice(idx, 1);
  editDraft('hotspots', list);
}

function startAligning(){
  const i = nearestIndex();
  if(i < 1){ showToast('Go to a later stage first — it is aligned to the stage before it', 'info'); return; }
  setPlaying(false);
  setSplit(false);
  state.tween = null;
  setStagePos(i);
  state.aligning = true;
  ui.modal.classList.add('is-aligning');
  refreshTextures();
  renderEditor();
}
function stopAligning(){
  if(!state.aligning) return;
  state.aligning = false;
  ui.modal?.classList.remove('is-aligning');
  refreshTextures();
  if(EDIT_MODE) renderEditor();
}
function setAlign(v){
  if(!Number.isFinite(v)) return;
  v = ((v + 540) % 360) - 180;            // keep in -180..180
  const align = { ...(field('align') || {}) };
  const key = stageKey(nearestIndex());
  if(Math.abs(v) < 0.01) delete align[key]; else align[key] = round1(v);
  editDraft('align', align);
}

function renderEditor(){
  if(!EDIT_MODE || !ui.editor || !state.project) return;
  const i = nearestIndex();
  if(ed.alignBtn){
    ed.alignBtn.textContent = state.aligning ? 'Done aligning' : 'Align this stage';
    ed.alignBtn.disabled = i < 1 && !state.aligning;
  }
  if(ed.alignBox) ed.alignBox.hidden = !state.aligning;
  if(ed.alignLabel) ed.alignLabel.textContent = `Rotate “${stageLabel(i)}” until it lines up with “${stageLabel(i - 1)}” (shown 50/50).`;
  const a = alignDeg(i);
  if(ed.alignRange) ed.alignRange.value = String(a);
  if(ed.alignVal) ed.alignVal.textContent = `${a > 0 ? '+' : ''}${a.toFixed(1)}°`;
  if(ed.hsLink && ed.hsLink.options.length !== Object.keys(directory).length + 1){
    ed.hsLink.replaceChildren(new Option('— no link —', ''),
      ...Object.entries(directory).filter(([id])=> id !== state.project.id).map(([id, t])=> new Option(t, id)));
  }
  if(ed.hsList){
    ed.hsList.replaceChildren(...hotspotList().map((h, idx)=>{
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = `${h.title || 'Point'}${h.stage ? ` · ${h.stage}` : ''}${h.link ? ` → ${h.link}` : ''}`;
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'icon-btn small'; rm.textContent = '×';
      rm.setAttribute('aria-label', `Remove ${h.title || 'hotspot'}`);
      rm.addEventListener('click', ()=> editRemoveHotspot(idx));
      li.append(span, rm);
      return li;
    }));
  }
  if(ed.json){
    const out = {};
    const view = field('view'); if(view) out.view = view;
    const align = field('align'); if(align && Object.keys(align).length) out.align = align;
    const hs = hotspotList(); if(hs.length) out.hotspots = hs;
    ed.json.value = Object.keys(out).length
      ? JSON.stringify(out, null, 2).replace(/^\{\n|\n\}$/g, '') + ','
      : '// Nothing yet: align a stage, set a start view or add a hotspot.';
  }
  ui.editor.classList.toggle('has-draft', !!state.draft);
}

// ---------------------------------------------------------------------------
// Sidebar, fullscreen, XR, keyboard, hint, toasts
// ---------------------------------------------------------------------------
function setSidebar(open, remember = false){
  state.sidebarOpen = !!open;
  ui.modal?.classList.toggle('sidebar-open', state.sidebarOpen);
  ui.sidebarBtn?.setAttribute('aria-expanded', String(state.sidebarOpen));
  if(remember && !narrowMQ.matches) setPref('sidebar', state.sidebarOpen);
  requestAnimationFrame(onResize);
}

function fullscreenElement(){ return document.fullscreenElement || document.webkitFullscreenElement || null; }
function canFullscreen(){
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}
function toggleFullscreen(){
  const target = ui.stageArea || ui.wrap;
  if(fullscreenElement()){
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    return;
  }
  const req = target.requestFullscreen || target.webkitRequestFullscreen;
  try { const p = req?.call(target, { navigationUI: 'hide' }); p?.catch?.(()=>{}); } catch {}
}

function endXR(){ renderer?.xr?.getSession?.()?.end?.(); }

function onKeyDown(e){
  if(!state.open) return;
  if(e.key === 'Escape'){
    if(renderer?.xr?.isPresenting) endXR();
    else if(fullscreenElement()) toggleFullscreen();
    else if(ui.sharePanel && !ui.sharePanel.hidden) toggleSharePanel(false);
    else if(state.aligning) stopAligning();
    else if(state.split.on) setSplit(false);
    else if(narrowMQ.matches && state.sidebarOpen) setSidebar(false);
    else if(!EMBED_MODE) requestClose();
    e.preventDefault();
    return;
  }
  const t = e.target;
  if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  switch(e.key){
    case ' ':
      if(t?.tagName === 'BUTTON') return;
      if(!e.repeat) setPlaying(!state.playing);
      break;
    case 'p': case 'P': if(!e.repeat) setPlaying(!state.playing); break;
    case 's': case 'S': if(!e.repeat) setSplit(!state.split.on); break;
    case 'ArrowRight': nudge(+1); break;
    case 'ArrowLeft': nudge(-1); break;
    case 'Home': setPlaying(false); animateTo(0); break;
    case 'End': setPlaying(false); animateTo(state.stages.length - 1); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'r': case 'R': recenter(); break;
    case 'i': case 'I': setSidebar(!state.sidebarOpen, true); break;
    case 'm': case 'M': if(!ui.audio?.disabled && !ui.audio?.hidden) setAudio(!state.audio); break;
    case 'c': case 'C': if(!e.repeat && !isNeutral(state.adj)) setComparing(true); break;
    case '+': case '=': zoomBy(-5); break;
    case '-': case '_': zoomBy(5); break;
    default: return;
  }
  e.preventDefault();
}
function onKeyUp(e){ if(e.key === 'c' || e.key === 'C') setComparing(false); }

function showDragHint(){
  if(!ui.dragHint || pref('hintSeen', false)) return;
  ui.dragHint.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(hideDragHint, 4000);
}
function hideDragHint(){
  if(!ui.dragHint || ui.dragHint.hidden) return;
  ui.dragHint.hidden = true;
  setPref('hintSeen', true);
}

export function showToast(message, type = 'info', timeoutMs = 2600){
  const host = ui.toastHost || document.getElementById('toastHost');
  if(!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(()=>{ el.classList.add('leaving'); setTimeout(()=> el.remove(), 220); }, timeoutMs);
}

// ---------------------------------------------------------------------------
// Info panel
// ---------------------------------------------------------------------------
function setText(el, text){ if(el) el.textContent = text || '—'; }

function renderStaticInfo(){
  const p = state.project || {};
  const meta = p.meta || {};
  const campus = p.campus || {};
  if(ui.infoDesc) ui.infoDesc.textContent = meta.description || p.description || 'No description yet.';
  if(ui.infoTags){
    ui.infoTags.replaceChildren(...(p.tags || []).map((t)=>{
      const s = document.createElement('span'); s.className = 'tag'; s.textContent = t; return s;
    }));
    ui.infoTags.hidden = !(p.tags || []).length;
  }
  setText(ui.infoPlace, [campus.campus, campus.building, campus.room].filter(Boolean).join(' · '));
  setText(ui.infoPhase, meta.phase);
  setText(ui.infoUpdated, formatIsoDate(meta.updated));
  const imgs = state.stages.filter((s)=> !isVideoUrl(s.url)).length;
  const vids = state.stages.length - imgs;
  setText(ui.infoMedia, [imgs && `${imgs} image${imgs > 1 ? 's' : ''}`, vids && `${vids} video${vids > 1 ? 's' : ''}`].filter(Boolean).join(' · '));
}

let infoSeq = 0;
function updateInfo(){
  const i = nearestIndex();
  const stage = state.stages[i];
  setText(ui.infoStage, stage ? `${stage.label || `Stage ${i + 1}`} (${i + 1} of ${state.stages.length})` : '');
  const fallbackLoc = state.project?.meta?.location;
  const nameDate = stage?.date ? formatIsoDate(stage.date) : '';
  if(!stage?.url || !JPEG_RE.test(stage.url)){
    setText(ui.infoTaken, nameDate);
    setText(ui.infoLocation, fallbackLoc);
    return;
  }
  const seq = ++infoSeq;
  readExif(stage.url).then(({ exifTaken, httpTaken, gps } = {})=>{
    if(seq !== infoSeq) return;
    setText(ui.infoTaken, exifTaken || nameDate || httpTaken);
    if(gps && ui.infoLocation){
      const a = document.createElement('a');
      a.href = `https://www.google.com/maps?q=${gps.lat},${gps.lon}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = fallbackLoc ? `${fallbackLoc} (map)` : `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`;
      ui.infoLocation.replaceChildren(a);
    } else {
      setText(ui.infoLocation, fallbackLoc);
    }
  });
}

const dayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
export function formatIsoDate(s){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if(!m) return s || '';
  return dayFmt.format(new Date(+m[1], +m[2] - 1, +m[3]));    // local date, no UTC shift
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Open the viewer for a project.
 * @param {object} project  projects.json entry, with `stages` as Stage[] or Promise<Stage[]>
 *                          (Stage = { label, url, date? })
 * @param {object} [opts]   { stage?: 1-based stage number, yaw?: number, pitch?: number }
 *                          (from a share link: #/<id>?stage=2&yaw=30&pitch=-5)
 */
export async function openViewer(project, opts = {}){
  bindUI();
  initRenderer();

  const wasOpen = state.open;
  state.open = true;
  if(!wasOpen) lastFocus = document.activeElement;
  ui.modal.setAttribute('aria-hidden', 'false');
  ui.modal.removeAttribute('inert');
  document.body.classList.add('viewer-open');
  setSidebar(narrowMQ.matches || EMBED_MODE ? false : pref('sidebar', true));
  if(ui.title) ui.title.textContent = project.title || 'Project';
  if(ui.openFull) ui.openFull.href = `${location.pathname}#/${encodeURIComponent(project.id)}`;
  renderer.setAnimationLoop(render);
  onResize();
  if(!wasOpen) ui.close?.focus({ preventScroll: true });

  const applyOpts = ()=>{
    if(Number.isFinite(opts.stage)) setStagePos(clamp(opts.stage - 1, 0, state.stages.length - 1));
    if(Number.isFinite(opts.yaw)) lookAt(opts.yaw, Number.isFinite(opts.pitch) ? opts.pitch : 0);
  };

  // Re-opening the same project: everything is still in memory
  if(state.project?.id === project.id && state.textures.some(Boolean)){
    syncMedia();
    applyOpts();
    updateStageUI(true);
    return;
  }

  setPlaying(false);
  saveNow();
  teardownProject();
  const token = ++state.token;
  state.project = project;
  state.stages = [];
  state.pos = 0; state.index = 0;
  try { state.draft = EDIT_MODE ? JSON.parse(localStorage.getItem(DRAFT_PREFIX + project.id) || 'null') : null; } catch { state.draft = null; }
  updateStageUI(true);
  showLoading(true, 'Loading…');
  if(ui.status){ ui.status.hidden = false; ui.status.textContent = 'Loading…'; }

  let stages;
  try { stages = await project.stages; } catch { stages = []; }
  if(token !== state.token) return;
  state.stages = (Array.isArray(stages) ? stages : []).filter((s)=> s && s.url);
  const n = state.stages.length;

  const saved = loadSettings(project.id);
  state.adj = { ...DEFAULT_ADJ, ...(saved.adj || {}) };
  applyAdjustments();
  renderAdjustmentUI();
  renderStaticInfo();
  buildFilmstrip();

  if(ui.range){
    ui.range.min = '0';
    ui.range.max = String(Math.max(0, n - 1));
    ui.range.step = 'any';
    ui.range.disabled = n < 2;
  }
  ui.modal.classList.toggle('single-stage', n < 2);
  if(ui.split) ui.split.hidden = n < 2;

  if(!n){
    showLoading(true, 'No media found for this project.', true);
    if(ui.status) ui.status.hidden = true;
    updateStageUI(true);
    return;
  }

  state.textures = new Array(n).fill(null);
  state.videos = new Array(n).fill(null);
  state.failed = new Array(n).fill(false);
  state.full = new Array(n).fill(false);
  state.loaded = 0;

  const start = Number.isFinite(opts.stage)
    ? clamp(Math.round(opts.stage) - 1, 0, n - 1)
    : clamp(Math.round(saved.pos ?? 0), 0, n - 1);
  state.pos = start; state.index = start;
  const sv = startView();
  if(Number.isFinite(opts.yaw)) lookAt(opts.yaw, opts.pitch || 0);
  else if(Array.isArray(saved.look)) lookAt(saved.look[0], saved.look[1]);
  else lookAt(sv.yaw, sv.pitch);
  setFov(saved.fov ?? sv.fov);
  updateStageUI(true);

  // Show the starting stage as soon as possible (thumbnail preview first), then stream the rest
  await loadStage(start, state.stages[start].url, token, { preview: true });
  if(token !== state.token) return;
  setStagePos(start, { persist: false });
  showDragHint();
  updateFilmstrip();
  state.stages.forEach((s, i)=> { if(i !== start) loadStage(i, s.url, token); });
}

export function closeViewer(){
  if(!state.open) return;
  state.open = false;
  setPlaying(false);
  state.tween = null;
  setComparing(false);
  toggleSharePanel(false);
  saveNow();
  if(fullscreenElement()) toggleFullscreen();
  endXR();
  renderer?.setAnimationLoop(null);
  state.videos.forEach((v)=> { try { v?.pause(); } catch {} });
  ui.modal.setAttribute('aria-hidden', 'true');
  ui.modal.setAttribute('inert', '');
  document.body.classList.remove('viewer-open');
  hideDragHint();
  if(lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}

export function isViewerOpen(){ return state.open; }
