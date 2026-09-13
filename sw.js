// 오프라인용 서비스 워커.
// - 앱 껍데기(index.html, 버전이 붙은 js/css, 매니페스트, 아이콘, Firebase SDK)는 설치 때 미리 저장한다.
// - 탐색 요청과 index.html 은 네트워크 우선(갱신을 놓치지 않도록), 실패하면 캐시.
// - 나머지 같은 출처 GET(기출 이미지 등)은 캐시 우선 + 뒤에서 갱신.
// - Firebase 서버(firestore/identitytoolkit 등)로 가는 요청은 건드리지 않는다.
// VERSION 은 tools/stamp.py 가 커밋마다 바꿔 넣는다 → 배포마다 새 워커가 설치되고 옛 캐시를 지운다.
const VERSION = "v2.1.92";
const CACHE = "artflash-" + VERSION;
const SDK = [
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js",
];

async function shellUrls() {
  const res = await fetch("index.html", { cache: "no-store" });
  const html = await res.text();
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])
    .filter(u => !/^https?:/.test(u) && !u.startsWith("#") && !u.startsWith("data:"));
  return ["./", "index.html", ...new Set(refs), ...SDK];
}

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = await shellUrls();
    await Promise.all(urls.map(async u => {
      try { await cache.add(new Request(u, { cache: "reload" })); } catch (err) { /* 하나 실패해도 설치는 계속 */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("artflash-") && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isSdk = url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
  if (!sameOrigin && !isSdk) return;   // Firebase API·이미지 CDN 등은 그대로 통과

  const isNav = req.mode === "navigate" || url.pathname.endsWith("/index.html") || url.pathname.endsWith("/");
  if (isNav) { e.respondWith(networkFirst(req, "index.html")); return; }
  if (url.pathname.endsWith("/sw.js")) return;
  e.respondWith(cacheFirst(req));
});

async function networkFirst(req, fallbackKey) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(fallbackKey, res.clone());
    return res;
  } catch {
    return (await cache.match(fallbackKey)) || (await cache.match("./")) || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const key = new Request(req.url.replace(/([?&])_=\d+(&|$)/, "$1").replace(/[?&]$/, ""));   // 캐시 우회용 _= 는 키에서 뺀다
  const hit = await cache.match(key);
  const fetching = fetch(req).then(res => { if (res.ok) cache.put(key, res.clone()); return res; }).catch(() => null);
  if (hit) { fetching.catch(() => {}); return hit; }
  const res = await fetching;
  return res || Response.error();
}
