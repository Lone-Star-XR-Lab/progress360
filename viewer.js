// Progress360 viewer
// Renders a project's stages (equirectangular images or videos) on the inside of a sphere,
// cross-fades between stages, and exposes non-destructive colour adjustments.
//
// Colour pipeline (see docs/viewer.md):
//   texture (sRGB, decoded to linear by the GPU) -> stage cross-fade (linear)
//   -> exposure (linear, in EV stops) -> midtones / contrast / saturation (display space)
//   -> three.js output encoding (back to sRGB for the canvas / XR layer).
// With every adjustment at its default the image on screen is pixel-for-pixel the source file.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';

const VIDEO_RE = /\.(mp4|webm|ogv|mov)(\?|#|$)/i;
const JPEG_RE = /\.jpe?g(\?|#|$)/i;
const isVideoUrl = (u)=> VIDEO_RE.test(u || '');

const STORE_PREFIX = 'p360:v2:';            // v2: old (pre colour-fix) settings are ignored
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

const state = {
  open: false,
  token: 0,              // increments per project load; stale async work checks it
  project: null,
  stages: [],
  textures: [],
  videos: [],
  failed: [],
  loaded: 0,
  pos: 0,                // float 0..stages.length-1
  index: 0,              // floor(pos)
  tween: null,           // { from, to, start, dur }
  playing: false,        // auto-advancing through stages
  nextAt: 0,             // performance.now() time of the next auto-advance
  adj: { ...DEFAULT_ADJ },
  comparing: false,
  audio: false,
  sidebarOpen: true,
};

const narrowMQ = window.matchMedia('(max-width: 960px)');
const clamp = (v, lo, hi)=> Math.min(hi, Math.max(lo, v));

/** Let the host page decide what "close" means (e.g. clear the URL hash). */
export function setCloseHandler(fn){ onRequestClose = typeof fn === 'function' ? fn : null; }
function requestClose(){ (onRequestClose || closeViewer)(); }

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
    view: controls ? [controls.getAzimuthalAngle(), controls.getPolarAngle()] : undefined,
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
    range: $('timelineRange'),
    filmstrip: $('filmstrip'),
    play: $('playBtn'),
    prev: $('prevBtn'),
    next: $('nextBtn'),
    close: $('closeViewer'),
    audio: $('audioBtn'),
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
    toastHost: $('toastHost'),
  });
  if(!ui.modal || !ui.wrap) throw new Error('Viewer markup not found');
  bound = true;

  ui.adj = {};
  for(const key of Object.keys(ADJUSTMENTS)){
    const input = $(`adj-${key}`);
    const out = $(`adj-${key}-val`);
    ui.adj[key] = { input, out };
    input?.addEventListener('input', ()=> setAdjustment(key, parseFloat(input.value)));
    input?.addEventListener('dblclick', ()=> setAdjustment(key, DEFAULT_ADJ[key]));
  }

  ui.close?.addEventListener('click', requestClose);
  ui.prev?.addEventListener('click', ()=> nudge(-1));
  ui.next?.addEventListener('click', ()=> nudge(+1));
  ui.play?.addEventListener('click', ()=> setPlaying(!state.playing));
  ui.range?.addEventListener('input', ()=> { setPlaying(false); state.tween = null; setStagePos(parseFloat(ui.range.value)); });
  ui.range?.addEventListener('change', ()=> animateTo(Math.round(parseFloat(ui.range.value))));
  ui.audio?.addEventListener('click', ()=> setAudio(!state.audio));
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
  ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(ev=> ui.compareBtn?.addEventListener(ev, cmpOff));
  ui.compareBtn?.addEventListener('keydown', (e)=> { if((e.key === ' ' || e.key === 'Enter') && !e.repeat) cmpOn(e); });
  ui.compareBtn?.addEventListener('keyup', (e)=> { if(e.key === ' ' || e.key === 'Enter') cmpOff(); });

  // Zoom (field of view): wheel + pinch
  ui.wrap.addEventListener('wheel', (e)=> { e.preventDefault(); zoomBy(e.deltaY * 0.04); }, { passive: false });
  let pinch = 0;
  const dist = (t)=> Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  ui.wrap.addEventListener('touchstart', (e)=> { if(e.touches.length === 2) pinch = dist(e.touches); }, { passive: true });
  ui.wrap.addEventListener('touchmove', (e)=> {
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
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(ev=> document.addEventListener(ev, blockGesture, { passive: false }));

  const onFsChange = ()=> {
    const on = !!fullscreenElement();
    ui.fullscreen?.setAttribute('aria-pressed', String(on));
    ui.fullscreen?.setAttribute('title', on ? 'Exit full screen (F)' : 'Full screen (F)');
    ui.modal.classList.toggle('is-fullscreen', on);
    requestAnimationFrame(onResize);
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  if(!canFullscreen() && ui.fullscreen) ui.fullscreen.hidden = true;

  narrowMQ.addEventListener?.('change', ()=> setSidebar(narrowMQ.matches ? false : pref('sidebar', true)));
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
      mixAmount: { value: 0 },
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
      uniform float mixAmount;
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
        vec3 col = mix(texture2D(map1, uv).rgb, texture2D(map2, uv).rgb, clamp(mixAmount, 0.0, 1.0));
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
  t.wrapS = THREE.RepeatWrapping;           // avoids a visible seam at the 0/360° join
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
      material.uniforms.map1.value = textureAt(from);
      material.uniforms.map2.value = textureAt(to);
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
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
function loadStage(i, url, token){
  return new Promise((resolve)=>{
    const done = (tex, video)=>{
      if(token !== state.token){ tex?.dispose(); disposeVideo(video); resolve(); return; }
      state.textures[i] = tex || null;
      state.videos[i] = video || null;
      state.failed[i] = !tex;
      state.loaded++;
      updateProgress();
      refreshTextures();
      syncMedia();
      updateFilmstrip();
      resolve();
    };

    if(isVideoUrl(url)){
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
          state.failed[i] = true; state.textures[i] = null; tex.dispose(); refreshTextures(); updateFilmstrip();
          return;
        }
        settled = true; tex.dispose(); done(null, null);
      }, { once: true });
      const ok = ()=> { if(!settled){ settled = true; done(tex, v); } };
      v.addEventListener('loadeddata', ok, { once: true });
      setTimeout(ok, 2500);          // some mobile browsers won't fire loadeddata until play()
      try { v.load(); } catch {}
      return;
    }

    new THREE.TextureLoader().load(url, (t)=> done(configureTexture(t)), undefined, ()=> done(null));
  });
}

