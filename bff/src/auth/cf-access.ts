import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Cloudflare Access injects this header once its own login (Google, in our
 * case) has authenticated the visitor, and it always arrives on every request
 * that makes it past Access — HTTP and the `/ws` upgrade alike.
 */
export const CF_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/**
 * Cloudflare also documents `CF-Access-Authenticated-User-Email`, a plain,
 * unsigned header carrying the visitor's email. It is NOT verified in any way
 * and anyone who can reach the origin directly (bypassing Access) can set it
 * themselves. Never read it. The JWT's signature-verified `email` claim,
 * below, is the only trustworthy source of identity.
 */

export interface CfAccessConfig {
  /** The `<team>` in `https://<team>.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access Application's Audience (AUD) tag. */
  audience: string;
  /**
   * Explicit issuer override. Normally the issuer is exactly
   * `https://<team>.cloudflareaccess.com`, derived from `teamDomain` below.
   * But if the Zero Trust team is ever renamed, Cloudflare serves JWKS from
   * the NEW team domain while outstanding tokens (and Access itself, for a
   * transition period) may still stamp the OLD team domain as `iss`. Set this
   * to the old value during that transition; drop it once all sessions have
   * naturally re-authenticated under the new name.
   */
  issuer?: string | null;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * One `createRemoteJWKSet` per team domain, built once and reused: it owns
 * its own JWKS cache (with rotation handling), so constructing a fresh one
 * per request would defeat that caching and hit Cloudflare's certs endpoint
 * on every single verification.
 */
function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`),
    );
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

/**
 * Verifies a Cloudflare Access JWT (from the `Cf-Access-Jwt-Assertion`
 * header) against Cloudflare's own JWKS, checking signature, audience and
 * issuer, and returns the verified email claim. Throws on any failure.
 */
export async function verifyAccessJwt(
  jwt: string,
  config: CfAccessConfig,
): Promise<{ email: string }> {
  const jwks = getJwks(config.teamDomain);
  const issuer = config.issuer || `https://${config.teamDomain}.cloudflareaccess.com`;

  const { payload } = await jwtVerify(jwt, jwks, {
    issuer,
    audience: config.audience,
  });

  const email = payload.email;
  if (typeof email !== "string" || !email.trim()) {
    throw new Error("Access token did not include an email claim");
  }
  return { email: email.trim().toLowerCase() };
}
