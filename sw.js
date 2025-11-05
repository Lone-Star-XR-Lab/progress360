const CACHE_VERSION = 'p360-v1';
const IMG_CACHE = `${CACHE_VERSION}-images`;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isSameOrigin(url){
  try {
    const u = new URL(url);
    return u.origin === self.location.origin;
  } catch { return false; }
}

function isImageRequest(req){
  const url = req.url;
  return /\/assets\//.test(url) && /(\.jpe?g|\.png|\.webp|\.avif)(\?|$)/i.test(url);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (!isSameOrigin(req.url)) return;

  // Cache-first for images under assets/
  if (isImageRequest(req)) {
    event.respondWith((async () => {
      const cache = await caches.open(IMG_CACHE);
      const cached = await cache.match(req, { ignoreSearch: false });
      if (cached) return cached;
      try {
        const resp = await fetch(req);
        if (resp && resp.ok) cache.put(req, resp.clone());
        return resp;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }
});

