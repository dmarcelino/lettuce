import { getServiceWorkerRegistration } from "./register-sw.ts";

/** True once this app is running as an installed app rather than a browser tab. */
export function isStandalone(): boolean {
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
    // iOS's own flag — it never sets the media query above.
    return (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    // An embedding that withholds `matchMedia` is not an installed app.
    return false;
  }
}

export function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window;
}

function base64UrlToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

const ACTIVATION_TIMEOUT_MS = 10_000;

/**
 * The registration once its worker is active — `pushManager` refuses one with
 * none. Rejects rather than waiting forever when the worker failed to register
 * or install, so the caller can say why.
 */
async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await getServiceWorkerRegistration();
  if (registration.active) return registration;

  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw new Error("Service worker is not active");

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Service worker did not activate in time"));
    }, ACTIVATION_TIMEOUT_MS);
    const check = () => {
      if (worker.state === "activated") {
        clearTimeout(timer);
        resolve();
      } else if (worker.state === "redundant") {
        clearTimeout(timer);
        reject(new Error("Service worker failed to install"));
      }
    };
    worker.addEventListener("statechange", check);
    check();
  });
  return registration;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await activeRegistration();
  return registration.pushManager.getSubscription();
}

export async function isSubscribed(): Promise<boolean> {
  return (await currentSubscription()) !== null;
}

export async function subscribeToPush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted");
  }

  const keyResponse = await fetch("/push/vapid-key");
  if (!keyResponse.ok) throw new Error("Could not load the push public key");
  const { key } = (await keyResponse.json()) as { key: string };

  const registration = await activeRegistration();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(key),
  });

  const response = await fetch("/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!response.ok) {
    await subscription.unsubscribe();
    throw new Error("Could not register this device for push notifications");
  }
}

export async function unsubscribeFromPush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;

  await fetch("/push/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}

/** Per-device opt-in for each push trigger — mirrors `PushPreferences` in bff/src/push/store.ts. */
export interface PushPreferences {
  completed: boolean;
  failed: boolean;
  approval: boolean;
}

/** This device's current preferences, or null when it isn't subscribed. */
export async function getPushPreferences(): Promise<PushPreferences | null> {
  const subscription = await currentSubscription();
  if (!subscription) return null;

  const response = await fetch(
    `/push/preferences?endpoint=${encodeURIComponent(subscription.endpoint)}`,
  );
  if (!response.ok) return null;
  const { preferences } = (await response.json()) as { preferences: PushPreferences };
  return preferences;
}

/** Updates only the keys present in `patch` — the rest are left as they were. */
export async function updatePushPreferences(patch: Partial<PushPreferences>): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) throw new Error("Not subscribed to push notifications");

  const response = await fetch("/push/preferences", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint, preferences: patch }),
  });
  if (!response.ok) throw new Error("Could not update notification preferences");
}
