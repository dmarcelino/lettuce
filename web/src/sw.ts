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
  event.waitUntil(self.clients.openWindow(url));
});
