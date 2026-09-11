let registration: Promise<ServiceWorkerRegistration> | null = null;

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  getServiceWorkerRegistration().catch((error: unknown) => {
    console.error("Service worker registration failed:", error);
  });
}

/**
 * This page's registration, or a rejection carrying the browser's own reason it
 * could not register. Push code awaits this instead of
 * `navigator.serviceWorker.ready`, which never settles when registration failed —
 * that is what left Settings → Notifications with a disabled button and no
 * explanation.
 */
export function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  registration ??= pageLoaded().then(() =>
    navigator.serviceWorker.register("/sw.js", {
      // Classic, not module, in the built app. Chrome fetches a *module*
      // service-worker script without cookies, so behind Cloudflare Access it
      // carries no CF_Authorization, gets redirected to the login page, and a
      // redirected worker script is a hard failure ("The script resource is
      // behind a redirect"). A classic script fetch sends the cookie. The build
      // emits sw.js as an IIFE (vite.config.ts `rollupFormat`) so it is valid as
      // a classic script. Dev stays "module": vite-plugin-pwa serves sw.ts
      // unbundled there, imports and all.
      type: import.meta.env.DEV ? "module" : "classic",
    }),
  );
  return registration;
}

/** Registering after `load` keeps the worker's install off the first paint. */
function pageLoaded(): Promise<void> {
  if (document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
}
