import { describe, expect, test } from "bun:test";
import { contentSecurityPolicy, securityHeaders } from "./security-headers.ts";

describe("contentSecurityPolicy", () => {
  const https = contentSecurityPolicy({ publicOrigin: "https://letta.example.com" });
  const http = contentSecurityPolicy({ publicOrigin: "http://localhost:8090" });

  test("allows no inline or eval script", () => {
    // Scoped to script-src specifically: styles are allowed inline (see the
    // policy's own comment), so a blanket assertion would be wrong.
    const scriptSrc = https.match(/script-src [^;]+/)![0];
    expect(scriptSrc).toBe("script-src 'self'");
    expect(https).not.toContain("unsafe-eval");
  });

  test("pins the websocket to the declared origin's scheme and host", () => {
    expect(https).toContain("connect-src 'self' wss://letta.example.com");
    expect(http).toContain("connect-src 'self' ws://localhost:8090");
  });

  test("does not open connect-src to arbitrary hosts", () => {
    expect(https).not.toMatch(/connect-src [^;]*\swss?:\s/);
    expect(https).not.toMatch(/connect-src [^;]*(^|;)\s\*/);
  });

  test("permits data: images, which the favicon and file viewer need", () => {
    expect(https).toMatch(/img-src 'self' data:/);
  });

  test("refuses framing and closes the base/object sinks", () => {
    expect(https).toContain("frame-ancestors 'none'");
    expect(https).toContain("object-src 'none'");
    expect(https).toContain("base-uri 'self'");
  });
});

describe("securityHeaders", () => {
  test("carries the hardening set", () => {
    const headers = securityHeaders({ publicOrigin: "https://letta.example.com" });
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
  });
});
