import { openViewer } from './viewer.js';


const galleryEl = document.getElementById('gallery');
const dataEl = document.getElementById('projects-data');
let projects = [];
const _prefetched = new Set();
const _thumbFrames = new Map(); // key -> dataURL[] (sorted by yaw)
const _thumbAnim = new Map();   // key -> { raf }
const _thumbYaw = new Map();    // key -> number[] (sorted yaws)
const _thumbBitmaps = new Map(); // key -> ImageBitmap[] (sorted to yaw)
const _thumbBitmapMap = new Map(); // key -> Map(yaw->ImageBitmap)

async function loadProjects(){
  // 1) Try external manifest
  try{
    const res = await fetch(`assets/projects.json?cb=${Date.now()}`);
    if(res.ok){
      const json = await res.json();
      const arr = Array.isArray(json) ? json : (json?.projects || []);
      if(arr.length) return arr;
    }
  }catch{}

  // 2) Try parsing dev-server directory listing
  try{
    const res = await fetch(`assets/?cb=${Date.now()}`);
    if(res.ok){
      const ct = res.headers.get('content-type') || '';
      if(ct.includes('text/html')){
        const html = await res.text();
        const dirs = Array.from(html.matchAll(/href\s*=\s*"([^"/]+)\/"/gi)).map(m=> m[1]);
        const uniq = Array.from(new Set(dirs));
        const found = [];
        for(const name of uniq){
          const folder = `assets/${name}`;
          const slug = toSlug(name);
          const preview = `${folder}/000-${slug}.jpg`;
          // eslint-disable-next-line no-await-in-loop
          if(await imageExists(preview)){
            found.push({ id: slug, title: toTitle(name), folder, thumb: preview, slug });
          }
        }
        if(found.length) return found;
      }
    }
  }catch{}

  // 3) Fallback to inline JSON
  if(dataEl){
    try{
      const parsed = JSON.parse(dataEl.textContent.trim());
      const arr = Array.isArray(parsed) ? parsed : (parsed?.projects || []);
      if(arr.length) return arr;
    }catch{}
  }
  return [];
}


async function discoverStages(p){
  const folder = p.folder;
  const slug = getProjectSlug(p);
  const pad = (n)=> String(n).padStart(3,'0');
  const stages = [];
  let misses = 0;
  let lastFoundIndex = -1;
  for(let i=0;i<40;i++){
    const n = pad(i);
    const candidates = [
      `${folder}/${n}-${slug}.jpg`,
      `${folder}/${n}-${slug}.mp4`
    ];
    let foundUrl = null;
    for(const url of candidates){
      // eslint-disable-next-line no-await-in-loop
      const ok = url.endsWith('.jpg') ? await imageExists(url) : await assetExists(url);
      if(ok){ foundUrl = url; break; }
    }
    if(foundUrl){
      const label = i === 0 ? 'Start' : (i === 999 ? 'Current' : `Stage ${stages.length+1}`);
      stages.push({ label, url: foundUrl });
      misses = 0;
      lastFoundIndex = i;
    } else {
      misses++;
      if(stages.length && misses >= 2) break;
      if(i >= 12) break;
    }
  }
  // Optional 999-current: only probe if we've already found later-stage images
  // to avoid a wasted network request when projects are small.
  if(lastFoundIndex >= 20){
    const jpg999 = `${folder}/999-${slug}.jpg`;
    const mp999 = `${folder}/999-${slug}.mp4`;
    if(await imageExists(jpg999)) stages.push({ label: 'Current', url: jpg999 });
    else if(await assetExists(mp999)) stages.push({ label: 'Current', url: mp999 });
  }
  return stages;
}

