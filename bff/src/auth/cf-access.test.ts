import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { verifyAccessJwt } from "./cf-access.ts";

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

/**
 * `verifyAccessJwt` fetches Cloudflare's JWKS over the network
 * (`createRemoteJWKSet`). These tests stand up a fake JWKS response by
 * intercepting `fetch` for the exact certs URLs under test, so verification
 * runs for real (signature, audience, issuer, expiry) against a local
 * keypair — no live Cloudflare Access needed.
 */
describe("verifyAccessJwt", () => {
  const teamDomain = `test-team-${Math.random().toString(36).slice(2)}`;
  const renamedTeamDomain = `${teamDomain}-renamed`;
  const audience = "test-audience";
  const kid = "test-key";

  let privateKey: PrivateKey;
  let publicJwk: JWK;
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };

    originalFetch = globalThis.fetch;
    const jwksBody = JSON.stringify({ keys: [publicJwk] });
    const certsUrl = (domain: string) =>
      `https://${domain}.cloudflareaccess.com/cdn-cgi/access/certs`;

    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const url = typeof args[0] === "string" ? args[0] : args[0].toString();
      if (url === certsUrl(teamDomain) || url === certsUrl(renamedTeamDomain)) {
        return new Response(jwksBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(...args);
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  async function sign(options: {
    email?: string;
    audience?: string;
    issuer?: string;
    expiresIn?: string;
  }): Promise<string> {
    let jwt = new SignJWT(options.email !== undefined ? { email: options.email } : {})
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setAudience(options.audience ?? audience)
      .setExpirationTime(options.expiresIn ?? "5m");
    jwt = jwt.setIssuer(options.issuer ?? `https://${teamDomain}.cloudflareaccess.com`);
    return jwt.sign(privateKey);
  }

  test("a valid token yields the lower-cased verified email", async () => {
    const jwt = await sign({ email: "Dima@Example.com" });
    const result = await verifyAccessJwt(jwt, { teamDomain, audience, issuer: null });
    expect(result.email).toBe("dima@example.com");
  });

  test("wrong audience is rejected", async () => {
    const jwt = await sign({ email: "dima@example.com", audience: "someone-elses-app" });
    await expect(verifyAccessJwt(jwt, { teamDomain, audience, issuer: null })).rejects.toThrow();
  });

  test("wrong issuer is rejected", async () => {
    const jwt = await sign({
      email: "dima@example.com",
      issuer: "https://not-cloudflare.example.com",
    });
    await expect(verifyAccessJwt(jwt, { teamDomain, audience, issuer: null })).rejects.toThrow();
  });

  test("an expired token is rejected", async () => {
    const jwt = await sign({ email: "dima@example.com", expiresIn: "-1m" });
    await expect(verifyAccessJwt(jwt, { teamDomain, audience, issuer: null })).rejects.toThrow();
  });

  test("a token signed by a different key is rejected", async () => {
    const other = await generateKeyPair("RS256");
    const jwt = await new SignJWT({ email: "dima@example.com" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setIssuer(`https://${teamDomain}.cloudflareaccess.com`)
      .setAudience(audience)
      .setExpirationTime("5m")
      .sign(other.privateKey);
    await expect(verifyAccessJwt(jwt, { teamDomain, audience, issuer: null })).rejects.toThrow();
  });

  test("issuer override validates a token stamped with the pre-rename team domain", async () => {
    // Simulates a Zero Trust team rename: JWKS now lives at the new domain,
    // but this token (minted before the rename) still carries the old `iss`.
    const oldIssuer = `https://${teamDomain}.cloudflareaccess.com`;
    const jwt = await sign({ email: "dima@example.com", issuer: oldIssuer });
    const result = await verifyAccessJwt(jwt, {
      teamDomain: renamedTeamDomain,
      audience,
      issuer: oldIssuer,
    });
    expect(result.email).toBe("dima@example.com");
  });

  test("a token missing the email claim is rejected", async () => {
    const jwt = await sign({});
    await expect(verifyAccessJwt(jwt, { teamDomain, audience, issuer: null })).rejects.toThrow();
  });
});
