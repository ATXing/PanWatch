// PanWatch Service Worker (v3 - 安全策略)
const CACHE_NAME = 'panwatch-v3';

// 仅缓存应用外壳（导航入口 + 图标 + manifest）。
// 重要：/assets/* 下的带 hash 静态分包【绝不缓存、只走网络】。这些文件内容哈希化、
// 不可变；一旦缺失应直接 404。若被 Service Worker 兜底成 index.html(text/html)，
// 浏览器会把 HTML 当 JS 模块加载，造成 "MIME type text/html" 致命加载错误。
const SHELL_ASSETS = [
  '/',
  '/manifest.json',
  '/manifest.zh-CN.json',
  '/icon-192.png',
  '/icon-512.png',
];

// 安装时缓存静态资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_ASSETS);
    })
  );
  // 立即激活
  self.skipWaiting();
});

// 激活时清理旧缓存（含被投毒的 panwatch-v2）
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  // 立即接管所有客户端
  self.clients.claim();
});

// 网络优先策略（适合实时数据应用）
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 只处理同源请求
  if (url.origin !== self.location.origin) {
    return;
  }

  // API 请求不缓存，直接走网络
  if (url.pathname.includes('/api/')) {
    return;
  }

  // 带 hash 的静态分包：只走网络，不缓存、不兜底；缺失即 404（由服务器返回）。
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 其余（导航/外壳）：网络优先，成功且非 HTML 才缓存；网络失败回退缓存（离线可用）。
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (
          response.ok &&
          !response.headers.get('Content-Type')?.includes('text/html')
        ) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
