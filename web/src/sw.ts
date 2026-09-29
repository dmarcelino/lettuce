/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope;

// Push events go to whichever worker is currently *active*, not whichever is
// newest — and by default a new worker sits in "waiting" until every tab the
// old one controls has fully closed. On a phone, "fully close the app" is a
// step almost nobody takes deliberately, so an update to the push handler
// itself (see below) would otherwise sit unapplied indefinitely. Force new
// workers to activate immediately and take over any already-open tab.
self.skipWaiting();
clientsClaim();

// vite-plugin-pwa's injectManifest strategy replaces this with the actual
// build manifest. `precacheAndRoute` does install a fetch route, and that route
// maps `/` to a precached `index.html` (its `directoryIndex`) — so `index.html`
// is kept out of the manifest (vite.config.ts `globIgnores`), which keeps every
// navigation on the network. This app sits behind Cloudflare Access, where a
// top-level navigation is the only request that can complete a
// re-authentication redirect: a cached shell would load, fail its first
// `/api/status` fetch against an expired session, and sit on "Loading…" with no
// way out by reloading.
precacheAndRoute(self.__WB_MANIFEST);

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
}

self.addEventListener("push", (event) => {
  let payload: PushPayload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    // A push with no JSON body still deserves a fallback notification rather
    // than silently disappearing.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? "Lettuce", {
      body: payload.body ?? "",
      // Without an explicit `icon`/`badge`, Android's status bar falls back to
      // a generic bell: the small-icon silhouette it needs comes from `badge`
      // (a white-on-transparent glyph), not from a scaled-down `icon`, and our
      // app icons are opaque squares with no alpha channel to derive one from.
      icon: "/icon-512.png",
      badge: "/badge-192.png",
      data: { url: payload.url ?? "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? "/";

  // Focus and navigate an existing tab rather than always opening a new one —
  // this app has no router, so `navigate()` to a new query string forces a
  // real reload, which is what makes the deep-link query params below take
  // effect (see `readDeepLinkSelection` in `lib/selection.ts`).
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then(async (clients) => {
      const client = clients[0];
      if (client) {
        const navigated = await client.navigate(url);
        await navigated?.focus();
        return;
      }
      await self.clients.openWindow(url);
    }),
  );
});
