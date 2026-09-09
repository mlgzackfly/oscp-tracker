// 讓已載入過的頁面離線也能開。改版時把 CACHE 版號 +1。
const CACHE = "oscp-tracker-v2";
const SHELL = [".", "index.html", "styles.css", "app.js", "data.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;              // 寫入不快取
  if (url.pathname.includes("/api/")) return;          // API 一律走網路，交給前端同步邏輯
  // app shell 走 stale-while-revalidate：先給快取，背景更新
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(e.request).then((hit) => {
        const net = fetch(e.request)
          .then((res) => {
            if (res.ok && url.origin === location.origin) cache.put(e.request, res.clone());
            return res;
          })
          .catch(() => hit);
        return hit || net;
      })
    )
  );
});
