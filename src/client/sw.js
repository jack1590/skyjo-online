// Service worker TEMPLATE. The build (precacheServiceWorker in vite.config.ts) replaces the two
// placeholders and emits it as /sw.js. Rooms need the network; with the whole build precached,
// the app shell and hot-seat play work offline after a single visit.
const CACHE = "skyjo-__VERSION__";
const PRECACHE = self.__PRECACHE__;
// Responses can carry `Vary` (e.g. Accept-Encoding, Origin); precache requests never match a
// page's own request headers exactly, so match on URL alone.
const MATCH = { cacheName: CACHE, ignoreVary: true };

/** Last resort when even the shell isn't cached (e.g. offline before the install finished). */
const OFFLINE_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Skyjo Online</title><body style="margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:#0d1b2a;color:#f5f1e6;font-family:system-ui,sans-serif;text-align:center">
<main><h1>You're offline</h1><p>Skyjo Online needs a connection to load.</p>
<p lang="es">Skyjo Online necesita conexión para cargar.</p><p lang="pt-BR">O Skyjo Online precisa de conexão para carregar.</p>
<button onclick="location.reload()" style="min-height:48px;padding:0 24px;border:0;border-radius:12px;background:#f2c14e;font:inherit;font-weight:700">Try again · Reintentar · Tentar de novo</button></main></body>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // Each build has its own cache; older builds' files are dropped here.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    // Network first so a deploy shows up at once. Navigation responses are never cached (no
    // poisoning by error pages or captive portals); offline, every route gets this build's shell.
    event.respondWith(
      fetch(request).catch(
        async () =>
          (await caches.match("/", MATCH)) ??
          new Response(OFFLINE_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
      ),
    );
    return;
  }

  // Build files are content-hashed and precached: serve them from the cache, else the network.
  event.respondWith(caches.match(request, MATCH).then((hit) => hit ?? fetch(request)));
});
