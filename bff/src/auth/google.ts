import { createHmac, randomBytes } from "node:crypto";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export const OAUTH_STATE_COOKIE = "letta_oauth_state";

export interface GoogleProfile {
  email: string;
  name: string;
  emailVerified: boolean;
}

/**
 * The OAuth state cookie doubles as the PKCE verifier store: state is the
 * random value, and the verifier is derived from it with the session secret so
 * no server-side pending-login table is needed.
 */
export function createOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

export function deriveCodeVerifier(state: string, secret: string): string {
  return createHmac("sha256", secret).update(`pkce:${state}`).digest("base64url");
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

export async function buildAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  verifier: string;
}): Promise<string> {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", await codeChallenge(options.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeCode(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  verifier: string;
}): Promise<string> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      grant_type: "authorization_code",
      code: options.code,
      code_verifier: options.verifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status}): ${await response.text()}`);
  }

  const payload = (await response.json()) as { access_token?: unknown };
  if (typeof payload.access_token !== "string") {
    throw new Error("Google token response did not include an access token");
  }
  return payload.access_token;
}

export async function fetchProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google userinfo failed (${response.status})`);
  }

  const payload = (await response.json()) as {
    email?: unknown;
    name?: unknown;
    email_verified?: unknown;
  };
  if (typeof payload.email !== "string") {
    throw new Error("Google userinfo did not include an email");
  }

  return {
    email: payload.email,
    name: typeof payload.name === "string" ? payload.name : payload.email,
    emailVerified: payload.email_verified === true,
  };
}
