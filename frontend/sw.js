// Minimal pass-through service worker.
//
// No caching on purpose: this app is a live terminal, and a cached shell would
// hide a redeploy. Its only job is to exist with a fetch handler, which is what
// makes the app installable to the home screen.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* default network handling */ });
