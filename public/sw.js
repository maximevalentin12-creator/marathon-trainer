// v2: only static, non-personal assets are cached. Pages and /api responses are personal data and are never
// stored — v1 cached every GET, so activating v2 also deletes everything v1 kept.
const CACHE = "marathon-v2";
const STATIC = /^\/(_next\/static\/|icons\/|manifest\.json$)/;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for static assets (cache as the offline fallback); everything else goes straight to the network.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !STATIC.test(url.pathname)) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// Web push. iOS requires every push to show a notification, so a missing or garbled payload still shows a default one.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not JSON: fall back to the defaults below.
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Marathon", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      tag: data.tag,
      data: { url: data.url || "/" },
    })
  );
});

// Focus the app if it is already open (and send it to the target), otherwise open the target.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(target);
      return open.focus().then((c) => (c && c.url !== target && "navigate" in c ? c.navigate(target) : c));
    })
  );
});
