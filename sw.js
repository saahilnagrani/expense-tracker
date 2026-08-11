// Service worker: makes the app installable and usable offline.
// Strategy: network-first for same-origin GETs (so online users always get
// fresh files — no stale-cache surprises), falling back to cache when offline.
// Google API / sign-in requests are same-origin? No — they are cross-origin and
// pass straight through untouched.

const CACHE = "et-cache-v27";
const CORE = [
  "./",
  "./index.html",
  "./assets/css/styles.css?v=27",
  "./assets/js/app.js?v=27",
  "./manifest.webmanifest",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return; // let Google APIs pass through

  // Page navigations: network-first, fall back to the cached shell offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("./index.html")));
    return;
  }

  // Assets (JS/CSS/icons): network-first, then cache. IMPORTANT: on a miss,
  // return the cached asset if present but NEVER the HTML shell — returning
  // index.html for a .js/.css request corrupts it and blanks the app.
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
