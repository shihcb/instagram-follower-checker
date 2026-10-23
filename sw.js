// Offline support for the installed app. Network first, always: the live
// files win whenever there's a connection (so an update is never hidden
// behind a stale copy); the cached copy is only used when offline.
//
// Registered as sw.js?v=<the app's version> (features.js, setupInstall):
// every release is a new worker with a cache of its own, named after that
// version, and the old one is dropped once it takes over.
const VERSION = new URL(self.location.href).searchParams.get('v') || '0';
const CACHE = 'ig-checker-' + VERSION;

// The app's own files are kept from the first visit (they used to be kept
// only from the second: opened offline after one visit, the installed app
// was the browser's error page). The page's own links are read for the
// exact ?v= tags it asks for, so the offline copy is this version's, not
// whichever was fetched last. A file that can't be fetched is skipped.
const APP_FILES = ['./', './index.html', './manifest.json', './vendor/supabase-2.118.0.js',
  './images/app-icon.png', './images/apple-touch-icon.png'];
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    let tagged = ['./style.css', './script.js', './features.js', './fonts/ledger-serif.woff2'];
    try {
      const page = await (await fetch('./index.html', { cache: 'no-cache' })).text();
      const found = page.match(/(?:style\.css|script\.js|features\.js|fonts\/ledger-serif\.woff2)\?v=\d+/g);
      if (found) tagged = [...new Set(found)].map(url => './' + url);
    } catch (e) {}
    await Promise.all(APP_FILES.concat(tagged).map(url => cache.add(new Request(url, { cache: 'no-cache' })).catch(() => {})));
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Always checked with the server ('no-cache' revalidates): the browser's
  // own cached copy of the page could otherwise still be used, and the
  // phone kept showing an older version after an update.
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then(cache => cache.put(req, copy)));
        }
        return res;
      })
      // Only a page falls back to the app's page (a script or font that
      // wasn't kept got the page instead, which broke it): anything else
      // just fails, as it would without this worker.
      // (this very file first: matched by name alone, the copy from the
      // install came back over a newer ?v= one)
      .catch(() => caches.match(req).then(exact => exact || caches.match(req, { ignoreSearch: true })).then(hit => hit
        || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
