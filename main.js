import { openViewer } from './viewer.js';


const galleryEl = document.getElementById('gallery');
const dataEl = document.getElementById('projects-data');
let projects = [];

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
  btn.addEventListener('click', async ()=> {
  let stages = Array.isArray(p.stages) && p.stages.length
    ? p.stages.map(s=> ({ label: s.label, url: s.url.startsWith('http') ? s.url : `${p.folder}/${s.url}` }))
    : await discoverStages(p);
  if(!stages || stages.length === 0){
    stages = [
      { label: 'Before', url: `${p.folder}/before.jpg` },
      { label: 'After',  url: `${p.folder}/after.jpg` }
    ];
  }
  openViewer({ id: p.id, title: p.title, stages });
});


  const img = document.createElement('img');
  // Prefer first stage 000-<slug>.jpg as the preview; fall back to provided thumb.
  const slug = getProjectSlug(p);
  img.src = p.thumb || `${p.folder}/000-${slug}.jpg`;
  setCardThumb(img, p.folder, p.thumb, slug);
  img.alt = `${p.title} thumbnail`;
  img.loading = 'lazy';
  img.className = 'thumb';


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
card.appendChild(btn);
card.appendChild(body);
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
function setCardThumb(imgEl, folder, fallback, slug){
  const guesses = [ `${folder}/000-${slug}.jpg`, fallback ].filter(Boolean);
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
    i.onload = ()=> res(true);
    i.onerror = ()=> res(false);
    i.src = url + (url.includes('?')?'&':'?') + 'cb=' + Date.now();
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
