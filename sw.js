const CACHE_NAME = 'dads-music-v22';
const CACHE_PREFIX = 'dads-music-v';
const MEDIA_CONTROLS_JS = './media-session-controls.js?v=3';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=3',
  './audio-storage.js?v=1',
  './oauth-gesture.js?v=5',
  './reliability-guard.js?v=4',
  './metadata.js?v=1',
  './track-list-display.js?v=1',
  './app.js?v=4',
  './playback-policy.js?v=2',
  './player-artwork.js?v=1',
  './now-playing-fullscreen.js?v=1',
  MEDIA_CONTROLS_JS,
  './manifest.json?v=5',
  '/lexi-assets/music-logo.png?v=2',
  './reset.html',
  './privacy.html',
  './terms.html',
  './oauth-home.html'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function injectMediaControls(response) {
  if (!response) return response;
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  const text = await response.text();
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('etag');
  const html = text.includes('media-session-controls.js')
    ? text
    : text.replace('</body>', '  <script src="./media-session-controls.js?v=3" defer></script>\n</body>');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone()).catch(() => {});
      }
      return request.mode === 'navigate' ? injectMediaControls(response) : response;
    } catch {
      const cached = (await caches.match(request)) || (request.mode === 'navigate' ? await caches.match('./index.html') : null);
      return request.mode === 'navigate' ? injectMediaControls(cached) : cached;
    }
  })());
});
