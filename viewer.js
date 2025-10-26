import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/controls/OrbitControls.js';
import { VRButton } from 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/webxr/VRButton.js';

// Internal state
let renderer, scene, camera, controls, sphere, material;
let modalEl, container, titleEl, statusEl,
    timelineRange, timelineLegend,
    timelineTicks,
    exposureRange, gammaRange, autoAdjustBtn, resetAdjustBtn,
    prevBtn, nextBtn, recenterBtn, closeBtn, fullscreenBtn, sideGallery;
let mixUniform;
let currentProject = null;
let stages = [];
let stageTextures = [];
let stagePos = 0; // float 0..(stages.length-1)
let fsOverlay;
let fsIndicatorEl;

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
    const next = { ...prev, ...partial };
    localStorage.setItem(storeKey(), JSON.stringify(next));
  } catch {}
}

function ensureUIRefs(){
  if(modalEl) return;
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
  sideGallery = document.getElementById('sideGallery');

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
  resetAdjustBtn?.addEventListener('click', ()=> { setExposure(1.0); setGamma(1.0); });
  recenterBtn?.addEventListener('click', ()=> { if(controls) controls.reset(); });
}

function setMix(v){ if(mixUniform) mixUniform.value = v; }

function setStagePos(v, persist = true){
  if(!stages.length) return;
  stagePos = Math.min(stages.length-1, Math.max(0, v));
  if(timelineRange) timelineRange.value = String(stagePos);
  const i = Math.floor(stagePos);
  const frac = stagePos - i;
  const texA = stageTextures[i];
  const texB = stageTextures[Math.min(i+1, stageTextures.length-1)] || texA;
  if(material){
    material.uniforms.map1.value = texA;
    material.uniforms.map2.value = texB;
  }
  setMix(frac);
  updateTimelineLegendHighlight(i, frac);
  if(persist) saveSettings({ stagePos });
  // Update overlay indicator if visible
  if(fsOverlay && fsOverlay.style.display !== 'none') updateFsIndicator();
}

function nudgeStage(dir){
  const i = Math.round(stagePos) + dir;
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
      <div class="fs-exit"><button class="btn ghost" data-action="exit">Exit</button></div>
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
      if(a==='exit') exitXRorFS();
    });
    container.appendChild(fsOverlay);
    fsIndicatorEl = fsOverlay.querySelector('.fs-indicator');
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

function setExposure(v, persist = true){
  if(!material) return;
  material.uniforms.exposure.value = v;
  if(exposureRange) exposureRange.value = String(v);
  if(persist) saveSettings({ exposure: v });
}

function setGamma(v, persist = true){
  if(!material) return;
  material.uniforms.gamma.value = v;
  if(gammaRange) gammaRange.value = String(v);
  if(persist) saveSettings({ gamma: v });
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
  }catch(err){
    console.warn('Auto adjust failed', err);
    if(statusEl) statusEl.textContent = 'Auto adjustment failed';
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
  const target = 0.22; // middle gray target in linear space
  const exposure = Math.min(2.0, Math.max(0.5, target / Math.max(1e-6, mean)));
  const gamma = 1.0; // keep neutral for now; manual control via slider
  return { exposure, gamma };
}

function loadImage(url){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = ()=> resolve(img);
    img.onerror = reject;
    img.src = url + (url.includes('?') ? '&' : '?') + 'cachebust=' + Date.now();
  });
}

async function loadStages(urls){
  const loader = new THREE.TextureLoader();
  const loadTex = (url)=> new Promise((res,rej)=> loader.load(url, (t)=> res(t), undefined, rej));
  const texs = [];
  for(const url of urls){
    try{
      const t = await loadTex(url);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      texs.push(t);
    }catch(err){
      console.warn('Failed to load stage', url, err);
      texs.push(texs[texs.length-1] || null);
    }
  }
  // replace any nulls with last valid
  for(let i=0;i<texs.length;i++) if(!texs[i]) texs[i] = texs[i-1] || texs.find(Boolean);
  return texs;
}

function populateSideGallery(){
  if(!sideGallery) return;
  sideGallery.innerHTML = '';
  stages.forEach((s, idx)=>{
    const img = document.createElement('img');
    img.src = s.url;
    img.alt = s.label || `Stage ${idx+1}`;
    img.className = 'thumb';
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

  // Determine stages list from project
  stages = Array.isArray(stageDefs) ? stageDefs.filter(s=> !!s?.url) : [];
  if(!stages.length){
    if(statusEl) statusEl.textContent = 'No images found';
    return;
  }
  stageTextures = await loadStages(stages.map(s=> s.url));
  if(timelineRange){
    timelineRange.min = '0';
    timelineRange.max = String(Math.max(0, stages.length-1));
    timelineRange.step = stages.length > 1 ? '0.001' : '1';
  }
  updateTimelineLegend(stages.map(s=> s.label || 'Stage'));
  updateTimelineTicks(stages.length);
  populateSideGallery();

  const texA = stageTextures[0];
  const texB = stageTextures[Math.min(1, stageTextures.length-1)] || texA;
  material = EquirectBlendMaterial(texA, texB);
  mixUniform = material.uniforms.mixAmount;

  const geom = new THREE.SphereGeometry(500, 64, 48);
  sphere = new THREE.Mesh(geom, material);
  scene.add(sphere);

  if(statusEl) statusEl.textContent = 'Ready';
  if(titleEl) titleEl.textContent = title || 'Project';
  // Initialize defaults without persisting over saved settings
  setStagePos(0.0, false);
  setExposure(1.0, false);
  setGamma(1.0, false);
  animate();
}

export async function openViewer(project){
  ensureUIRefs();
  currentProject = project;
  // project.stages should be provided by the caller (main.js discovery)

  // Show modal
  modalEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('viewer-open');
  if(statusEl) statusEl.textContent = 'Loading…';
  if(titleEl) titleEl.textContent = project.title || 'Project';

  // Ensure renderer exists now that container is visible
  initRenderer();
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
    // Apply saved adjustments and position if present
    const saved = loadSettings();
    if(typeof saved.stagePos === 'number') setStagePos(saved.stagePos, false);
    if(typeof saved.exposure === 'number') setExposure(saved.exposure, false);
    if(typeof saved.gamma === 'number') setGamma(saved.gamma, false);
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
  // leave canvas & VR button mounted for faster reopen
}
