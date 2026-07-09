// KTLSALES service worker — minimal, required by Chrome/Android for the
// "Install app" prompt to appear. Does not cache anything by default,
// so the app always loads fresh data (Supabase calls are unaffected).

const CACHE_NAME = 'ktlsales-shell-v1';

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
  event.respondWith(fetch(event.request));
});
