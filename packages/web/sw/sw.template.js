/* VBuddy service worker. Generated into dist/sw.js at build time, which fills in the version and the file list.
 *
 * What it does: keeps the app itself (HTML, scripts, styles, icons) so VBuddy opens even when the bridge or
 * the network is down. What it never does: touch /ws or /api/*, which are always live. */
const VERSION = "__VBUDDY_VERSION__";
const CACHE = "vbuddy-" + VERSION;
const PRECACHE = __VBUDDY_PRECACHE__;
const NAV_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  // No skipWaiting here: a new version waits until the page asks, so an open flight view is never swapped mid-use.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" })))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith("vbuddy-") && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) return; // live data: straight to the network
  if (req.mode === "navigate") event.respondWith(navigate(req));
  else event.respondWith(cacheFirst(req));
});

/** Page loads: the network if it answers quickly, otherwise the saved app. */
async function navigate(req) {
  try {
    return await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NAV_TIMEOUT_MS)),
    ]);
  } catch {
    const cached = await caches.match("/index.html", { ignoreSearch: true });
    return cached ?? new Response("VBuddy is offline and has no saved copy yet.", { status: 503, headers: { "content-type": "text/plain" } });
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === "basic") {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  } catch {
    return Response.error();
  }
}

/* ---- notifications (sent by the bridge through the browser's push service) ---- */

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { title: "VBuddy", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      // Always shown: iPhones withdraw the permission from a site whose pushes don't show a notification. The bridge
      // already leaves out devices that have VBuddy on screen.
      await self.registration.showNotification(d.title || "VBuddy", {
        body: d.body || "",
        tag: d.tag || undefined,
        renotify: !!d.tag,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { url: d.url || "/" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) {
          await w.focus();
          if ("navigate" in w) await w.navigate(target).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
