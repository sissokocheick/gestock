const CACHE = "gsv16";
const PRECACHE = ["/", "/index.html", "/app.js", "/app-stock.js", "/style.css", "/manifest.webmanifest", "/icons/icon.svg", "/js/JsBarcode.min.js", "/js/html5-qrcode.min.js"];

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
  /* Ne JAMAIS mettre en cache les réponses API : données commerciales sensibles
     (le mode hors-ligne applicatif est géré par la file d'attente de app.js) */
  if (url.pathname.startsWith("/api/")) return;

  // Réseau d'abord : toujours la version à jour quand on est en ligne,
  // repli sur le cache uniquement hors ligne.
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
