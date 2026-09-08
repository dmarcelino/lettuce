import { readFileSync } from "node:fs";

export interface AllowedUser {
  email: string;
  /** Display name shown in the UI. Falls back to the Google profile name. */
  name?: string;
}

export interface BffConfig {
  port: number;
  /** App-server WebSocket base URL, e.g. ws://letta:4500 */
  appServerUrl: string;
  /**
   * Capability token presented as `Authorization: Bearer` upstream. Empty when
   * the app-server listens on loopback without `--ws-auth`, which is the only
   * configuration in which the channel gateway can also attach (it sends no
   * token of its own).
   */
  appServerToken: string;
  /** Absolute public origin of this BFF. */
  publicOrigin: string;
  /** The `<team>` in `https://<team>.cloudflareaccess.com`. */
  cfAccessTeamDomain: string;
  /** The Access Application's Audience (AUD) tag. */
  cfAccessAud: string;
  /** Explicit issuer override — see `auth/cf-access.ts` for why this exists. */
  cfAccessIssuer: string | null;
  sessionSecret: string;
  sessionTtlSeconds: number;
  allowedUsers: AllowedUser[];
  /** Total frames retained for session resume across all conversations. */
  frameBufferSize: number;
  /** Set for local development: skips OAuth and signs in as this email. */
  devBypassEmail: string | null;
  /** Explicit opt-in to serving the bypass beyond the local machine. */
  devBypassAllowRemote: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value.trim();
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function readAppServerToken(): string {
  const inline = process.env.LETTA_APP_SERVER_TOKEN?.trim();
  if (inline) return inline;

  const path = process.env.LETTA_APP_SERVER_TOKEN_FILE?.trim();
  if (!path) return "";

  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error(`App-server token file ${path} is empty`);
  return token;
}

function readAllowedUsers(): AllowedUser[] {
  const path = process.env.USERS_FILE?.trim() ?? "config/users.json";
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read allowlist ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${path} must be a non-empty array of users`);
  }

  return parsed.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { email?: unknown }).email !== "string"
    ) {
      throw new Error(`${path}[${index}] must have a string "email"`);
    }
    const user = entry as { email: string; name?: unknown };
    return {
      email: user.email.trim().toLowerCase(),
      ...(typeof user.name === "string" ? { name: user.name } : {}),
    };
  });
}

export function isLoopbackOrigin(publicOrigin: string): boolean {
  let host: string;
  try {
    host = new URL(publicOrigin).hostname;
  } catch {
    throw new Error(`PUBLIC_ORIGIN is not a valid URL: ${publicOrigin}`);
  }
  return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

/**
 * The dev bypass issues a session to anyone who asks. Exposing it beyond the
 * local machine means anyone who can reach the port is the configured user, so
 * that requires a second, explicit opt-in: a stale DEV_BYPASS_EMAIL alone can
 * never open the server to the network.
 */
function assertBypassIsSafe(
  devBypassEmail: string,
  publicOrigin: string,
  allowRemote: boolean,
): void {
  if (isLoopbackOrigin(publicOrigin) || allowRemote) return;

  throw new Error(
    `Refusing to start: DEV_BYPASS_EMAIL is set (${devBypassEmail}) but PUBLIC_ORIGIN ` +
      `(${publicOrigin}) is reachable from other machines. The bypass authenticates ` +
      `nobody — anyone who can reach this port would get a session as ${devBypassEmail}. ` +
      `Set PUBLIC_ORIGIN to a loopback address, or unset DEV_BYPASS_EMAIL and configure ` +
      `CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD. To knowingly expose unauthenticated ` +
      `access on this network anyway, set DEV_BYPASS_ALLOW_REMOTE=true.`,
  );
}

export function loadConfig(): BffConfig {
  const devBypassEmail = process.env.DEV_BYPASS_EMAIL?.trim() || null;
  const devBypassAllowRemote = process.env.DEV_BYPASS_ALLOW_REMOTE?.trim() === "true";
  const publicOrigin = required("PUBLIC_ORIGIN").replace(/\/$/, "");
  if (devBypassEmail) {
    assertBypassIsSafe(devBypassEmail, publicOrigin, devBypassAllowRemote);
  }
  return {
    port: optionalNumber("PORT", 8080),
    appServerUrl: required("LETTA_APP_SERVER_URL"),
    appServerToken: readAppServerToken(),
    publicOrigin,
    // Cloudflare Access credentials are not needed when the dev bypass is active.
    cfAccessTeamDomain: devBypassEmail
      ? (process.env.CF_ACCESS_TEAM_DOMAIN ?? "")
      : required("CF_ACCESS_TEAM_DOMAIN"),
    cfAccessAud: devBypassEmail ? (process.env.CF_ACCESS_AUD ?? "") : required("CF_ACCESS_AUD"),
    cfAccessIssuer: process.env.CF_ACCESS_ISSUER?.trim() || null,
    sessionSecret: required("SESSION_SECRET"),
    sessionTtlSeconds: optionalNumber("SESSION_TTL_SECONDS", 60 * 60 * 24 * 30),
    allowedUsers: readAllowedUsers(),
    frameBufferSize: optionalNumber("FRAME_BUFFER_SIZE", 5000),
    devBypassEmail,
    devBypassAllowRemote,
  };
}

export function isAllowedUser(config: BffConfig, email: string): AllowedUser | null {
  const normalized = email.trim().toLowerCase();
  return config.allowedUsers.find((user) => user.email === normalized) ?? null;
}
