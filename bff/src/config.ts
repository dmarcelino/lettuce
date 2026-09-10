import { readFileSync } from "node:fs";

export interface AllowedUser {
  email: string;
  /** Display name shown in the UI. Falls back to the Access-verified email. */
  name?: string;
}

export interface BffConfig {
  port: number;
  /**
   * "local" (default) — no Cloudflare configuration needed, reachable
   * directly on the LAN; sign-in is DEV_BYPASS_EMAIL or nothing.
   * "cloudflared" — Cloudflare Access is the gate; set via
   * `LETTA_MODE`, itself a pass-through of Compose's own
   * `COMPOSE_PROFILES` (see docker/compose.yml), so the one setting that
   * decides whether the `cloudflared` container even exists is the same
   * one the app reads.
   */
  mode: "local" | "cloudflared";
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
  /** Set for local development: skips Cloudflare Access and signs in as this email. */
  devBypassEmail: string | null;
  /** Explicit opt-in to serving the bypass beyond the local machine. */
  devBypassAllowRemote: boolean;
  /**
   * Push is fully optional and self-gating: null unless all three VAPID
   * settings are present, so a plain local dev run needs no push setup at
   * all. Callers check `config.push !== null` before wiring up push routes.
   */
  push: PushConfig | null;
}

export interface PushConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  /** The address in the VAPID `sub` claim — a bare email, no scheme. */
  vapidContactEmail: string;
  subscriptionsFile: string;
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

/**
 * Parses an allowlist from either shape, naming `source` in every error so a
 * misconfiguration says which input to go and fix.
 *
 * JSON — the `users.json` shape — is always accepted:
 *
 *   [{"email":"a@example.com","name":"A"}]
 *
 * `acceptBareEmails` additionally allows a comma-separated list, which is far
 * nicer to type into an env var:
 *
 *   a@example.com, b@example.com
 *
 * A leading `[` picks JSON; nothing else could start a bare email. That
 * shorthand is env-only on purpose — accepting it for a file would silently
 * read a malformed `users.json` (say, `{}`) as a one-address allowlist instead
 * of reporting it as broken.
 */
export function parseAllowedUsers(
  raw: string,
  source: string,
  acceptBareEmails = false,
): AllowedUser[] {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${source} is empty`);

  if (acceptBareEmails && !trimmed.startsWith("[")) {
    const emails = trimmed
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean);
    if (emails.length === 0) throw new Error(`${source} lists no addresses`);
    return emails.map((email) => ({ email: email.toLowerCase() }));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${source} must be a non-empty array of users`);
  }

  return parsed.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { email?: unknown }).email !== "string"
    ) {
      throw new Error(`${source}[${index}] must have a string "email"`);
    }
    const user = entry as { email: string; name?: unknown };
    return {
      email: user.email.trim().toLowerCase(),
      ...(typeof user.name === "string" ? { name: user.name } : {}),
    };
  });
}

/**
 * ALLOWED_USERS wins over USERS_FILE when set, so a prod deployment can keep
 * its entire configuration in the environment and never place a file on disk.
 * That also sidesteps the file's sharpest edge: `config/users.json` is
 * gitignored, so on a fresh clone it does not exist — and a compose single-file
 * bind of a missing path silently creates a DIRECTORY, which used to surface
 * only as an unexplained EISDIR crash loop at boot.
 */
function readAllowedUsers(): AllowedUser[] {
  const inline = process.env.ALLOWED_USERS?.trim();
  if (inline) return parseAllowedUsers(inline, "ALLOWED_USERS", true);

  const path = process.env.USERS_FILE?.trim() ?? "config/users.json";
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read allowlist ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
        `Set ALLOWED_USERS instead to configure the allowlist from the environment.`,
    );
  }

  return parseAllowedUsers(raw, path);
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

/**
 * `LETTA_MODE` is a pass-through of Compose's own `COMPOSE_PROFILES` (see
 * docker/compose.yml) — whatever decides if the `cloudflared` container
 * exists is the same value the app reads. Checked with `includes` rather
 * than equality so a future multi-profile value like `"cloudflared,other"`
 * still resolves correctly.
 */
function readMode(): "local" | "cloudflared" {
  const raw = process.env.LETTA_MODE?.trim() ?? "";
  return raw.includes("cloudflared") ? "cloudflared" : "local";
}

export function loadConfig(): BffConfig {
  const mode = readMode();
  const devBypassEmail = process.env.DEV_BYPASS_EMAIL?.trim() || null;
  const devBypassAllowRemote = process.env.DEV_BYPASS_ALLOW_REMOTE?.trim() === "true";
  const publicOrigin = required("PUBLIC_ORIGIN").replace(/\/$/, "");
  if (devBypassEmail) {
    assertBypassIsSafe(devBypassEmail, publicOrigin, devBypassAllowRemote);
  }
  // Cloudflare Access credentials are only needed in cloudflared mode, and
  // not even then if the dev bypass is active. Local mode never reads them.
  const needsCfAccess = mode === "cloudflared" && !devBypassEmail;
  return {
    mode,
    port: optionalNumber("PORT", 8080),
    appServerUrl: required("LETTA_APP_SERVER_URL"),
    appServerToken: readAppServerToken(),
    publicOrigin,
    cfAccessTeamDomain: needsCfAccess
      ? required("CF_ACCESS_TEAM_DOMAIN")
      : (process.env.CF_ACCESS_TEAM_DOMAIN ?? ""),
    cfAccessAud: needsCfAccess ? required("CF_ACCESS_AUD") : (process.env.CF_ACCESS_AUD ?? ""),
    cfAccessIssuer: process.env.CF_ACCESS_ISSUER?.trim() || null,
    sessionSecret: required("SESSION_SECRET"),
    sessionTtlSeconds: optionalNumber("SESSION_TTL_SECONDS", 60 * 60 * 24 * 30),
    allowedUsers: readAllowedUsers(),
    frameBufferSize: optionalNumber("FRAME_BUFFER_SIZE", 5000),
    devBypassEmail,
    devBypassAllowRemote,
    push: readPushConfig(),
  };
}

function readPushConfig(): PushConfig | null {
  const vapidPublicKey = process.env.PUSH_VAPID_PUBLIC_KEY?.trim() || "";
  const vapidPrivateKey = process.env.PUSH_VAPID_PRIVATE_KEY?.trim() || "";
  const vapidContactEmail = process.env.PUSH_VAPID_CONTACT_EMAIL?.trim() || "";
  if (!vapidPublicKey || !vapidPrivateKey || !vapidContactEmail) return null;

  return {
    vapidPublicKey,
    vapidPrivateKey,
    vapidContactEmail,
    subscriptionsFile:
      process.env.PUSH_SUBSCRIPTIONS_FILE?.trim() || "/app/data/push-subscriptions.json",
  };
}

export function isAllowedUser(config: BffConfig, email: string): AllowedUser | null {
  const normalized = email.trim().toLowerCase();
  return config.allowedUsers.find((user) => user.email === normalized) ?? null;
}
