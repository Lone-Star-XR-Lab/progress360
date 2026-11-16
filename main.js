// Progress360 gallery: loads the project list, renders cards, handles search/filter and
// hash routing (#/<project-id> opens that project in the viewer).
import { openViewer, closeViewer, setCloseHandler, setProjectDirectory, isViewerOpen, formatIsoDate, showToast, EMBED_MODE } from './viewer.js';
import { sortStageFiles, describeStages, MEDIA_RE, IMAGE_RE } from './stages.js';
import { readExif } from './exif.js';

const BASE_TITLE = document.title;
const MAX_STAGE_INDEX = 40;     // highest NNN probed when stages are auto-discovered
const PHASE_ORDER = ['Planning', 'In Progress', 'Completed'];
const VIDEO_RE = /\.(mp4|webm|ogv|mov)(\?|#|$)/i;
const NEW_DAYS = 30;            // "New" badge for projects updated within this many days

const els = {
  gallery: document.getElementById('gallery'),
  search: document.getElementById('searchInput'),
  chips: document.getElementById('phaseFilters'),
  count: document.getElementById('resultCount'),
  empty: document.getElementById('emptyState'),
  sort: document.getElementById('sortSelect'),
  group: document.getElementById('groupSelect'),
  gridBtn: document.getElementById('gridViewBtn'),
  mapBtn: document.getElementById('mapViewBtn'),
  mapView: document.getElementById('mapView'),
  map: document.getElementById('map'),
  mapNote: document.getElementById('mapNote'),
};

let projects = [];
const filter = { q: '', phase: 'all', sort: pref('sort', 'updated'), group: pref('group', 'none'), view: pref('view', 'grid') };
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
  if(EMBED_MODE) document.body.classList.add('embed');
  projects = (await loadProjects()).map(normalizeProject);
  setProjectDirectory(Object.fromEntries(projects.map((p)=> [p.id, p.title])));
  if(els.sort) els.sort.value = filter.sort;
  if(els.group) els.group.value = filter.group;
  renderChips();
  setGalleryView(filter.view);
  els.search?.addEventListener('input', ()=> { filter.q = els.search.value.trim().toLowerCase(); renderGallery(); });
  els.sort?.addEventListener('change', ()=> { filter.sort = els.sort.value; setPref('sort', filter.sort); renderGallery(); });
  els.group?.addEventListener('change', ()=> { filter.group = els.group.value; setPref('group', filter.group); renderGallery(); });
  els.gridBtn?.addEventListener('click', ()=> setGalleryView('grid'));
  els.mapBtn?.addEventListener('click', ()=> setGalleryView('map'));
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
// #/<id>?stage=2&yaw=30&pitch=-5  →  { id, opts }
function currentRoute(){
  const h = location.hash.replace(/^#\/?/, '');
  const [rawId, query = ''] = h.split('?');
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch {}
  const q = new URLSearchParams(query);
  const num = (k)=> (q.has(k) && Number.isFinite(parseFloat(q.get(k))) ? parseFloat(q.get(k)) : undefined);
  return { id, opts: { stage: num('stage'), yaw: num('yaw'), pitch: num('pitch') } };
}

function route(){
  const { id, opts } = currentRoute();
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
    ...p,
    description: p.description || '',
    stages: resolveStages(p),
  }, opts).catch((err)=> console.error('Viewer failed to open', err));
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
function sortProjects(list){
  const byTitle = (a, b)=> a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
  if(filter.sort === 'name') return list.slice().sort(byTitle);
  if(filter.sort === 'updated') return list.slice().sort((a, b)=> (b.meta.updated || '').localeCompare(a.meta.updated || '') || byTitle(a, b));
  return list;
}

function groupKey(p){
  if(filter.group === 'site') return p.campus.campus || 'Other';
  if(filter.group === 'phase') return p.meta.phase || 'No phase';
  return '';
}

function renderGallery(){
  if(!els.gallery) return;
  const list = sortProjects(projects.filter(matches));
  const nodes = [];
  if(filter.group === 'none'){
    list.forEach((p)=> nodes.push(cardFor(p)));
  } else {
    const groups = new Map();
    list.forEach((p)=> { const k = groupKey(p); if(!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
    const keys = [...groups.keys()];
    if(filter.group === 'phase') keys.sort((a, b)=> (PHASE_ORDER.indexOf(a) + 1 || 99) - (PHASE_ORDER.indexOf(b) + 1 || 99));
    else keys.sort((a, b)=> (a === 'Other') - (b === 'Other') || a.localeCompare(b));
    for(const k of keys){
      const h = document.createElement('h2');
      h.className = 'group-heading';
      h.textContent = k;
      const c = document.createElement('span');
      c.className = 'group-count';
      c.textContent = String(groups.get(k).length);
      h.appendChild(c);
      nodes.push(h, ...groups.get(k).map(cardFor));
    }
  }
  els.gallery.replaceChildren(...nodes);
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
  if(filter.view === 'map') renderMap(list);
}

function cardFor(p){
  if(!cardCache.has(p.id)) cardCache.set(p.id, createCard(p));
  return cardCache.get(p.id);
}

function isNew(p){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.meta.updated || '');
  if(!m) return false;
  const age = (Date.now() - new Date(+m[1], +m[2] - 1, +m[3]).getTime()) / 864e5;
  return age >= 0 && age <= NEW_DAYS;
}

// ---------------------------------------------------------------------------
// Map view (Leaflet, vendored; OpenStreetMap tiles). A project's location comes from
// meta.gps in projects.json, or else from the GPS EXIF of its first image.
// ---------------------------------------------------------------------------
function setGalleryView(view){
  filter.view = view === 'map' ? 'map' : 'grid';
  setPref('view', filter.view);
  els.gridBtn?.setAttribute('aria-pressed', String(filter.view === 'grid'));
  els.mapBtn?.setAttribute('aria-pressed', String(filter.view === 'map'));
  if(els.gallery) els.gallery.hidden = filter.view === 'map';
  if(els.mapView) els.mapView.hidden = filter.view !== 'map';
  if(els.group) els.group.disabled = filter.view === 'map';
  renderGallery();
}

let leafletP = null;
function ensureLeaflet(){
  if(window.L) return Promise.resolve(window.L);
  if(!leafletP){
    leafletP = new Promise((resolve, reject)=>{
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = 'vendor/leaflet/leaflet.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = 'vendor/leaflet/leaflet.js';
      js.onload = ()=> resolve(window.L);
      js.onerror = reject;
      document.head.appendChild(js);
    });
  }
  return leafletP;
}

// Private projects (campus "Private", e.g. someone's home) never use the GPS stored in their
// photos: they only appear on the map with an explicit meta.gps. meta.gps: false hides any project.
const isPrivate = (p)=> /^private$/i.test(String(p.campus.campus || '').trim());

async function gpsFor(p){
  const g = p.meta.gps;
  if(g === false) return null;
  if(Array.isArray(g) && g.length === 2) return { lat: +g[0], lon: +g[1] };
  if(g && Number.isFinite(+g.lat) && Number.isFinite(+(g.lon ?? g.lng))) return { lat: +g.lat, lon: +(g.lon ?? g.lng) };
  if(isPrivate(p)) return null;
  const stages = await resolveStages(p);
  for(const s of stages){
    if(!/\.jpe?g(\?|#|$)/i.test(s.url)) continue;
    const { gps } = await readExif(s.url);
    if(gps) return gps;
  }
  return null;
}

let map = null, markerLayer = null, mapSeq = 0;
async function renderMap(list){
  const seq = ++mapSeq;
  let L;
  try { L = await ensureLeaflet(); } catch { if(els.mapNote) els.mapNote.textContent = 'The map could not be loaded.'; return; }
  if(seq !== mapSeq) return;
  if(!map){
    map = L.map(els.map, { scrollWheelZoom: true, worldCopyJump: true }).setView([30.1, -95.6], 10);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
  }
  setTimeout(()=> map.invalidateSize(), 0);
  if(els.mapNote) els.mapNote.textContent = 'Finding project locations…';
  const located = await Promise.all(list.map(async (p)=> ({ p, gps: await gpsFor(p).catch(()=> null) })));
  if(seq !== mapSeq) return;

  // Projects within ~100 m of each other (same building) share one marker
  const spots = new Map();
  for(const { p, gps } of located){
    if(!gps) continue;
    const k = `${gps.lat.toFixed(3)},${gps.lon.toFixed(3)}`;
    if(!spots.has(k)) spots.set(k, { sum: { lat: 0, lon: 0 }, items: [] });
    const spot = spots.get(k);
    spot.items.push(p);
    spot.sum.lat += gps.lat; spot.sum.lon += gps.lon;
  }
  for(const spot of spots.values()) spot.gps = { lat: spot.sum.lat / spot.items.length, lon: spot.sum.lon / spot.items.length };
  markerLayer.clearLayers();
  const bounds = [];
  for(const { gps, items } of spots.values()){
    const icon = L.divIcon({
      className: 'map-pin',
      html: `<span>${items.length > 1 ? items.length : ''}</span>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
    const m = L.marker([gps.lat, gps.lon], { icon, title: items.map((p)=> p.title).join(', ') });
    m.bindPopup(()=> mapPopup(items), { maxWidth: 280, minWidth: 220 });
    markerLayer.addLayer(m);
    bounds.push([gps.lat, gps.lon]);
  }
  if(bounds.length === 1) map.setView(bounds[0], 17);
  else if(bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
  const unplaced = located.filter((x)=> !x.gps);
  const hidden = unplaced.filter((x)=> x.p.meta.gps === false || isPrivate(x.p)).length;
  const missing = unplaced.filter((x)=> !(x.p.meta.gps === false || isPrivate(x.p))).map((x)=> x.p.title);
  const shown = located.length - unplaced.length;
  if(els.mapNote){
    const parts = [`${shown} project${shown === 1 ? '' : 's'} on the map.`];
    if(hidden) parts.push(`${hidden} private project${hidden === 1 ? ' is' : 's are'} not shown.`);
    if(missing.length) parts.push(`No location yet (add meta.gps): ${missing.join(', ')}.`);
    els.mapNote.textContent = parts.join(' ');
  }
}

function mapPopup(items){
  const root = document.createElement('div');
  root.className = 'map-popup';
  for(const p of items){
    const a = document.createElement('a');
    a.href = `#/${encodeURIComponent(p.id)}`;
    a.className = 'map-item';
    a.addEventListener('click', ()=> { openedFromGallery = true; });
    const img = document.createElement('img');
    img.alt = '';
    resolveThumb(p).then((u)=> { if(u) img.src = u; });
    const text = document.createElement('span');
    const t = document.createElement('strong'); t.textContent = p.title;
    const sub = document.createElement('small'); sub.textContent = [p.meta.phase, p.campus.room || p.meta.location].filter(Boolean).join(' · ');
    text.append(t, sub);
    a.append(img, text);
    root.appendChild(a);
  }
  return root;
}

function pref(key, fallback){
  try { const v = localStorage.getItem(`p360:gallery:${key}`); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function setPref(key, value){ try { localStorage.setItem(`p360:gallery:${key}`, JSON.stringify(value)); } catch {} }

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
  if(isNew(p)){
    const nb = document.createElement('span');
    nb.className = 'badge new';
    nb.textContent = 'New';
    badges.appendChild(nb);
  }
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