function disposeVideo(v){
  if(!v) return;
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
}

function teardownProject(){
  state.tween = null;
  state.textures.forEach((t)=> t?.dispose());
  state.videos.forEach(disposeVideo);
  state.textures = []; state.videos = []; state.failed = [];
  state.loaded = 0;
  if(material){ material.uniforms.map1.value = null; material.uniforms.map2.value = null; }
  if(ui.filmstrip) ui.filmstrip.replaceChildren();
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

// Pick the texture for stage i, falling back to the nearest loaded stage while others stream in
function textureAt(i){
  const t = state.textures;
  if(t[i]) return t[i];
  for(let d = 1; d < t.length; d++){
    if(t[i - d]) return t[i - d];
    if(t[i + d]) return t[i + d];
  }
  return null;
}

function refreshTextures(){
  if(!material) return;
  const n = state.stages.length;
  const a = textureAt(state.index);
  material.uniforms.map1.value = a;
  material.uniforms.map2.value = textureAt(Math.min(state.index + 1, n - 1)) || a;
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
  if(material) material.uniforms.mixAmount.value = pos - index;
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
  if(reduce || !state.open){ setStagePos(to); return; }
  state.tween = { from: state.pos, to, start: performance.now(), dur };
}

// ---------------------------------------------------------------------------
// Playback: fade through the stages in order, hold on each, loop back to the start
// ---------------------------------------------------------------------------
function setPlaying(on){
  const n = state.stages.length;
  on = !!on && n > 1;
  if(state.playing === on) return;
  state.playing = on;
  ui.play?.setAttribute('aria-pressed', String(on));
  ui.play?.setAttribute('title', on ? 'Pause (Space)' : 'Play through stages (Space)');
  ui.play?.setAttribute('aria-label', on ? 'Pause' : 'Play through stages');
  ui.modal?.classList.toggle('is-playing', on);
  if(on){
    // Start moving almost straight away so pressing Play feels responsive
    state.nextAt = performance.now() + 350;
    if(!state.tween) showHold(350);
  } else {
    clearHold();
  }
}

function advancePlayback(now){
  const n = state.stages.length;
  let next = (nearestIndex() + 1) % n;
  // Skip stages that failed to load; wait for ones still loading
  for(let tries = 0; tries < n && state.failed[next]; tries++) next = (next + 1) % n;
  if(!state.textures[next]){ state.nextAt = now + 250; return; }
  clearHold();
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if(next < nearestIndex() && !reduce){
    state.tween = { from: nearestIndex(), to: next, start: now, dur: PLAY_FADE_MS, wrap: true };
    const v = state.videos[next];
    if(v){ v.muted = true; safePlay(v); }   // the stage fading in should already be moving
    return;
  }
  animateTo(next, PLAY_FADE_MS);
  if(!state.tween) holdStage(now);   // reduced motion: jumped instantly
}

function holdStage(now){
  state.nextAt = now + PLAY_HOLD_MS;
  showHold(PLAY_HOLD_MS);
}

// Progress bar on the active filmstrip item showing how long until the next stage
function showHold(ms){
  clearHold();
  const el = ui.filmstrip?.children[nearestIndex()];
  if(!el) return;
  el.style.setProperty('--hold', `${ms}ms`);
  void el.offsetWidth;   // restart the CSS animation
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
function updateStageUI(){
  const n = state.stages.length;
  const i = nearestIndex();
  const stage = state.stages[i];
  if(ui.prev) ui.prev.disabled = state.pos <= 0.001;
  if(ui.next) ui.next.disabled = state.pos >= n - 1.001;
  // Everything below only needs to change when the nearest stage changes (not every tween frame)
  const key = `${state.token}:${n}:${i}`;
  if(key === lastUiKey) return;
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
  updateAudioUI();
  updateInfo();
}

function buildFilmstrip(){
  if(!ui.filmstrip) return;
  const frag = document.createDocumentFragment();
  state.stages.forEach((s, idx)=>{
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'film';
    b.title = s.label || `Stage ${idx + 1}`;
    b.addEventListener('click', ()=> { setPlaying(false); animateTo(idx); });
    let media;
    if(isVideoUrl(s.url)){
      media = document.createElement('video');
      media.muted = true; media.playsInline = true; media.preload = 'metadata';
      media.src = `${s.url}#t=0.5`;
    } else {
      media = document.createElement('img');
      media.src = s.url;   // same URL as the texture, so it comes from cache
      media.alt = '';
      media.loading = 'lazy';
      media.decoding = 'async';
    }
    media.className = 'film-media';
    const label = document.createElement('span');
    label.className = 'film-label';
    label.textContent = s.label || `Stage ${idx + 1}`;
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
}

function updateFilmstrip(){
  if(!ui.filmstrip) return;
  [...ui.filmstrip.children].forEach((el, i)=> {
    el.classList.toggle('is-failed', !!state.failed[i]);
    el.classList.toggle('is-pending', !state.textures[i] && !state.failed[i]);
  });
}

// ---------------------------------------------------------------------------
// Video + audio
// ---------------------------------------------------------------------------
function syncMedia(){
  const vids = state.videos;
  if(!vids.some(Boolean)) return;
  const a = state.index;
  const b = state.pos - a > 0.001 ? a + 1 : a;
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
// Camera
// ---------------------------------------------------------------------------
function setView(theta = 0, phi = Math.PI / 2){
  if(!camera || !controls) return;
  camera.position.setFromSphericalCoords(0.1, clamp(phi, 0.01, Math.PI - 0.01), theta);
  controls.update();
}
function recenter(){
  setView(0, Math.PI / 2);
  setFov(DEFAULT_FOV);
  saveSoon();
}
function setFov(f){
  if(!camera) return;
  camera.fov = clamp(f, MIN_FOV, MAX_FOV);
  camera.updateProjectionMatrix();
}
function zoomBy(delta){ setFov(camera.fov + delta); saveSoon(); }

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
      // Ignore the poles (ceiling/floor) which are heavily stretched in equirect images
      const y0 = Math.floor(H * 0.2), y1 = Math.ceil(H * 0.8);
      const data = ctx.getImageData(0, y0, W, y1 - y0).data;
      for(let p = 0; p < data.length; p += 16){   // every 4th pixel is plenty
        const r = srgbToLinear(data[p] / 255), g = srgbToLinear(data[p + 1] / 255), b = srgbToLinear(data[p + 2] / 255);
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        logSum += Math.log(1e-4 + Y);
        lumas.push(Y);
        count++;
      }
    }
    if(!count) throw new Error('no pixels');
    const key = Math.exp(logSum / count);                       // log-average luminance
    const exposure = roundTo(clamp(Math.log2(0.18 / key) * 0.7, -1.5, 1.5), 0.05);
    // Mild contrast boost for flat images (based on the 5–95% display-space spread)
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
    else if(narrowMQ.matches && state.sidebarOpen) setSidebar(false);
    else requestClose();
    e.preventDefault();
    return;
  }
  const t = e.target;
  if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  switch(e.key){
    case ' ':
      if(t?.tagName === 'BUTTON') return;   // let Space activate the focused button
      if(!e.repeat) setPlaying(!state.playing);
      break;
    case 'p': case 'P': if(!e.repeat) setPlaying(!state.playing); break;
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

const exifCache = new Map();   // url -> Promise<{ taken, gps }>
let infoSeq = 0;

function updateInfo(){
  const i = nearestIndex();
  const stage = state.stages[i];
  setText(ui.infoStage, stage ? `${stage.label || `Stage ${i + 1}`} (${i + 1} of ${state.stages.length})` : '');
  const fallbackLoc = state.project?.meta?.location;
  const nameDate = stage?.date ? formatIsoDate(stage.date) : '';   // from a dated file name
  if(!stage?.url || !JPEG_RE.test(stage.url)){
    setText(ui.infoTaken, nameDate);
    setText(ui.infoLocation, fallbackLoc);
    return;
  }
  const seq = ++infoSeq;
  readExif(stage.url).then(({ exifTaken, httpTaken, gps } = {})=>{
    if(seq !== infoSeq) return;
    setText(ui.infoTaken, exifTaken || nameDate || httpTaken);
    if(gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lon) && ui.infoLocation){
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

function readExif(url){
  if(!exifCache.has(url)){
    exifCache.set(url, (async ()=>{
      try{
        // EXIF lives in the first few KB; ask for just that (servers without Range support send it all)
        const r = await fetch(url, { headers: { Range: 'bytes=0-131071' } });
        if(!r.ok) return {};
        const lastModified = r.headers.get('last-modified');
        const buf = await r.arrayBuffer();
        let meta = {};
        try { meta = parseBasicExif(buf) || {}; } catch {}
        const raw = meta.dateTimeOriginal || meta.dateTimeDigitized || meta.dateTime;
        return { exifTaken: formatExifDate(raw), httpTaken: formatHttpDate(lastModified), gps: meta.gps };
      }catch{ return {}; }
    })());
  }
  return exifCache.get(url);
}

function parseBasicExif(arrayBuffer){
  const data = new DataView(arrayBuffer);
  if(data.byteLength < 4 || data.getUint16(0) !== 0xFFD8) return {};
  let offset = 2;
  while(offset + 4 <= data.byteLength){
    const marker = data.getUint16(offset);
    const size = data.getUint16(offset + 2);
    if((marker & 0xFF00) !== 0xFF00 || size < 2 || marker === 0xFFDA) break;   // not a marker / start of scan
    if(marker === 0xFFE1 && getString(data, offset + 4, 4) === 'Exif'){
      return readTIFF(data, offset + 10);
    }
    offset += 2 + size;
  }
  return {};
}

function readTIFF(view, base){
  const little = view.getUint16(base) === 0x4949;
  const u16 = (o)=> view.getUint16(o, little);
  const u32 = (o)=> view.getUint32(o, little);
  const rational = (o)=> { const d = u32(o + 4); return d ? u32(o) / d : 0; };
  function readIFD(at){
    const count = u16(at);
    const tags = new Map();
    let p = at + 2;
    for(let i = 0; i < count; i++, p += 12){
      const tag = u16(p), type = u16(p + 2), num = u32(p + 4);
      const inline = p + 8;
      const off = () => u32(inline) + base;
      let value = null;
      if(type === 2) value = getString(view, num > 4 ? off() : inline, Math.max(0, num - 1));
      else if(type === 3) value = num > 1 ? Array.from({ length: num }, (_, k)=> u16(off() + 2 * k)) : u16(inline);
      else if(type === 4) value = num > 1 ? Array.from({ length: num }, (_, k)=> u32(off() + 4 * k)) : u32(inline);
      else if(type === 5) value = num > 1 ? Array.from({ length: num }, (_, k)=> rational(off() + 8 * k)) : rational(off());
      tags.set(tag, value);
    }
    return tags;
  }
  const ifd0 = readIFD(u32(base + 4) + base);
  const meta = {};
  const exifPtr = ifd0.get(0x8769);
  if(exifPtr){
    const exif = readIFD(exifPtr + base);
    if(exif.get(0x9003)) meta.dateTimeOriginal = String(exif.get(0x9003)).trim();
    if(exif.get(0x9004)) meta.dateTimeDigitized = String(exif.get(0x9004)).trim();
  }
  if(ifd0.get(0x0132)) meta.dateTime = String(ifd0.get(0x0132)).trim();
  const gpsPtr = ifd0.get(0x8825);
  if(gpsPtr){
    const gps = readIFD(gpsPtr + base);
    const lat = gps.get(0x0002), lon = gps.get(0x0004);
    if(lat && lon){
      const deg = (a)=> Array.isArray(a) ? a[0] + a[1] / 60 + a[2] / 3600 : a || 0;
      meta.gps = { lat: deg(lat) * (gps.get(0x0001) === 'S' ? -1 : 1), lon: deg(lon) * (gps.get(0x0003) === 'W' ? -1 : 1) };
    }
  }
  return meta;
}

function getString(view, offset, len){
  let s = '';
  for(let i = 0; i < len && offset + i < view.byteLength; i++){
    const c = view.getUint8(offset + i);
    if(c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
function formatExifDate(s){
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  if(!m) return s || '';
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(d) ? s : dateFmt.format(d);
}
function formatHttpDate(h){
  const d = h ? new Date(h) : null;
  return d && !isNaN(d) ? dateFmt.format(d) : '';
}
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
 * @param {object} project  { id, title, meta, campus, tags, stages: Stage[] | Promise<Stage[]> }
 *                          Stage = { label, url }
 */
export async function openViewer(project){
  bindUI();
  initRenderer();

  const wasOpen = state.open;
  state.open = true;
  if(!wasOpen) lastFocus = document.activeElement;
  ui.modal.setAttribute('aria-hidden', 'false');
  ui.modal.removeAttribute('inert');
  document.body.classList.add('viewer-open');
  setSidebar(narrowMQ.matches ? false : pref('sidebar', true));
  if(ui.title) ui.title.textContent = project.title || 'Project';
  renderer.setAnimationLoop(render);
  onResize();
  if(!wasOpen) ui.close?.focus({ preventScroll: true });

  // Re-opening the same project: everything is still in memory
  if(state.project?.id === project.id && state.textures.some(Boolean)){
    syncMedia();
    updateStageUI();
    return;
  }

  setPlaying(false);
  saveNow();
  teardownProject();
  const token = ++state.token;
  state.project = project;
  state.stages = [];
  state.pos = 0; state.index = 0;
  updateStageUI();
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

  if(!n){
    showLoading(true, 'No media found for this project.', true);
    if(ui.status) ui.status.hidden = true;
    updateStageUI();
    return;
  }

  state.textures = new Array(n).fill(null);
  state.videos = new Array(n).fill(null);
  state.failed = new Array(n).fill(false);
  state.loaded = 0;

  const start = clamp(Math.round(saved.pos ?? 0), 0, n - 1);
  state.pos = start; state.index = start;
  if(Array.isArray(saved.view)) setView(saved.view[0], saved.view[1]); else setView();
  setFov(saved.fov ?? DEFAULT_FOV);
  updateStageUI();

  // Show the starting stage as soon as possible, then stream the rest in
  await loadStage(start, state.stages[start].url, token);
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
