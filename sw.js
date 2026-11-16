// Progress360 service worker: cache-first for panorama images under /assets/.
// Bump CACHE_VERSION whenever you replace an image in place (same file name) so
// visitors don't keep seeing the old one. See docs/deployment.md.
const CACHE_VERSION = 'p360-v2';
const IMG_CACHE = `${CACHE_VERSION}-images`;

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isCacheableImage(req){
  if (req.method !== 'GET') return false;
  if (req.headers.has('range')) return false;          // partial requests (EXIF reads) go to the network
  let url;
  try { url = new URL(req.url); } catch { return false; }
  if (url.origin !== self.location.origin) return false;
  return /\/assets\//.test(url.pathname) && /\.(jpe?g|png|webp|avif)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!isCacheableImage(req)) return;
  event.respondWith((async () => {
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
  })());
});
