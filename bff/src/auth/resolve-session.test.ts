import { describe, expect, test } from "bun:test";
import type { BffConfig } from "../config.ts";
import { type ResolveSessionDeps, resolveSession } from "./resolve-session.ts";
import { encodeSession, SESSION_COOKIE } from "./session-cookie.ts";

const SECRET = "test-secret";

function config(mode: BffConfig["mode"]): BffConfig {
  return {
    mode,
    sessionSecret: SECRET,
    allowedUsers: ["me@example.com"],
    cfAccessTeamDomain: "team",
    cfAccessAud: "aud",
    cfAccessIssuer: null,
  } as unknown as BffConfig;
}

function deps(mode: BffConfig["mode"], email: string | Error): ResolveSessionDeps {
  return {
    config: config(mode),
    mint: (who) => ({ session: { email: who, exp: 9_999_999_999 }, cookie: `minted-for-${who}` }),
    log: () => {},
    verify: async () => {
      if (email instanceof Error) throw email;
      return { email };
    },
  };
}

function request(headers: Record<string, string>): Request {
  return new Request("https://app.example/ws", { headers });
}

const now = Math.floor(Date.now() / 1000);
const validCookie = `${SESSION_COOKIE}=${encodeSession({ email: "me@example.com", exp: now + 3600 }, SECRET)}`;
const expiredCookie = `${SESSION_COOKIE}=${encodeSession({ email: "me@example.com", exp: now - 10 }, SECRET)}`;

describe("resolveSession", () => {
  test("a valid cookie wins, and nothing is minted", async () => {
    const resolved = await resolveSession(
      request({ cookie: validCookie, "cf-access-jwt-assertion": "jwt" }),
      deps("cloudflared", "me@example.com"),
    );
    expect(resolved?.session.email).toBe("me@example.com");
    expect(resolved?.setCookie).toBeUndefined();
  });

  test("an expired cookie with a valid Access JWT mints a new session", async () => {
    const resolved = await resolveSession(
      request({ cookie: expiredCookie, "cf-access-jwt-assertion": "jwt" }),
      deps("cloudflared", "me@example.com"),
    );
    expect(resolved?.setCookie).toBe("minted-for-me@example.com");
  });

  test("an expired cookie and no JWT is signed out", async () => {
    const resolved = await resolveSession(
      request({ cookie: expiredCookie }),
      deps("cloudflared", "me@example.com"),
    );
    expect(resolved).toBeNull();
  });

  test("a JWT for someone off the allowlist is refused", async () => {
    const resolved = await resolveSession(
      request({ "cf-access-jwt-assertion": "jwt" }),
      deps("cloudflared", "stranger@example.com"),
    );
    expect(resolved).toBeNull();
  });

  test("a JWT that fails verification is refused", async () => {
    const resolved = await resolveSession(
      request({ "cf-access-jwt-assertion": "jwt" }),
      deps("cloudflared", new Error("bad signature")),
    );
    expect(resolved).toBeNull();
  });

  test("local mode never reads the Access header", async () => {
    const resolved = await resolveSession(
      request({ "cf-access-jwt-assertion": "jwt" }),
      deps("local", "me@example.com"),
    );
    expect(resolved).toBeNull();
  });
});
