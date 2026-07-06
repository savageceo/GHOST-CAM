// SAVAGE LAB service worker — Web Push receiver for the installed PWA.
// No offline caching (the app is live-only); this exists purely to show
// notifications when the server pushes a motion alert.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { title: "SAVAGE LAB", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "SAVAGE LAB";
  const options = {
    body: data.body || "Motion detected.",
    icon: "/icon-192",
    badge: "/icon-192",
    image: data.image,
    tag: data.tag || "savage-lab",
    renotify: true,
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((wins) => {
        for (const w of wins) {
          if ("focus" in w) {
            if ("navigate" in w) {
              try {
                w.navigate(target);
              } catch (_e) {}
            }
            return w.focus();
          }
        }
        return self.clients.openWindow ? self.clients.openWindow(target) : null;
      }),
  );
});
