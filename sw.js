// Aetheris Arena service worker.
//
// Its job is to make the app installable and usable offline. It is written to
// never serve a stale build: the page itself is always fetched from the
// network when the network is reachable, and the cache is only consulted when
// the fetch fails. Only the bundled artwork, whose filenames are content
// derived, is served cache-first.
const SHELL_CACHE = 'aetheris-shell-v1';
const IMAGE_CACHE = 'aetheris-img-v1';
const KEEP = [SHELL_CACHE, IMAGE_CACHE];

self.addEventListener('install', () => {
    // Take over as soon as possible rather than waiting for every tab to close.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Never interfere with writes.
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Supabase, the CDNs and Google Fonts are left entirely alone. Auth,
    // database reads and edge function calls must never be answered from a
    // cache, and sign-in would break if they were.
    if (url.origin !== self.location.origin) return;

    if (/\.(?:jpg|jpeg|png|webp|gif|ico|svg)$/i.test(url.pathname)) {
        event.respondWith(cacheFirst(req, IMAGE_CACHE));
    } else {
        event.respondWith(networkFirst(req, SHELL_CACHE));
    }
});

// Artwork only. These filenames change when the image changes.
async function cacheFirst(req, cacheName) {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(req);
    if (hit) return hit;

    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
}

// The page, the manifest, anything else: fresh whenever the network answers,
// and the last good copy only when it does not.
async function networkFirst(req, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
    } catch (err) {
        const cached = await cache.match(req);
        if (cached) return cached;
        throw err;
    }
}
