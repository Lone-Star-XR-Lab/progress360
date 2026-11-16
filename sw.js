// Progress360 service worker.
//   • Panorama images under /assets/ → cache-first (they're big and rarely change).
//   • App shell (pages, JS, CSS, projects.json, manifest, icons, vendor libs) → network-first,
//     falling back to the cache so the site still opens offline or on a bad connection.
// Bump CACHE_VERSION whenever you replace an image in place (same file name) so
// visitors don't keep seeing the old one. See docs/deployment.md.
const CACHE_VERSION = 'p360-v3';
const IMG_CACHE = `${CACHE_VERSION}-images`;
const SHELL_CACHE = `${CACHE_VERSION}-shell`;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './main.js',
  './viewer.js',
  './stages.js',
  './exif.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './vendor/three/three.module.js',
  './vendor/three/addons/controls/OrbitControls.js',
  './vendor/three/addons/webxr/VRButton.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Best effort: one missing file must not stop the worker installing.
    await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function sameOrigin(req){
  try { return new URL(req.url).origin === self.location.origin; } catch { return false; }
}

function isCacheableImage(req, url){
  return /\/assets\//.test(url.pathname) && /\.(jpe?g|png|webp|avif)$/i.test(url.pathname);
}

function isShell(req, url){
  if (req.mode === 'navigate') return true;
  if (/\/assets\/projects\.json$/i.test(url.pathname)) return true;
  if (/\/assets\//.test(url.pathname)) return false;            // media stays out of the shell cache
  return /\.(html|js|mjs|css|json|webmanifest|svg|png)$/i.test(url.pathname) || url.pathname.endsWith('/');
}

async function cacheFirst(req){
  const cache = await caches.open(IMG_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp && resp.status === 200) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  } catch {
    return Response.error();
  }
}

async function networkFirst(req){
  const cache = await caches.open(SHELL_CACHE);
  // Navigations carry the hash/query (#/project?stage=2); the page itself is the same file.
  const opts = { ignoreSearch: req.mode === 'navigate' };
  try {
    const resp = await fetch(req);
    if (resp && resp.status === 200) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  } catch {
    const cached = await cache.match(req, opts)
      || (req.mode === 'navigate' ? await cache.match('./index.html') || await cache.match('./') : null);
    return cached || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !sameOrigin(req)) return;
  if (req.headers.has('range')) return;                   // partial requests (EXIF reads, video) go to the network
  const url = new URL(req.url);
  if (isCacheableImage(req, url)) event.respondWith(cacheFirst(req));
  else if (isShell(req, url)) event.respondWith(networkFirst(req));
});
