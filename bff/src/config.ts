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
  /**
   * Lower-cased addresses permitted to hold a session. In cloudflared mode this
   * is a defense-in-depth mirror of the Cloudflare Access policy — Access is
   * the gate, and this is what still stands if that policy is ever
   * misconfigured (a bypass rule, "everyone in the directory"). It stays a
   * LIST, not a single address, precisely because the policy it mirrors is one.
   *
   * "Single-user" in this project means no per-user isolation — one runtime,
   * every socket sees every event — not that only one address may sign in.
   */
  allowedUsers: string[];
  /** Total frames retained for session resume across all conversations. */
  frameBufferSize: number;
  /**
   * How long SIGTERM waits for in-flight turns before closing the upstream
   * connection (see `shutdown.ts`). Must stay below the container's
   * `stop_grace_period`, or Docker's SIGKILL ends the drain first.
   */
  shutdownDrainTimeoutMs: number;
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

/**
 * Parses a comma-separated allowlist, naming `source` in every error so a
 * misconfiguration says which input to go and fix.
 *
 *   a@example.com, b@example.com
 *
 * Addresses are lower-cased and de-duplicated; `isAllowedUser` compares against
 * an already-lowercased address, so normalizing here is what makes a
 * capitalized entry match at all.
 *
 * The `@` check is deliberately the only validation. It catches the realistic
 * failure — a typo'd or truncated env var — at BOOT rather than as an
 * unexplained 403 at sign-in, which is all that would happen otherwise since an
 * address that matches nothing simply never matches. Anything stricter is the
 * classic email-regex trap and would start rejecting valid addresses.
 */
export function parseAllowedUsers(raw: string, source: string): string[] {
  const emails = raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (emails.length === 0) throw new Error(`${source} lists no addresses`);

  const invalid = emails.filter((email) => !email.includes("@"));
  if (invalid.length > 0) {
    throw new Error(
      `${source} contains entries that are not email addresses: ${invalid.join(", ")}`,
    );
  }

  return [...new Set(emails)];
}

/**
 * The allowlist comes from the environment and nowhere else — there is no file.
 *
 * In local mode DEV_BYPASS_EMAIL *is* the whole configuration, so it implies
 * its own entry. Requiring both used to mean two settings naming the same
 * person that could only ever disagree with each other, and when they did the
 * result was a 403 saying the bypass email was not in the allowlist — a
 * self-contradiction rather than a diagnosis.
 *
 * With neither set the list is empty and nobody can sign in, which is the
 * documented safe default rather than an error.
 */
function readAllowedUsers(accessIsTheGate: boolean, devBypassEmail: string | null): string[] {
  const inline = process.env.ALLOWED_USERS?.trim();
  if (inline) return parseAllowedUsers(inline, "ALLOWED_USERS");

  if (accessIsTheGate) {
    throw new Error(
      "Missing required environment variable ALLOWED_USERS. Cloudflare Access is the gate in " +
        "this mode, and this list is the check that still stands if that policy is ever " +
        "misconfigured — so it cannot be inferred. Set it to a comma-separated list of the " +
        "same addresses the Access policy allows.",
    );
  }

  return devBypassEmail ? [devBypassEmail.toLowerCase()] : [];
}

function isLoopbackOrigin(publicOrigin: string): boolean {
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
  // The allowlist keys off the same condition: it is required exactly when
  // Access is the thing actually signing people in.
  const needsCfAccess = mode === "cloudflared" && !devBypassEmail;
  return {
    mode,
    port: optionalNumber("PORT", 8080),
    appServerUrl: required("LETTA_APP_SERVER_URL"),
    publicOrigin,
    cfAccessTeamDomain: needsCfAccess
      ? required("CF_ACCESS_TEAM_DOMAIN")
      : (process.env.CF_ACCESS_TEAM_DOMAIN ?? ""),
    cfAccessAud: needsCfAccess ? required("CF_ACCESS_AUD") : (process.env.CF_ACCESS_AUD ?? ""),
    cfAccessIssuer: process.env.CF_ACCESS_ISSUER?.trim() || null,
    sessionSecret: required("SESSION_SECRET"),
    sessionTtlSeconds: optionalNumber("SESSION_TTL_SECONDS", 60 * 60 * 24 * 30),
    allowedUsers: readAllowedUsers(needsCfAccess, devBypassEmail),
    frameBufferSize: optionalNumber("FRAME_BUFFER_SIZE", 5000),
    shutdownDrainTimeoutMs: optionalNumber("SHUTDOWN_DRAIN_TIMEOUT_SECONDS", 15 * 60) * 1000,
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

export function isAllowedUser(config: BffConfig, email: string): boolean {
  return config.allowedUsers.includes(email.trim().toLowerCase());
}
