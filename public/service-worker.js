// 课栈助手 Service Worker - 离线缓存
const CACHE_NAME = 'kstack-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// 安装：缓存核心资源
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 请求拦截：
//  - API：网络优先（不缓存）
//  - 页面文档：网络优先（保证部署后立刻拿到新版本，离线时回退缓存）
//  - 其他静态资源：缓存优先，后台更新
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 只处理同源 GET
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // API 请求：网络优先（不缓存）
  const apiPrefixes = ['/sync', '/tts', '/retry', '/sync-status', '/hw-sync', '/hw-upload', '/hw-delete', '/delete-record', '/health'];
  if (apiPrefixes.some(p => url.pathname.startsWith(p))) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ ok: false, error: '离线状态' }), { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // 页面文档：网络优先，离线回退缓存
  const isDoc = e.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html');
  if (isDoc) {
    e.respondWith(
      fetch(e.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match(e.request).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  // 其他静态资源：缓存优先，后台更新
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const networkFetch = fetch(e.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