function createCard(p){
  const card = document.createElement('article');
  card.className = 'card';


  const btn = document.createElement('button');
  // Click opens viewer
  btn.addEventListener('click', async ()=> {
    // Show a quick loading state on the card for feedback
    try { card.classList.add('is-loading'); } catch{}
    try{
      let stages = Array.isArray(p.stages) && p.stages.length
        ? p.stages.map(s=> ({ label: s.label, url: s.url.startsWith('http') ? s.url : `${p.folder}/${s.url}` }))
        : await discoverStages(p);
      if(!stages || stages.length === 0){
        stages = [
          { label: 'Before', url: `${p.folder}/before.jpg` },
          { label: 'After',  url: `${p.folder}/after.jpg` }
        ];
      }
      // Open viewer without awaiting so the modal and its own spinner appear immediately
      openViewer({ id: p.id, title: p.title, stages, meta: (p.meta||{}), description: p.description || '' }).catch(()=>{});
    } finally {
      // Remove loading state shortly after triggering viewer so paint happens
      try { setTimeout(()=> card.classList.remove('is-loading'), 80); } catch{}
    }
  });

  // Hover/touch prefetch for faster open
  let hoverTimer = null;
  const startPrefetch = ()=>{
    if(_prefetched.has(p.id)) return;
    if(hoverTimer) return;
    hoverTimer = setTimeout(()=>{ prefetchProject(p, card).catch(()=>{}); hoverTimer = null; }, 150);
  };
  const cancelPrefetch = ()=>{ if(hoverTimer){ clearTimeout(hoverTimer); hoverTimer = null; } };
  btn.addEventListener('mouseenter', startPrefetch);
  btn.addEventListener('focus', startPrefetch);
  btn.addEventListener('mouseleave', cancelPrefetch);
  btn.addEventListener('blur', cancelPrefetch);
  btn.addEventListener('touchstart', ()=>{ prefetchProject(p, card).catch(()=>{}); }, { passive: true });


  const img = document.createElement('img');
  // Prefer first stage 000-<slug>.jpg as the preview; fall back to provided thumb.
  const slug = getProjectSlug(p);
  // Prefer generated thumb if present
  img.src = p.thumb || `${p.folder}/000-${slug}-thumb.jpg`;
  setCardThumb(img, p.folder, p.thumb, slug);
  img.alt = `${p.title} thumbnail`;
  img.loading = 'lazy';
  try { img.decoding = 'async'; } catch{}
  img.className = 'thumb';
  // Animated pano overlay: background + canvas for silky frames
  const anim = document.createElement('div');
  anim.className = 'thumb-bg';
  const canvas = document.createElement('canvas');
  canvas.className = 'thumb-canvas';
  const schedule = (fn)=> (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 120));
  const key = p.id || p.folder || (img.currentSrc || img.src);
  const prepareThumb = ()=>{
    schedule(()=>{
      try{
        const urlNow = img.currentSrc || img.src;
        if(urlNow) anim.style.backgroundImage = `url("${urlNow}")`;
        makeThumbFrames(img, key).then((frames)=>{
          const yaws = _thumbYaw.get(key) || [];
          if(frames && frames.length){
            // choose frame closest to 0 yaw for rest state
            let idx = 0;
            if(yaws.length){
              let best = 1e9, bi = 0;
              for(let i=0;i<yaws.length;i++){ const v=Math.abs(yaws[i]); if(v<best){ best=v; bi=i; } }
              idx = bi;
            }
            anim.style.backgroundImage = `url("${frames[idx]}")`;
          }
        }).catch(()=>{
          const dataUrl = downscaleToDataURL(img, 1024, 0.72);
          if(dataUrl){ anim.style.backgroundImage = `url("${dataUrl}")`; }
        });
      }catch{}
    });
  };
  // If already loaded from cache, run immediately; otherwise after load
  if(img.complete && img.naturalWidth > 0) prepareThumb();
  else img.addEventListener('load', prepareThumb, { once: true });
  // Add a small badge if the project appears to have video
  (async ()=>{
    try{
      const slug = getProjectSlug(p);
      // Probe a couple of common stage indices cheaply
      const candidates = [ `${p.folder}/000-${slug}.mp4`, `${p.folder}/001-${slug}.mp4` ];
      for(const url of candidates){
        if(await assetExists(url)){
          const badge = document.createElement('div');
          badge.className = 'badge video';
          badge.textContent = 'Video';
          card.style.position = 'relative';
          card.appendChild(badge);
          break;
        }
      }
    }catch{}
  })();


