// KTLSALES service worker — minimal, required by Chrome/Android for the
// "Install app" prompt to appear. Only the face-recognition model files are
// cached (see MODELS_CACHE); everything else, including all Supabase calls,
// is always fetched fresh.

const CACHE_NAME = 'ktlsales-shell-v1';
// Face-recognition models (~6.8 MB) are saved on the phone after the first download,
// so "Verify Now" opens straight away afterwards. Bump the version if the models change.
const MODELS_CACHE = 'ktlsales-face-models-v1';
const isModelFile = url =>
  (url.origin === self.location.origin && url.pathname.startsWith('/models/')) ||
  url.href.startsWith('https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights/');  // backup source

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch handler. Required for the app to be installable,
// but we deliberately do NOT cache API/data calls so Supabase data
// always stays live and fresh.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method === 'GET' && isModelFile(new URL(req.url))) {
    // Use the copy saved on the phone; download (and save) only if it isn't there yet
    event.respondWith(caches.open(MODELS_CACHE).then(async cache => {
      const saved = await cache.match(req);
      if (saved) return saved;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  event.respondWith(fetch(event.request));   // everything else stays live, as before
});
