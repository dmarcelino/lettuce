/**
 * Google's OAuth endpoints, as the BFF uses them. The BFF — not the sidecar —
 * runs the consent, because it is the one that has an authenticated browser
 * session and a public origin Google can redirect to, and because a consent
 * the sidecar started would ask for whatever the sidecar was told, from a
 * process every agent can talk to.
 *
 * `fetch` is injected so the flow is testable without Google.
 */

import { createHash, randomBytes } from "node:crypto";
import type { GoogleTokenSet } from "./settings.ts";
import { GOOGLE_TOKEN_URI } from "./settings.ts";

export const GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_REVOKE_URI = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URI = "https://openidconnect.googleapis.com/v1/userinfo";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Google no longer honours this refresh token: revoked, expired or for another client. */
export class GoogleGrantRevokedError extends Error {}

export class GoogleOAuthError extends Error {}

function b64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newState(): string {
  return b64url(randomBytes(32));
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/**
 * The consent URL. `prompt=consent` makes Google issue a refresh token every
 * time; `include_granted_scopes` is deliberately absent, so a narrower consent
 * cannot silently inherit scopes from an earlier, wider one.
 */
export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  loginHint?: string | null;
}): string {
  const url = new URL(GOOGLE_AUTH_URI);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postForm(fetchImpl: Fetch, url: string, form: Record<string, string>) {
  return fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

async function readTokenResponse(response: Response): Promise<TokenResponse> {
  let body: TokenResponse;
  try {
    body = (await response.json()) as TokenResponse;
  } catch {
    throw new GoogleOAuthError(`Google token endpoint answered HTTP ${response.status}`);
  }
  if (!response.ok || body.error) {
    const detail = body.error_description ? `${body.error}: ${body.error_description}` : body.error;
    if (body.error === "invalid_grant")
      throw new GoogleGrantRevokedError(detail ?? "invalid_grant");
    throw new GoogleOAuthError(detail ?? `Google token endpoint answered HTTP ${response.status}`);
  }
  return body;
}

function scopesOf(body: TokenResponse): string[] {
  return (body.scope ?? "").split(/\s+/).filter(Boolean).sort();
}

export async function exchangeCode(
  fetchImpl: Fetch,
  params: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
  nowMs = Date.now(),
): Promise<GoogleTokenSet> {
  const body = await readTokenResponse(
    await postForm(fetchImpl, GOOGLE_TOKEN_URI, {
      grant_type: "authorization_code",
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }),
  );
  if (!body.access_token) throw new GoogleOAuthError("Google returned no access token");
  if (!body.refresh_token) {
    throw new GoogleOAuthError(
      "Google returned no refresh token, so access would stop within the hour. Try connecting again.",
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: nowMs + (body.expires_in ?? 3600) * 1000,
    scopes: scopesOf(body),
  };
}

/**
 * Use the refresh token once, to learn whether Google still honours it and
 * which scopes it carries now — the live answer, not the one stored at consent.
 */
export async function refreshGrant(
  fetchImpl: Fetch,
  params: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<{ accessToken: string; scopes: string[] }> {
  const body = await readTokenResponse(
    await postForm(fetchImpl, GOOGLE_TOKEN_URI, {
      grant_type: "refresh_token",
      client_id: params.clientId,
      client_secret: params.clientSecret,
      refresh_token: params.refreshToken,
    }),
  );
  if (!body.access_token) throw new GoogleOAuthError("Google returned no access token");
  return { accessToken: body.access_token, scopes: scopesOf(body) };
}

export async function fetchAccountEmail(fetchImpl: Fetch, accessToken: string): Promise<string> {
  const response = await fetchImpl(GOOGLE_USERINFO_URI, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new GoogleOAuthError(`Google userinfo answered HTTP ${response.status}`);
  const body = (await response.json()) as { email?: unknown; email_verified?: unknown };
  if (typeof body.email !== "string" || !body.email.includes("@")) {
    throw new GoogleOAuthError("Google did not say which account this is");
  }
  return body.email.toLowerCase();
}

/**
 * Revoke a token and with it the whole grant. Google answers 400 for a token
 * it no longer knows, which is the outcome we wanted anyway.
 */
export async function revokeToken(fetchImpl: Fetch, token: string): Promise<void> {
  const response = await postForm(fetchImpl, GOOGLE_REVOKE_URI, { token });
  if (!response.ok && response.status !== 400) {
    throw new GoogleOAuthError(`Google revoke answered HTTP ${response.status}`);
  }
}
