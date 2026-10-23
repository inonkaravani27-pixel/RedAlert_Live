// Minimal service worker: no caching, so alert data is never served stale. Push is NOT implemented.
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("fetch",()=>{});
