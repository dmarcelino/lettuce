import { type BffConfig, isAllowedUser } from "../config.ts";
import { errorMessage } from "../errors.ts";
import { CF_ACCESS_JWT_HEADER, verifyAccessJwt } from "./cf-access.ts";
import {
  decodeSession,
  readCookie,
  SESSION_COOKIE,
  type SessionPayload,
} from "./session-cookie.ts";

export interface ResolvedSession {
  session: SessionPayload;
  /** Set when a session was just minted from an Access JWT: send it back. */
  setCookie?: string;
}

export interface ResolveSessionDeps {
  config: BffConfig;
  /** Build a fresh session and its cookie for `email`. */
  mint: (email: string) => { session: SessionPayload; cookie: string };
  log: (message: string) => void;
  /** Injectable for tests. */
  verify?: typeof verifyAccessJwt;
}

/**
 * The session a request carries: the cookie if it is valid, otherwise — in
 * cloudflared mode — one minted from the Access JWT Cloudflare attached.
 *
 * Both the HTTP middleware and the `/ws` upgrade go through here. The upgrade
 * used to check only the cookie, so once the 30-day cookie expired while the
 * Access login was still good, every WebSocket upgrade was refused and the app
 * sat on "Reconnecting…" until a page reload happened to pass through the
 * middleware and mint a new one.
 */
export async function resolveSession(
  request: Request,
  deps: ResolveSessionDeps,
): Promise<ResolvedSession | null> {
  const { config } = deps;
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  const existing = token ? decodeSession(token, config.sessionSecret) : null;
  if (existing) return { session: existing };

  // Local mode never looks at this header at all, even if one shows up (e.g.
  // a curious client hitting the LAN port directly) — there is no team
  // domain/audience configured to verify it against, and not even trying is
  // clearer than an incidental failure inside verifyAccessJwt.
  if (config.mode !== "cloudflared") return null;
  const jwt = request.headers.get(CF_ACCESS_JWT_HEADER);
  if (!jwt) return null;

  try {
    const { email } = await (deps.verify ?? verifyAccessJwt)(jwt, {
      teamDomain: config.cfAccessTeamDomain,
      audience: config.cfAccessAud,
      issuer: config.cfAccessIssuer,
    });
    if (!isAllowedUser(config, email)) {
      deps.log(`Rejected Access sign-in for ${email} (not in allowlist)`);
      return null;
    }
    const minted = deps.mint(email);
    deps.log(`Signed in ${email} via Cloudflare Access`);
    return { session: minted.session, setCookie: minted.cookie };
  } catch (error) {
    deps.log(`Access JWT verification failed: ${errorMessage(error)}`);
    return null;
  }
}
