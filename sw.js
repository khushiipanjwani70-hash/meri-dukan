// Offline ke liye zaroori: ye file app ko phone mein save karti hai taake internet ke baghair khul sake.
const C = 'meri-dukan-v1';
const FILES = ['./', 'index.html', 'style.css', 'script.js', 'manifest.json'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || !(u.origin === location.origin || u.hostname === 'cdn.jsdelivr.net')) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(C).then(c => c.put(e.request, copy)) }
    return r;
  }).catch(() => caches.match(e.request).then(m => m || caches.match('index.html'))));
});
