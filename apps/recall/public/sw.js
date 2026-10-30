// v1 caches only the public shell and immutable scripts. Notes stay in IndexedDB.
const CACHE = "recall-shell-v4";
const BASE = "/recall";
const SHELL = `${BASE}/`;
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch(SHELL, {cache:"reload",credentials:"omit"});
    if (!response.ok || response.headers.get("X-Recall-Public-Shell")!=="1") throw new Error("Public shell unavailable");
    const html = await response.clone().text();
    const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/recall\/_next\/static\/[^"\s]+\.(?:js|css))"/g)].map(match=>match[1]))];
    await cache.addAll([`${BASE}/manifest.webmanifest`, `${BASE}/icon.svg`, `${BASE}/icon-192.png`, `${BASE}/icon-512.png`, ...assets]);
    await cache.put(SHELL, response);
  })());
  // A new worker waits until all tabs of the previous version close.
});
self.addEventListener("activate", event => {
  event.waitUntil((async()=>{for(const key of await caches.keys()) if(key.startsWith("recall-shell-") && key!==CACHE) await caches.delete(key);await self.clients.claim();})());
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method!=="GET" || url.origin!==self.location.origin) return;
  if (event.request.mode==="navigate" && url.pathname===SHELL) {
    event.respondWith(fetch(event.request).catch(async()=> (await caches.match(SHELL)) || Response.error()));
  } else if (url.pathname.startsWith(`${BASE}/_next/static/`) || ["/manifest.webmanifest","/icon.svg","/icon-192.png","/icon-512.png"].map(path=>BASE+path).includes(url.pathname)) {
    event.respondWith((async()=>{const hit=await caches.match(event.request);if(hit)return hit;const response=await fetch(event.request);if(response.ok)(await caches.open(CACHE)).put(event.request,response.clone());return response;})());
  }
});
