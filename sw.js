const CACHE_PREFIX = 'dads-music-v';
const CACHE_NAME = 'dads-music-v32';
const SHELL = ['./', './index.html', './manifest.json?v=7', './dad-icon.png?v=4', './styles.css?v=3', './dad-writer-bridge.js?v=2', './audio-storage.js?v=3', './metadata.js?v=1', './track-list-display.js?v=1', './app.js?v=9', './player-artwork.js?v=2', './media-session-controls.js?v=5', './now-playing-fullscreen.js?v=2', './reset.html', './privacy.html', './terms.html'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // Shared origin: never intercept or cache another app's requests.
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response.ok) event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
      if (response.ok || request.mode !== 'navigate') return response;
    } catch {}
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    return Response.error();
  })());
});
