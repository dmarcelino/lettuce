import webpush from "web-push";
import type { PushConfig } from "../config.ts";
import type { PushSubscriptionRecord } from "./store.ts";

/**
 * A push is still worth delivering hours after "your agent replied" — but not
 * indefinitely. `web-push` defaults to a 4-week TTL; set an explicit,
 * shorter one on purpose rather than depending on that default.
 */
const PUSH_TTL_SECONDS = 6 * 60 * 60;

export function configureWebPush(push: PushConfig): void {
  // The VAPID `sub` claim must be exactly `mailto:<email>` or `https://<url>`
  // on its own — no string-building around an already-schemed value (a sibling
  // project once produced `mailto:admin@https://host` this way and had every
  // push rejected outright).
  webpush.setVapidDetails(
    `mailto:${push.vapidContactEmail}`,
    push.vapidPublicKey,
    push.vapidPrivateKey,
  );
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/**
 * Sends one push. A dead subscription (404/410 — uninstalled, revoked, or
 * simply expired) is routine, not an error: the caller is responsible for
 * removing it from the store.
 */
export async function sendPush(
  record: PushSubscriptionRecord,
  payload: PushPayload,
): Promise<"sent" | "gone"> {
  try {
    await webpush.sendNotification(
      { endpoint: record.endpoint, keys: record.keys },
      JSON.stringify(payload),
      { TTL: PUSH_TTL_SECONDS },
    );
    return "sent";
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) return "gone";
    throw error;
  }
}
