const CACHE = "gsv4";
const PRECACHE = ["/", "/index.html", "/app.js", "/style.css", "/manifest.webmanifest", "/icons/icon.svg", "/js/JsBarcode.min.js"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE.map(p => new Request(p, { cache: "no-cache" }))).catch(() => { }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/*
 * Stratégie "stale-while-revalidate" pour tout le site :
 *  - on sert immédiatement la copie en cache (rapide, fonctionne hors-ligne)
 *  - en arrière-plan, on télécharge la version à jour et on met le cache à jour
 *  - au chargement suivant, la nouvelle version est déjà là → les mises à jour
 *    se propagent toutes seules, sans Ctrl+F5
 */
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(async c => {
      const cached = await c.match(e.request);
      const maj = fetch(e.request)
        .then(r => {
          if (r.ok) c.put(e.request, r.clone());
          return r;
        })
        .catch(() => cached);
      return cached || maj;
    })
  );
});
