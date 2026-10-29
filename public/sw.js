// network-first so a new deploy is picked up (the old cache-first file served stale code forever)
const C = 'v2';
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(C).then(c => c.addAll(['/', '/app.js', '/sync.js', '/players.js'])));
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin ||
      u.pathname.startsWith('/api/') || u.pathname.startsWith('/auth/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => { const copy = r.clone(); caches.open(C).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