const body = document.createElement('div');
body.className = 'body';
const title = document.createElement('div');
title.className = 'title';
title.textContent = p.title;
const meta = document.createElement('div');
meta.className = 'meta';
meta.innerHTML = `${p?.meta?.location ? `<span>📍 ${p.meta.location}</span>`: ''} ${p?.meta?.phase ? ` • <span>Phase: ${p.meta.phase}</span>` : ''}`;


body.appendChild(title);
body.appendChild(meta);
  btn.appendChild(img);
  btn.appendChild(anim);
  btn.appendChild(canvas);
  card.appendChild(btn);
  card.appendChild(body);

  // Hover animation of rectilinear frames
  // Start/stop hover animation over precomputed frames
  const startAnim = ()=>{
    if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const yawList = _thumbYaw.get(key) || [];
    const bm = _thumbBitmaps.get(key) || [];
    if(!yawList.length || bm.length < 8) return; // wait for a few frames
    stopAnim();
    // Prepare canvas size for crisp drawing
    const dpr = (window.devicePixelRatio || 1);
    const rect = btn.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if(canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    let i = Math.floor((bm.length-1)/2);
    let dir = 1; // ping-pong
    let last = performance.now();
    const frameMs = 42; // ~24 fps
    const loop = (t)=>{
      const st = _thumbAnim.get(key);
      if(!st) return;
      if(t - last >= frameMs){
        last = t;
        const frame = bm[i];
        if(frame){
          try{ ctx.clearRect(0,0,canvas.width,canvas.height); ctx.drawImage(frame, 0, 0, canvas.width, canvas.height); }catch{}
        }
        i += dir;
        if(i >= bm.length-1){ i = bm.length-1; dir = -1; }
        else if(i <= 0){ i = 0; dir = 1; }
      }
      const raf = requestAnimationFrame(loop);
      _thumbAnim.set(key, { raf });
    };
    const raf = requestAnimationFrame(loop);
    _thumbAnim.set(key, { raf });
  };
  const stopAnim = ()=>{
    const st = _thumbAnim.get(key);
    if(st && st.raf){ cancelAnimationFrame(st.raf); }
    _thumbAnim.delete(key);
    // Draw center frame to canvas for steady rest
    const yawList = _thumbYaw.get(key) || [];
    const bm = _thumbBitmaps.get(key) || [];
    if(yawList.length && bm.length){
      let best = 1e9, idx = 0;
      for(let i=0;i<yawList.length;i++){ const v=Math.abs(yawList[i]); if(v<best){ best=v; idx=i; } }
      const dpr = (window.devicePixelRatio || 1);
      const rect = btn.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if(canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      try{ ctx.clearRect(0,0,canvas.width,canvas.height); const frame = bm[idx]; if(frame) ctx.drawImage(frame,0,0,canvas.width,canvas.height); }catch{}
    }
  };
  btn.addEventListener('mouseenter', startAnim);
  btn.addEventListener('focus', startAnim);
  btn.addEventListener('mouseleave', stopAnim);
  btn.addEventListener('blur', stopAnim);
  return card;
}


function renderGallery(){
  galleryEl.innerHTML = '';
  projects.forEach(p=> galleryEl.appendChild(createCard(p)) );
}

(async function init(){
  projects = await loadProjects();
  renderGallery();
})();

// Helpers
async function prefetchProject(p, card){
  try{
    if(!p || _prefetched.has(p.id)) return;
    const slug = getProjectSlug(p);
    const base = p.folder || '';
    // Prefer explicit stage URLs if provided; normalize to absolute
    let stageUrls = [];
    if(Array.isArray(p.stages) && p.stages.length){
      stageUrls = p.stages.slice(0,2).map(s=> s.url.startsWith('http') ? s.url : `${base}/${s.url}`);
    } else {
      stageUrls = [ `${base}/000-${slug}.jpg`, `${base}/001-${slug}.jpg` ];
    }
    // Kick off image prefetch
    const imgTasks = stageUrls.map(u=> prefetchImage(u).catch(()=>{}));

    // If the card already has a video badge, also prime first video metadata
    const hasVideoBadge = !!card?.querySelector?.('.badge.video');
    const videoUrls = [ `${base}/000-${slug}.mp4`, `${base}/001-${slug}.mp4` ];
    const vidTasks = hasVideoBadge ? videoUrls.map(u=> prefetchVideoMetadata(u).catch(()=>{})) : [];

    // Race first few, but don't block UI
    await Promise.race([
      Promise.allSettled(imgTasks),
      new Promise(res=> setTimeout(res, 350))
    ]);
    _prefetched.add(p.id);
  }catch{}
}

function prefetchImage(url){
  return new Promise((resolve, reject)=>{
    if(!url || !/\.jpg(\?|$)/i.test(url)) { resolve(); return; }
    const img = new Image();
    img.onload = ()=> { if(img.decode){ img.decode().catch(()=>{}).finally(resolve); } else { resolve(); } };
    img.onerror = ()=> resolve();
    img.src = url; // no cache-bust; allow browser cache
  });
}

function prefetchVideoMetadata(url){
  return new Promise((resolve)=>{
    if(!url || !/\.(mp4|webm|ogg)(\?|$)/i.test(url)) { resolve(); return; }
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    v.onloadedmetadata = ()=> resolve();
    v.onerror = ()=> resolve();
    // trigger fetch of metadata
    try{ v.load(); }catch{}
    // safety timeout
    setTimeout(resolve, 800);
  });
}

function downscaleToDataURL(imgEl, maxWidth = 1024, quality = 0.72){
  try{
    const w0 = imgEl.naturalWidth || imgEl.width;
    const h0 = imgEl.naturalHeight || imgEl.height;
    if(!w0 || !h0) return null;
    const scale = Math.min(1, maxWidth / w0);
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  }catch{ return null; }
}

// Create a set of low-res rectilinear frames from an equirectangular image
async function makeThumbFrames(imgEl, key){
  if(_thumbFrames.has(key)) return _thumbFrames.get(key);
  const frames = [];
  _thumbFrames.set(key, frames);
  const yawList = [];
  const yawToUrl = new Map();
  _thumbYaw.set(key, yawList);
  _thumbBitmapMap.set(key, new Map());
  const targetW = Math.max(320, Math.min(600, imgEl.clientWidth || 480));
  const outW = targetW;
  const outH = Math.round(outW * 9/16);
  // Generate a smooth sweep with small steps and ping-pong handled by the player
  const maxYaw = 24; // degrees
  const step = 2;    // degrees per frame
  const yaws = [];
  for(let a=-maxYaw; a<=maxYaw; a+=step){ yaws.push(a); }
  // Draw source to canvas once
  const sw = imgEl.naturalWidth || imgEl.width;
  const sh = imgEl.naturalHeight || imgEl.height;
  if(!sw || !sh) return frames;
  const sCan = document.createElement('canvas'); sCan.width = sw; sCan.height = sh;
  const sCtx = sCan.getContext('2d'); sCtx.drawImage(imgEl, 0, 0);
  const sData = sCtx.getImageData(0,0,sw,sh).data;
  const oCan = document.createElement('canvas'); oCan.width = outW; oCan.height = outH;
  const oCtx = oCan.getContext('2d');
  const fov = 70 * Math.PI/180; // comfortable default
  const aspect = outW / outH;
  const twoPi = Math.PI * 2;
  const idle = (fn)=> (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 200 }) : setTimeout(fn, 0));
  function insertSorted(yaw, url){
    yawToUrl.set(yaw, url);
    if(!yawList.length){ yawList.push(yaw); }
    else{
      // insert yaw keeping ascending order
      let ins = yawList.length;
      for(let i=0;i<yawList.length;i++){ if(yaw < yawList[i]){ ins = i; break; } }
      yawList.splice(ins, 0, yaw);
    }
    // rebuild frames array in-place to keep reference
    frames.length = 0;
    for(const y of yawList){ frames.push(yawToUrl.get(y)); }
    // prepare bitmap for this yaw
    try{
      createBitmapFromDataUrl(url).then((bm)=>{
        const bmMap = _thumbBitmapMap.get(key) || new Map();
        bmMap.set(yaw, bm);
        _thumbBitmapMap.set(key, bmMap);
        const list = [];
        for(const yy of yawList){ const b = bmMap.get(yy); if(b) list.push(b); }
        _thumbBitmaps.set(key, list);
      }).catch(()=>{});
    }catch{}
  }

  const genFrame = (yawDeg)=> new Promise((resolve)=> idle(()=>{
    const yaw = yawDeg * Math.PI/180;
    const out = oCtx.createImageData(outW, outH);
    const outD = out.data;
    for(let y=0;y<outH;y++){
      const ny = (y / (outH-1)) * 2 - 1; // -1..1 (top->bottom)
      for(let x=0;x<outW;x++){
        const nx = (x / (outW-1)) * 2 - 1; // -1..1 (left->right)
        const lambda = yaw + nx * (2*fov*0.5);        // horizontal angle
        const phi = -ny * (2*fov*0.5) / aspect;       // vertical angle (flip sign: screen y down)
        // Map to equirect UV
        let u = (lambda + Math.PI) / twoPi; // 0..1
        let v = (Math.PI/2 - phi) / Math.PI; // 0..1
        // wrap u
        u = u - Math.floor(u);
        // clamp v
        if(v < 0) v = 0; else if(v > 1) v = 1;
        const sx = Math.min(sw-1, Math.max(0, Math.round(u * (sw-1))));
        const sy = Math.min(sh-1, Math.max(0, Math.round(v * (sh-1))));
        const si = (sy*sw + sx) * 4;
        const di = (y*outW + x) * 4;
        outD[di] = sData[si];
        outD[di+1] = sData[si+1];
        outD[di+2] = sData[si+2];
        outD[di+3] = 255;
      }
    }
    oCtx.putImageData(out, 0, 0);
    const url = oCan.toDataURL('image/jpeg', 0.78);
    insertSorted(yawDeg, url);
    resolve();
  }));
  // Generate the first few frames quickly so animation can start
  const bootstrap = [0, step, -step, 2*step, -2*step];
  for(const yaw of bootstrap){ await genFrame(yaw); }
  // Schedule the rest without blocking UI
  (async ()=>{ for(const yaw of yaws){ if(bootstrap.includes(yaw)) continue; await genFrame(yaw); } })();
  return frames;
}

