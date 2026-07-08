/* ============================================================================
 *  Service Worker · Cancha de Tenis · Cerros de la Alhambra
 *
 *  Estrategia SEGURA para una app con datos en vivo:
 *   - Solo intercepta peticiones GET del MISMO ORIGEN (la app estática).
 *   - Todo lo demás (Supabase, el CDN de supabase-js) va DIRECTO a la red:
 *     los datos en vivo NUNCA se cachean ni se sirven viejos.
 *   - "Network-first": si hay internet, siempre sirve la versión más reciente;
 *     si no hay, cae al caché para que la app abra offline (aunque sin datos).
 *
 *  Al publicar una versión nueva de la app, SUBE el número de CACHE (v2, v3…)
 *  para que los caches viejos se borren.
 * ========================================================================== */
const CACHE = 'tenis-cache-v2';
const SHELL = [
  './',
  './index.html',
  './data.js',
  './og.png',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Solo GET del mismo origen. Supabase, CDN y demás → red directa (no tocar).
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // Guarda una copia fresca para poder abrir offline la próxima vez.
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match('./index.html'))
      )
  );
});

/* ---- Notificaciones push ---- */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(
    self.registration.showNotification(d.title || 'Cancha de Tenis', {
      body: d.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: d.tag || 'tenis-aviso',
      data: { url: d.url || './' }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
