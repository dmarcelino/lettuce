/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope;

// vite-plugin-pwa's injectManifest strategy replaces this with the actual
// build manifest. Deliberately no `fetch` listener anywhere in this file:
// this app sits behind Cloudflare Access, and a top-level navigation is the
// only kind of request that can complete an Access re-authentication
// redirect. Precaching only ever serves matched asset requests, never
// intercepts navigations, so that redirect always reaches the real network.
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
    self.registration.showNotification(payload.title ?? "Letta", {
      body: payload.body ?? "",
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
