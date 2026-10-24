// RedAlert Live service worker. Push requires permission and server-side VAPID configuration.
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (_) { payload = { title: "RedAlert Live", body: event.data ? event.data.text() : "התקבלה הודעה חדשה" }; }
  const title = String(payload.title || "RedAlert Live");
  const options = {
    body: String(payload.body || "נשלחה הודעת בדיקה"),
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: String(payload.tag || "redalert-live"),
    renotify: false,
    data: { url: payload.url || "/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
    for (const client of clients) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        if ("navigate" in client) client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
