// Progress360 gallery: loads the project list, renders cards, handles search/filter and
// hash routing (#/<project-id> opens that project in the viewer).
import { openViewer, closeViewer, setCloseHandler, isViewerOpen, formatIsoDate, showToast } from './viewer.js';
import { sortStageFiles, describeStages, MEDIA_RE, IMAGE_RE } from './stages.js';

const BASE_TITLE = document.title;
const MAX_STAGE_INDEX = 40;     // highest NNN probed when stages are auto-discovered
const PHASE_ORDER = ['Planning', 'In Progress', 'Completed'];
const VIDEO_RE = /\.(mp4|webm|ogv|mov)(\?|#|$)/i;

const els = {
  gallery: document.getElementById('gallery'),
  search: document.getElementById('searchInput'),
  chips: document.getElementById('phaseFilters'),
  count: document.getElementById('resultCount'),
  empty: document.getElementById('emptyState'),
};

let projects = [];
const filter = { q: '', phase: 'all' };
const stageCache = new Map();    // id -> Promise<Stage[]>
const thumbCache = new Map();    // id -> Promise<string|null>
let openedFromGallery = false;   // true when the viewer hash was pushed by in-app navigation

// Thumb animation caches (hover pan on cards)
const _thumbFrames = new Map();    // key -> dataURL[] sorted by yaw
const _thumbAnim = new Map();      // key -> { raf }
const _thumbYaw = new Map();       // key -> number[] sorted yaws
const _thumbBitmaps = new Map();   // key -> ImageBitmap[] sorted by yaw
const _thumbBitmapMap = new Map(); // key -> Map(yaw -> ImageBitmap)

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init(){
  setCloseHandler(()=>{
    if(openedFromGallery){ openedFromGallery = false; history.back(); }
    else location.hash = '';
  });
  projects = (await loadProjects()).map(normalizeProject);
  renderChips();
  renderGallery();
  els.search?.addEventListener('input', ()=> { filter.q = els.search.value.trim().toLowerCase(); renderGallery(); });
  els.gallery?.addEventListener('click', (e)=>{
    if(e.target.closest('a.card-link') && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) openedFromGallery = true;
  });
  window.addEventListener('hashchange', route);
  route();
})();

async function loadProjects(){
  let list = [];
  try{
    const res = await fetch('assets/projects.json', { cache: 'no-cache' });
    if(res.ok){
      const json = await res.json();
      list = Array.isArray(json) ? json : (json?.projects || []);
    }
  }catch(err){ console.warn('projects.json could not be loaded', err); }

  // If the server lists directories (Live Server, IIS/nginx with listing on), also show any
  // folder under assets/ that has media but isn't in projects.json yet.
  const dirs = await listFolder('assets', { dirs: true });
  if(dirs){
    const known = new Set(list.map((p)=> String(p.folder || '').replace(/\/+$/, '').toLowerCase()));
    const extra = await Promise.all(dirs.map(async (name)=>{
      const folder = `assets/${name}`;
      if(known.has(folder.toLowerCase())) return null;
      const files = await listFolder(folder);
      if(!files || !files.some((f)=> MEDIA_RE.test(f))) return null;
      return { id: toSlug(name), title: toTitle(name), folder, slug: toSlug(name), meta: { description: 'Not in projects.json yet — run tools/sync-projects.mjs.' } };
    }));
    list = list.concat(extra.filter(Boolean));
  }
  return list;
}

