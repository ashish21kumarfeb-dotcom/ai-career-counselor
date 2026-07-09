// Kill-switch service worker.
//
// This app does not use a service worker. However, browsers that previously ran
// another project on http://localhost:3000 may still have a stale, cache-first
// service worker registered for this origin — which serves outdated HTML/CSS and
// survives hard refreshes. Because the browser re-fetches this script (/sw.js) on
// navigation, serving this file lets us take over that registration and then
// permanently remove it: clear all caches, unregister, and reload open tabs so
// they load fresh from the network.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch {
        // ignore cache errors
      }
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        client.navigate(client.url);
      }
    })()
  );
});
