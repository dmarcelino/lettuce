import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushSubscriptionStore } from "./store.ts";

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "push-store-test-"));
  dirs.push(dir);
  return join(dir, "push-subscriptions.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

const subscription = {
  endpoint: "https://push.example/abc",
  keys: { p256dh: "key1", auth: "key2" },
};

describe("PushSubscriptionStore preferences", () => {
  test("a fresh subscription defaults every preference to true", () => {
    const store = new PushSubscriptionStore(tempFile());
    const record = store.add(subscription, "me@example.com");
    expect(record.preferences).toEqual({ completed: true, failed: true, approval: true });
  });

  test("subscribing with explicit preferences honours them", () => {
    const store = new PushSubscriptionStore(tempFile());
    const record = store.add(subscription, "me@example.com", { completed: false });
    expect(record.preferences).toEqual({ completed: false, failed: true, approval: true });
  });

  test("re-subscribing an existing endpoint without preferences preserves them", () => {
    const store = new PushSubscriptionStore(tempFile());
    store.add(subscription, "me@example.com", { completed: false, approval: false });
    const record = store.add(subscription, "me@example.com");
    expect(record.preferences).toEqual({ completed: false, failed: true, approval: false });
  });

  test("updatePreferences merges a partial patch onto the existing record", () => {
    const store = new PushSubscriptionStore(tempFile());
    store.add(subscription, "me@example.com");
    const record = store.updatePreferences(subscription.endpoint, { failed: false });
    expect(record.preferences).toEqual({ completed: true, failed: false, approval: true });

    const again = store.updatePreferences(subscription.endpoint, { completed: false });
    expect(again.preferences).toEqual({ completed: false, failed: false, approval: true });
  });

  test("updatePreferences throws for an unknown endpoint", () => {
    const store = new PushSubscriptionStore(tempFile());
    expect(() => store.updatePreferences("https://nope", { completed: false })).toThrow();
  });

  test("a record persisted before preferences existed loads as all-true", () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify([
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
          email: "me@example.com",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ]),
    );
    const store = new PushSubscriptionStore(file);
    expect(store.getPreferences(subscription.endpoint)).toEqual({
      completed: true,
      failed: true,
      approval: true,
    });
  });

  test("getPreferences returns null for an unknown endpoint", () => {
    const store = new PushSubscriptionStore(tempFile());
    expect(store.getPreferences("https://nope")).toBeNull();
  });
});
