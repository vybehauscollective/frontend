/*
 * Vybe Haus service worker: lets the site open without a connection.
 *
 * - App shell (HTML, built JS/CSS, fonts, icons): saved so pages load offline.
 * - Public event images (/api/v1/assets/*): saved when viewed, so offline tickets show their artwork.
 * - Everything else under /api is NEVER cached here: personal data is no-store,
 *   and saved tickets live only in the signed-in owner's offline copy (IndexedDB).
 * - Requests with an Authorization or Range header are never cached (private files, video).
 */
const VERSION = 'vh-v1'
const SHELL = VERSION + '-shell'
const MEDIA = VERSION + '-media'
const MEDIA_MAX = 60

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL)
      const res = await fetch('/', { cache: 'no-store' })
      const html = await res.clone().text()
      await cache.put('/', res)
      // Built assets referenced by the page, plus fonts and icons.
      const urls = new Set(['/fonts/anton-latin.woff2', '/fonts/inter-latin-var.woff2', '/manifest.webmanifest', '/icons/icon-192.png'])
      for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) urls.add(m[1])
      await Promise.all([...urls].map((u) => cache.add(u).catch(() => {})))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (!key.startsWith(VERSION)) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName)
  const keys = await cache.keys()
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k)
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (req.headers.has('Authorization') || req.headers.has('Range')) return

  // Pages: network first so updates arrive; the saved shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req)
          if (res.ok) (await caches.open(SHELL)).put('/', res.clone())
          return res
        } catch {
          return (await caches.match('/')) || Response.error()
        }
      })(),
    )
    return
  }

  // Public event images: cache first, refreshed in the background.
  if (url.pathname.startsWith('/api/v1/assets/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req)
        const network = fetch(req)
          .then(async (res) => {
            const type = res.headers.get('content-type') || ''
            if (res.ok && res.status === 200 && type.startsWith('image/')) {
              await (await caches.open(MEDIA)).put(req, res.clone())
              trim(MEDIA, MEDIA_MAX)
            }
            return res
          })
          .catch(() => null)
        return cached || (await network) || Response.error()
      })(),
    )
    return
  }
  if (url.pathname.startsWith('/api/')) return // personal and live data: never cached

  // Built assets, fonts, icons: cache first (file names change when content does).
  if (/^\/(assets|fonts|icons)\//.test(url.pathname) || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req)
        if (cached) return cached
        const res = await fetch(req)
        if (res.ok) (await caches.open(SHELL)).put(req, res.clone())
        return res
      })(),
    )
  }
})