function createBitmapFromDataUrl(dataUrl){
  // Convert dataURL to ImageBitmap efficiently
  return fetch(dataUrl)
    .then(r => r.blob())
    .then(b => ('createImageBitmap' in window ? createImageBitmap(b) : new Promise((res)=>{ const img=new Image(); img.onload=()=>res(img); img.src= dataUrl; })));
}

function setCardThumb(imgEl, folder, fallback, slug){
  const guesses = [ `${folder}/000-${slug}-thumb.jpg`, `${folder}/000-${slug}.jpg`, fallback ].filter(Boolean);
  // Try guesses in order; set first that loads
  (async ()=>{
    for(const url of guesses){
      const ok = await imageExists(url);
      if(ok){ imgEl.src = url; return; }
    }
    // If none load, leave src as-is
  })();
}

function imageExists(url){
  return new Promise((res)=>{
    if(!url){ res(false); return; }
    const i = new Image();
    i.referrerPolicy = 'no-referrer';
    i.decoding = 'async';
    i.onload = ()=> res(true);
    i.onerror = ()=> res(false);
    // No cache-busting: allow browser/SW cache to make repeat loads instant
    i.src = url;
  });
}

async function assetExists(url){
  try{
    const r = await fetch(url, { method:'HEAD' });
    return r.ok;
  }catch{ return false; }
}

function getProjectSlug(p){
  if(p.slug) return String(p.slug).toLowerCase();
  if(p.id) return String(p.id).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  if(p.folder){
    const parts = p.folder.split('/');
    return parts[parts.length-1].toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  }
  return 'project';
}

function toSlug(s){
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

function toTitle(s){
  return String(s).replace(/[-_]+/g,' ').replace(/\b\w/g, c=> c.toUpperCase());
}
