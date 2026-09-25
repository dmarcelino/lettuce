import { describe, expect, test } from "bun:test";
import {
  AUTO_RELOAD_INTERVAL_MS,
  claimAutoReload,
  classifyAuthProbe,
  probeAuth,
} from "./auth-probe.ts";

function response(type: string, status: number, body?: unknown) {
  return {
    type,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("not json");
      return body;
    },
  };
}

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("classifyAuthProbe", () => {
  test("Access redirecting to its login is expired", async () => {
    expect(await classifyAuthProbe(response("opaqueredirect", 0))).toBe("expired");
  });

  test("401 and 403 are expired", async () => {
    expect(await classifyAuthProbe(response("basic", 401))).toBe("expired");
    expect(await classifyAuthProbe(response("basic", 403))).toBe("expired");
  });

  test("the app saying nobody is signed in is expired", async () => {
    expect(await classifyAuthProbe(response("basic", 200, { authenticated: false }))).toBe(
      "expired",
    );
  });

  test("a 200 that is not our JSON is expired", async () => {
    expect(await classifyAuthProbe(response("basic", 200))).toBe("expired");
  });

  test("signed in is ok", async () => {
    expect(await classifyAuthProbe(response("basic", 200, { authenticated: true }))).toBe("ok");
  });

  test("a server error is unreachable, not expired", async () => {
    expect(await classifyAuthProbe(response("basic", 502))).toBe("unreachable");
  });
});

describe("probeAuth", () => {
  test("a network failure is unreachable", async () => {
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await probeAuth(failing)).toBe("unreachable");
  });

  test("asks without following redirects and without the cache", async () => {
    let init: RequestInit | undefined;
    const spy = (async (_url: string, options?: RequestInit) => {
      init = options;
      return response("basic", 200, { authenticated: true });
    }) as unknown as typeof fetch;
    await probeAuth(spy);
    expect(init).toMatchObject({ redirect: "manual", cache: "no-store" });
  });
});

describe("claimAutoReload", () => {
  test("once, then not again inside the interval, then again after it", () => {
    const storage = memory();
    expect(claimAutoReload(storage, 1_000)).toBe(true);
    expect(claimAutoReload(storage, 1_000 + AUTO_RELOAD_INTERVAL_MS - 1)).toBe(false);
    expect(claimAutoReload(storage, 1_000 + AUTO_RELOAD_INTERVAL_MS)).toBe(true);
  });

  test("no storage means no automatic reload", () => {
    expect(claimAutoReload(null)).toBe(false);
  });
});