// Read a directory listing page (Live Server, serve-index, IIS, nginx autoindex, Apache).
// Returns file names (or sub-folder names with { dirs: true }), or null if the server doesn't list.
const listingCache = new Map();
function listFolder(folder, { dirs = false } = {}){
  const key = `${folder}|${dirs}`;
  if(!listingCache.has(key)){
    listingCache.set(key, (async ()=>{
      try{
        const res = await fetch(`${folder.replace(/\/+$/, '')}/`, { cache: 'no-cache' });
        if(!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return null;
        const html = await res.text();
        if(/<script[^>]+type=["']importmap/i.test(html)) return null;   // got our own index.html, not a listing
        const names = new Set();
        for(const m of html.matchAll(/href\s*=\s*["']([^"'?#]+)["']/gi)){
          let href = m[1];
          if(/^[a-z]+:/i.test(href) || href.startsWith('..')) continue;
          const isDir = href.endsWith('/');
          if(isDir !== dirs) continue;
          href = href.replace(/\/+$/, '');
          let name = href.split('/').pop();
          try { name = decodeURIComponent(name); } catch {}
          if(!name || name === '.' || name.startsWith('.')) continue;
          // Absolute hrefs must point inside this folder
          if(href.startsWith('/') && !decodeURIComponent(href).toLowerCase().includes(`/${folder.toLowerCase()}/`)) continue;
          names.add(name);
        }
        return [...names];
      }catch{ return null; }
    })());
  }
  return listingCache.get(key);
}

function normalizeProject(p){
  const slug = getProjectSlug(p);
  return {
    ...p,
    id: String(p.id || slug),
    slug,
    title: p.title || toTitle(slug),
    meta: p.meta || {},
    campus: p.campus || {},
    tags: Array.isArray(p.tags) ? p.tags : [],
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
function currentRouteId(){
  const h = location.hash.replace(/^#\/?/, '');
  try { return decodeURIComponent(h); } catch { return h; }
}

function route(){
  const id = currentRouteId();
  if(!id){
    if(location.hash === '#') history.replaceState(null, '', location.pathname + location.search);
    openedFromGallery = false;
    if(isViewerOpen()) closeViewer();
    document.title = BASE_TITLE;
    return;
  }
  const p = projects.find((x)=> x.id === id);
  if(!p){
    showToast('That project could not be found', 'error');
    history.replaceState(null, '', location.pathname + location.search);
    if(isViewerOpen()) closeViewer();
    return;
  }
  document.title = `${p.title} · ${BASE_TITLE}`;
  openViewer({
    id: p.id,
    title: p.title,
    meta: p.meta,
    campus: p.campus,
    tags: p.tags,
    description: p.description || '',
    stages: resolveStages(p),
  }).catch((err)=> console.error('Viewer failed to open', err));
}

// ---------------------------------------------------------------------------
// Stage discovery
// ---------------------------------------------------------------------------
// Stage list, in priority order:
//   1. explicit `stages` in projects.json (written by hand or by tools/sync-projects.mjs)
//   2. the folder's directory listing, if the server provides one (picks up dated names)
//   3. probing NNN-<slug>.jpg|.mp4 (works on any static host, numbered names only)
function resolveStages(p){
  if(!stageCache.has(p.id)){
    stageCache.set(p.id, (async ()=>{
      if(Array.isArray(p.stages) && p.stages.length){
        return describeStages(p.stages.filter((s)=> s?.url).map((s)=> ({
          label: s.label,
          url: /^(https?:)?\/\//.test(s.url) || s.url.startsWith('/') ? s.url : `${p.folder}/${s.url}`,
        })));
      }
      const listed = await listFolder(p.folder);
      if(listed){
        const files = sortStageFiles(listed);
        if(files.length) return describeStages(files.map((f)=> ({ url: `${p.folder}/${f}` })));
      }
      const urls = await discoverStages(p);
      return describeStages(urls.map((url)=> ({ url })));
    })());
  }
  return stageCache.get(p.id);
}

// Probes <folder>/NNN-<slug>.jpg|.mp4 in small parallel batches. Stops at the first batch with
// no hits once something has been found. 999-<slug>.* is treated as the final "Current" stage.
async function discoverStages(p){
  const { folder, slug } = p;
  const pad = (n)=> String(n).padStart(3, '0');
  const BATCH = 4;
  const hits = [];
  for(let start = 0; start < MAX_STAGE_INDEX; start += BATCH){
    const idx = Array.from({ length: BATCH }, (_, k)=> start + k);
    const results = await Promise.all(idx.map(async (i)=>{
      const jpg = `${folder}/${pad(i)}-${slug}.jpg`;
      if(await exists(jpg)) return jpg;
      const mp4 = `${folder}/${pad(i)}-${slug}.mp4`;
      return (await exists(mp4)) ? mp4 : null;
    }));
    const batchHits = results.filter(Boolean);
    hits.push(...batchHits);
    if(!batchHits.length && (hits.length || start >= 8)) break;
  }
  for(const ext of ['jpg', 'mp4']){
    const url = `${folder}/999-${slug}.${ext}`;
    if(await exists(url)){ hits.push(url); break; }
  }
  return hits;
}

const existsCache = new Map();
function exists(url){
  if(!existsCache.has(url)){
    existsCache.set(url, (async ()=>{
      try{
        const r = await fetch(url, { method: 'HEAD' });
        if(r.ok) return true;
        if(r.status === 405 || r.status === 501) return imageExists(url); // server without HEAD support
        return false;
      }catch{ return false; }
    })());
  }
  return existsCache.get(url);
}

function imageExists(url){
  return new Promise((res)=>{
    if(!url || VIDEO_RE.test(url)){ res(false); return; }
    const i = new Image();
    i.onload = ()=> res(true);
    i.onerror = ()=> res(false);
    i.src = url;
  });
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------
function phaseKey(s){ return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

function renderChips(){
  if(!els.chips) return;
  const phases = [...new Set(projects.map((p)=> p.meta.phase).filter(Boolean))]
    .sort((a, b)=> (PHASE_ORDER.indexOf(a) + 1 || 99) - (PHASE_ORDER.indexOf(b) + 1 || 99));
  const make = (value, label, count)=>{
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.value = value;
    b.setAttribute('aria-pressed', String(filter.phase === value));
    if(value !== 'all') b.dataset.phase = phaseKey(value);
    b.innerHTML = `<span></span><span class="chip-count"></span>`;
    b.firstChild.textContent = label;
    b.lastChild.textContent = count;
    b.addEventListener('click', ()=>{
      filter.phase = value;
      els.chips.querySelectorAll('.chip').forEach((c)=> c.setAttribute('aria-pressed', String(c.dataset.value === value)));
      renderGallery();
    });
    return b;
  };
  els.chips.replaceChildren(
    make('all', 'All', projects.length),
    ...phases.map((ph)=> make(ph, ph, projects.filter((p)=> p.meta.phase === ph).length)),
  );
  els.chips.hidden = phases.length < 2;
}

function matches(p){
  if(filter.phase !== 'all' && p.meta.phase !== filter.phase) return false;
  if(!filter.q) return true;
  const hay = [p.title, p.meta.description, p.meta.location, p.meta.phase,
    p.campus.campus, p.campus.building, p.campus.room, ...p.tags].join(' ').toLowerCase();
  return filter.q.split(/\s+/).every((w)=> hay.includes(w));
}

const cardCache = new Map();   // id -> element (keeps thumb animation state across filtering)
function renderGallery(){
  if(!els.gallery) return;
  const list = projects.filter(matches);
  els.gallery.replaceChildren(...list.map((p)=>{
    if(!cardCache.has(p.id)) cardCache.set(p.id, createCard(p));
    return cardCache.get(p.id);
  }));
  if(els.count){
    els.count.textContent = projects.length
      ? (list.length === projects.length ? `${projects.length} projects` : `${list.length} of ${projects.length} projects`)
      : '';
  }
  if(els.empty){
    els.empty.hidden = list.length > 0;
    els.empty.textContent = projects.length
      ? 'No projects match your search.'
      : 'No projects found. Add one to assets/projects.json — see docs/adding-projects.md.';
  }
}

const icon = (id)=> `<svg class="icon" aria-hidden="true"><use href="#${id}"/></svg>`;

function createCard(p){
  const card = document.createElement('article');
  card.className = 'card';

  const link = document.createElement('a');
  link.className = 'card-link';
  link.href = `#/${encodeURIComponent(p.id)}`;
  link.setAttribute('aria-label', `Open ${p.title} in the 360° viewer`);

  const media = document.createElement('div');
  media.className = 'card-media';
  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  const anim = document.createElement('div');
  anim.className = 'thumb-bg';
  const canvas = document.createElement('canvas');
  canvas.className = 'thumb-canvas';
  const badges = document.createElement('div');
  badges.className = 'card-badges';
  badges.innerHTML = `<span class="badge">360°</span>`;
  const cta = document.createElement('span');
  cta.className = 'card-cta';
  cta.textContent = 'Step inside →';
  media.append(img, anim, canvas, badges, cta);

  const body = document.createElement('div');
  body.className = 'card-body';
  const top = document.createElement('div');
  top.className = 'card-top';
  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = p.title;
  top.appendChild(title);
  if(p.meta.phase){
    const phase = document.createElement('span');
    phase.className = 'phase';
    phase.dataset.phase = phaseKey(p.meta.phase);
    phase.textContent = p.meta.phase;
    top.appendChild(phase);
  }
  body.appendChild(top);

  const place = [p.meta.location, p.campus.campus].filter(Boolean).filter((v, i, a)=> a.indexOf(v) === i).join(' · ');
  if(place){
    const meta = document.createElement('p');
    meta.className = 'card-meta';
    meta.innerHTML = icon('i-pin');
    meta.append(place);
    body.appendChild(meta);
  }
  if(p.meta.description){
    const desc = document.createElement('p');
    desc.className = 'card-desc';
    desc.textContent = p.meta.description;
    body.appendChild(desc);
  }
  const foot = document.createElement('div');
  foot.className = 'card-foot';
  if(p.meta.updated){
    const t = document.createElement('time');
    t.dateTime = p.meta.updated;
    t.textContent = `Updated ${formatIsoDate(p.meta.updated)}`;
    foot.appendChild(t);
  }
  const stagesEl = document.createElement('span');
  stagesEl.className = 'card-stages';
  foot.appendChild(stagesEl);
  body.appendChild(foot);

  link.append(media, body);
  card.appendChild(link);

  // Resolve the lightest available thumbnail before loading anything
  const key = p.id;
  resolveThumb(p).then((url)=>{
    if(!url){ media.classList.add('no-thumb'); return; }
    img.addEventListener('load', ()=> prepareThumb(img, anim, key), { once: true });
    img.src = url;
  });

  // When the card scrolls into view, discover its stages (makes opening instant + fills badges)
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries)=>{
    if(!entries.some((e)=> e.isIntersecting)) return;
    io.disconnect();
    idle(()=> resolveStages(p).then((stages)=>{
      if(stages.length) stagesEl.textContent = `${stages.length} stage${stages.length > 1 ? 's' : ''}`;
      if(stages.some((s)=> VIDEO_RE.test(s.url))){
        const b = document.createElement('span');
        b.className = 'badge video';
        b.textContent = 'Video';
        badges.appendChild(b);
      }
    }));
  }, { rootMargin: '200px' }) : null;
  if(io) io.observe(card); else resolveStages(p);

  // Hover: warm the first stages, and animate the pano pan
  let warmed = false;
  const warm = ()=>{
    if(warmed) return;
    warmed = true;
    resolveStages(p).then((stages)=> stages.slice(0, 2).forEach((s)=> { if(!VIDEO_RE.test(s.url)) new Image().src = s.url; }));
  };
  const start = ()=> { warm(); startThumbAnim(key, media, canvas); };
  const stop = ()=> stopThumbAnim(key, media, canvas);
  link.addEventListener('mouseenter', start);
  link.addEventListener('focus', start);
  link.addEventListener('mouseleave', stop);
  link.addEventListener('blur', stop);
  link.addEventListener('touchstart', warm, { passive: true });
  return card;
}

function resolveThumb(p){
  if(!thumbCache.has(p.id)){
    thumbCache.set(p.id, (async ()=>{
      const guesses = [`${p.folder}/000-${p.slug}-thumb.jpg`, p.thumb, `${p.folder}/000-${p.slug}.jpg`]
        .filter(Boolean).filter((v, i, a)=> a.indexOf(v) === i);
      for(const url of guesses){ if(await exists(url)) return url; }
      // No numbered first stage (e.g. only dated files): use the first image stage
      const first = (await resolveStages(p)).find((s)=> IMAGE_RE.test(s.url.split(/[?#]/)[0]));
      if(first){
        const thumb = first.url.replace(/(\.[^./]+)$/, '-thumb.jpg');
        if(await exists(thumb)) return thumb;
        return first.url;
      }
      return null;
    })());
  }
  return thumbCache.get(p.id);
}

const idle = (fn, timeout = 500)=> (window.requestIdleCallback ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 60));

// ---------------------------------------------------------------------------
// Card thumbnail pan animation
// Reprojects the equirect thumbnail into a sweep of small rectilinear frames (±24° yaw) and
// ping-pongs through them on hover.
// ---------------------------------------------------------------------------
function prepareThumb(img, anim, key){
  idle(()=>{
    try{
      anim.style.backgroundImage = `url("${img.currentSrc || img.src}")`;
      makeThumbFrames(img, key).then((frames)=>{
        if(!frames?.length) return;
        anim.style.backgroundImage = `url("${frames[centerFrameIndex(key)]}")`;
      }).catch(()=>{});
    }catch{}
  });
}

function centerFrameIndex(key){
  const yaws = _thumbYaw.get(key) || [];
  let best = Infinity, bi = 0;
  yaws.forEach((y, i)=> { if(Math.abs(y) < best){ best = Math.abs(y); bi = i; } });
  return bi;
}

function sizeCanvas(media, canvas){
  const dpr = window.devicePixelRatio || 1;
  const r = media.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if(canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  return ctx;
}

function startThumbAnim(key, media, canvas){
  if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const bm = _thumbBitmaps.get(key) || [];
  if(bm.length < 8) return;   // wait for a few frames
  stopThumbAnim(key, media, canvas, false);
  const ctx = sizeCanvas(media, canvas);
  let i = centerFrameIndex(key), dir = 1, last = performance.now();
  const loop = (t)=>{
    if(!_thumbAnim.has(key)) return;
    if(t - last >= 42){   // ~24 fps
      last = t;
      const frames = _thumbBitmaps.get(key) || bm;
      i = Math.min(i, frames.length - 1);
      try { ctx.drawImage(frames[i], 0, 0, canvas.width, canvas.height); } catch {}
      i += dir;
      if(i >= frames.length - 1){ i = frames.length - 1; dir = -1; }
      else if(i <= 0){ i = 0; dir = 1; }
    }
    _thumbAnim.set(key, { raf: requestAnimationFrame(loop) });
  };
  _thumbAnim.set(key, { raf: requestAnimationFrame(loop) });
}

function stopThumbAnim(key, media, canvas, drawRest = true){
  const st = _thumbAnim.get(key);
  if(st?.raf) cancelAnimationFrame(st.raf);
  _thumbAnim.delete(key);
  if(!drawRest) return;
  const bm = _thumbBitmaps.get(key) || [];
  const frame = bm[centerFrameIndex(key)];
  if(!frame) return;
  const ctx = sizeCanvas(media, canvas);
  try { ctx.drawImage(frame, 0, 0, canvas.width, canvas.height); } catch {}
}

async function makeThumbFrames(imgEl, key){
  if(_thumbFrames.has(key)) return _thumbFrames.get(key);
  const frames = [];
  _thumbFrames.set(key, frames);
  const yawList = [];
  const yawToUrl = new Map();
  _thumbYaw.set(key, yawList);
  _thumbBitmapMap.set(key, new Map());

  const outW = Math.max(320, Math.min(600, imgEl.clientWidth || 480));
  const outH = Math.round(outW * 9 / 16);
  const maxYaw = 24, step = 2;   // degrees
  const yaws = [];
  for(let a = -maxYaw; a <= maxYaw; a += step) yaws.push(a);

  const sw = imgEl.naturalWidth || imgEl.width;
  const sh = imgEl.naturalHeight || imgEl.height;
  if(!sw || !sh) return frames;
  const sCan = document.createElement('canvas'); sCan.width = sw; sCan.height = sh;
  const sCtx = sCan.getContext('2d', { willReadFrequently: true });
  sCtx.drawImage(imgEl, 0, 0);
  const sData = sCtx.getImageData(0, 0, sw, sh).data;
  const oCan = document.createElement('canvas'); oCan.width = outW; oCan.height = outH;
  const oCtx = oCan.getContext('2d');
  const fov = 70 * Math.PI / 180;
  const aspect = outW / outH;
  const twoPi = Math.PI * 2;

  function insertSorted(yaw, url){
    yawToUrl.set(yaw, url);
    let ins = yawList.findIndex((y)=> yaw < y);
    if(ins < 0) ins = yawList.length;
    yawList.splice(ins, 0, yaw);
    frames.length = 0;
    for(const y of yawList) frames.push(yawToUrl.get(y));
    createBitmapFromDataUrl(url).then((bm)=>{
      const bmMap = _thumbBitmapMap.get(key);
      bmMap.set(yaw, bm);
      _thumbBitmaps.set(key, yawList.map((y)=> bmMap.get(y)).filter(Boolean));
    }).catch(()=>{});
  }

  const genFrame = (yawDeg)=> new Promise((resolve)=> idle(()=>{
    const yaw = yawDeg * Math.PI / 180;
    const out = oCtx.createImageData(outW, outH);
    const outD = out.data;
    for(let y = 0; y < outH; y++){
      const ny = (y / (outH - 1)) * 2 - 1;
      for(let x = 0; x < outW; x++){
        const nx = (x / (outW - 1)) * 2 - 1;
        const lambda = yaw + nx * fov;
        const phi = -ny * fov / aspect;
        let u = (lambda + Math.PI) / twoPi;
        let v = (Math.PI / 2 - phi) / Math.PI;
        u -= Math.floor(u);
        v = v < 0 ? 0 : v > 1 ? 1 : v;
        const sx = Math.round(u * (sw - 1));
        const sy = Math.round(v * (sh - 1));
        const si = (sy * sw + sx) * 4;
        const di = (y * outW + x) * 4;
        outD[di] = sData[si]; outD[di + 1] = sData[si + 1]; outD[di + 2] = sData[si + 2]; outD[di + 3] = 255;
      }
    }
    oCtx.putImageData(out, 0, 0);
    insertSorted(yawDeg, oCan.toDataURL('image/jpeg', 0.78));
    resolve();
  }, 200));

  const bootstrap = [0, step, -step, 2 * step, -2 * step];
  for(const yaw of bootstrap) await genFrame(yaw);
  (async ()=>{ for(const yaw of yaws){ if(!bootstrap.includes(yaw)) await genFrame(yaw); } })();
  return frames;
}

function createBitmapFromDataUrl(dataUrl){
  return fetch(dataUrl).then((r)=> r.blob()).then((b)=> 'createImageBitmap' in window
    ? createImageBitmap(b)
    : new Promise((res)=>{ const i = new Image(); i.onload = ()=> res(i); i.src = dataUrl; }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getProjectSlug(p){
  if(p.slug) return String(p.slug).toLowerCase();
  if(p.id) return toSlug(p.id);
  if(p.folder) return toSlug(p.folder.split('/').pop());
  return 'project';
}
function toSlug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function toTitle(s){ return String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c)=> c.toUpperCase()); }
