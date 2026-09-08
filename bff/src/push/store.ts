import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** The signed-in identity that created this subscription. Not filtered on
   * yet (the app is single-user), but keeping it means a future multi-user
   * filter is a one-line addition instead of a data migration. */
  email: string;
  createdAt: string;
}

function isValidSubscription(
  value: unknown,
): value is Omit<PushSubscriptionRecord, "email" | "createdAt"> {
  if (!value || typeof value !== "object") return false;
  const sub = value as { endpoint?: unknown; keys?: unknown };
  if (typeof sub.endpoint !== "string" || !sub.endpoint) return false;
  if (!sub.keys || typeof sub.keys !== "object") return false;
  const keys = sub.keys as { p256dh?: unknown; auth?: unknown };
  return typeof keys.p256dh === "string" && typeof keys.auth === "string";
}

/**
 * A small JSON-file-backed store for push subscriptions. This app has no
 * database anywhere and doesn't need one here either — a handful of devices
 * for a single user. Writes are rare (subscribe/unsubscribe only), so a full
 * rewrite on every mutation, serialized through an in-process promise chain,
 * is plenty; no file locking library needed.
 */
export class PushSubscriptionStore {
  private readonly records = new Map<string, PushSubscriptionRecord>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (
              entry &&
              typeof entry === "object" &&
              typeof (entry as { endpoint?: unknown }).endpoint === "string"
            ) {
              this.records.set(
                (entry as PushSubscriptionRecord).endpoint,
                entry as PushSubscriptionRecord,
              );
            }
          }
        }
      } catch {
        // A corrupt or empty file is treated as "no subscriptions yet" rather
        // than a startup failure — push is not load-bearing for the rest of
        // the app.
      }
    }
  }

  all(): PushSubscriptionRecord[] {
    return [...this.records.values()];
  }

  add(subscription: unknown, email: string): PushSubscriptionRecord {
    if (!isValidSubscription(subscription)) {
      throw new Error("Malformed push subscription");
    }
    const record: PushSubscriptionRecord = {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      email,
      createdAt: new Date().toISOString(),
    };
    this.records.set(record.endpoint, record);
    this.persist();
    return record;
  }

  remove(endpoint: string): void {
    if (this.records.delete(endpoint)) this.persist();
  }

  private persist(): void {
    const snapshot = this.all();
    this.writeQueue = this.writeQueue.then(() => {
      writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2));
    });
  }
}
