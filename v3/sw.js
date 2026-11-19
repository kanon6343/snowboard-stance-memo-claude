/* スタンスメモ v3 のオフライン用。RELEASE を上げると、新しい版として入れ直す */
const RELEASE = '3009';
const CACHE_PREFIX = 'stance-memo-v3:';
const CACHE = CACHE_PREFIX + RELEASE;
// 雪山のデータ（毎時・3時間ごとに変わる）は、まず通信し、だめなら前回のものを出す
const DATA = ['../snow/latest.json', '../snow/road_ai.json'].map(p => new URL(p, self.location).href);
const DATA_CACHE = CACHE_PREFIX + 'data';
const SHELL = [
  './', 'index.html', 'app.css?v=3009', 'manifest.webmanifest',
  'js/main.js?v=3009', 'js/ui.js', 'js/store.js', 'js/binding.js', 'js/record.js', 'js/history.js', 'js/snow.js', 'js/settings.js',
  '../icons/icon-claude-192.png', '../icons/icon-claude-512.png', '../icons/icon-claude-maskable-512.png', '../icons/apple-touch-icon-claude.png',
].map(p => new URL(p, self.location).href);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX) && k !== CACHE && k !== DATA_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', e => { if (e.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const dataUrl = DATA.find(u => u === url.href.split('?')[0]);
  if (dataUrl) {
    e.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(dataUrl, res.clone());
        return res;
      } catch {
        return (await cache.match(dataUrl)) || Response.error();
      }
    })());
    return;
  }
  const page = req.mode === 'navigate' && url.origin === self.location.origin && url.pathname.startsWith(new URL('./', self.location).pathname);
  if (!page && !SHELL.includes(url.href)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(page ? new URL('index.html', self.location).href : req);
    if (hit) return hit;
    try { return await fetch(req); }
    catch {
      return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>スタンスメモ</title><p style="font:16px system-ui;padding:20px">通信できません。一度、通信できる所で開いてください。</p>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
  })());
});
