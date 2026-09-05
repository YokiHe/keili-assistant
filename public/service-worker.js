// 课栈助手 Service Worker - 离线缓存
const CACHE_NAME = 'kstack-v2';
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

// 请求拦截：网络优先，失败回退缓存（适用于 API 调用）
// 静态资源：缓存优先
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API 请求：网络优先（不缓存）
  if (url.pathname.startsWith('/sync') || url.pathname.startsWith('/tts') || url.pathname.startsWith('/retry')) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ ok: false, error: '离线状态' }), { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // 静态资源：缓存优先，后台更新
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
