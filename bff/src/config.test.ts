import { describe, expect, test } from "bun:test";
import { assertSessionSecretIsStrong, loadConfig, parseAllowedUsers } from "./config";

describe("parseAllowedUsers", () => {
  test("splits a comma-separated list", () => {
    expect(parseAllowedUsers("a@example.com,b@example.com", "src")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  test("accepts a single address", () => {
    expect(parseAllowedUsers("solo@example.com", "src")).toEqual(["solo@example.com"]);
  });

  test("normalizes case and surrounding space", () => {
    // isAllowedUser() compares against an already-lowercased address, so a
    // capitalized entry would never match without this.
    expect(parseAllowedUsers("  Mixed@Case.COM , B@Example.com ", "src")).toEqual([
      "mixed@case.com",
      "b@example.com",
    ]);
  });

  test("de-duplicates, including across case differences", () => {
    expect(parseAllowedUsers("a@example.com, A@Example.com", "src")).toEqual(["a@example.com"]);
  });

  test("ignores empty entries rather than yielding blanks", () => {
    expect(parseAllowedUsers("a@example.com,,", "src")).toEqual(["a@example.com"]);
  });

  test("rejects a value with no addresses at all", () => {
    expect(() => parseAllowedUsers(",,,", "ALLOWED_USERS")).toThrow(
      /ALLOWED_USERS lists no addresses/,
    );
  });

  test("rejects an empty string", () => {
    expect(() => parseAllowedUsers("   ", "ALLOWED_USERS")).toThrow(/no addresses/);
  });

  test("rejects an entry that is not an address, naming it", () => {
    // The point of this check is to fail at boot instead of as an unexplained
    // 403 at sign-in — an address matching nothing is otherwise silent.
    expect(() => parseAllowedUsers("a@example.com, oops", "ALLOWED_USERS")).toThrow(
      /not email addresses: oops/,
    );
  });

  test("does not reject unusual but valid addresses", () => {
    // Guards against someone 'improving' the @ check into an email regex.
    const exotic = "a+tag@sub.example.co.uk, first.last@example.museum";
    expect(parseAllowedUsers(exotic, "src")).toEqual([
      "a+tag@sub.example.co.uk",
      "first.last@example.museum",
    ]);
  });

  test("names the source in errors so the operator knows what to fix", () => {
    expect(() => parseAllowedUsers("", "SOME_SOURCE")).toThrow(/SOME_SOURCE/);
  });
});

describe("assertSessionSecretIsStrong", () => {
  const strong = "d6efd2a91c4b7e0f5a3d8c2b1e6f9a4d7c3b8e2f5a1d9c4b7e0f3a6d2c9b5e8f";

  test("accepts a 64-char hex secret", () => {
    expect(() => assertSessionSecretIsStrong(strong)).not.toThrow();
  });

  test("accepts a 32-char secret at exactly the floor", () => {
    expect(() => assertSessionSecretIsStrong("a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6")).not.toThrow();
  });

  test("rejects a secret below the minimum length, naming the length", () => {
    expect(() => assertSessionSecretIsStrong("short")).toThrow(
      /SESSION_SECRET is too short \(5 characters, minimum 32\)/,
    );
  });

  test("rejects one character repeated to reach the minimum", () => {
    expect(() => assertSessionSecretIsStrong("a".repeat(64))).toThrow(
      /one character repeated, which carries no entropy/,
    );
  });

  test("rejects a short pattern tiled to reach the minimum", () => {
    expect(() => assertSessionSecretIsStrong("ab".repeat(32))).toThrow(
      /2-character pattern repeated/,
    );
    expect(() => assertSessionSecretIsStrong("abcd".repeat(16))).toThrow(
      /4-character pattern repeated/,
    );
  });

  test("does not reject a long secret that merely starts with a repeated run", () => {
    // "aa" up front must not trip the tiled-pattern check for the whole value.
    expect(() => assertSessionSecretIsStrong(`aa${strong.slice(2)}`)).not.toThrow();
  });

  test("every rejection names the command that fixes it", () => {
    for (const weak of ["short", "a".repeat(64), "ab".repeat(32)]) {
      expect(() => assertSessionSecretIsStrong(weak)).toThrow(/openssl rand -hex 32/);
    }
  });
});

describe("loadConfig session secret", () => {
  const base = {
    PUBLIC_ORIGIN: "http://localhost:8090",
    LETTA_APP_SERVER_URL: "ws://127.0.0.1:4500",
  };

  function withEnv(extra: Record<string, string | undefined>, run: () => void): void {
    const saved = { ...process.env };
    try {
      for (const [key, value] of Object.entries(extra)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      run();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  test("boots with a strong secret", () => {
    withEnv({ ...base, SESSION_SECRET: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p67" }, () => {
      expect(loadConfig().sessionSecret).toHaveLength(33);
    });
  });

  test("refuses to boot with a weak secret", () => {
    withEnv({ ...base, SESSION_SECRET: "hunter2" }, () => {
      expect(loadConfig).toThrow(/SESSION_SECRET is too short/);
    });
  });

  test("still reports a missing secret as missing, not as too short", () => {
    withEnv({ ...base, SESSION_SECRET: undefined }, () => {
      expect(loadConfig).toThrow(/Missing required environment variable SESSION_SECRET/);
    });
  });
});
