/**
 * Settings → Google, end to end: saving the policy, running the consent,
 * keeping the token file and the sidecar's config in step.
 *
 * The invariant everything here maintains: **the token never carries a scope
 * the current policy does not want.** Narrowing a level therefore revokes the
 * token outright (Google would otherwise keep honouring the wider grant for as
 * long as the refresh token lives) and a fresh consent is needed. Widening
 * keeps the token; the sidecar stays at what it covers until reconnected.
 */

import {
  buildAuthUrl,
  exchangeCode,
  type Fetch,
  fetchAccountEmail,
  GoogleGrantRevokedError,
  newPkce,
  newState,
  refreshGrant,
  revokeToken,
} from "./oauth.ts";
import { type GooglePermissions, hasAnyService, scopesForPermissions } from "./policy.ts";
import {
  applyGoogleSettingsUpdate,
  credentialFileName,
  GOOGLE_SETTINGS_FILE,
  GOOGLE_SIDECAR_FILE,
  type GoogleSettings,
  isServing,
  type PublicGoogleSettings,
  parseStoredGoogleSettings,
  renderCredentialFile,
  renderSidecarConfig,
  renderStoredGoogleSettings,
  toPublicGoogleSettings,
} from "./settings.ts";

export interface GoogleIo {
  /** A file in the policy directory; null when absent. */
  readPolicy(name: string): Promise<string | null>;
  /** Atomically replace a file in the policy directory. */
  writePolicy(name: string, content: string): Promise<void>;
  /** File names in the credentials directory. */
  listCreds(): Promise<string[]>;
  readCred(name: string): Promise<string | null>;
  /** Atomically replace a credentials file, readable by its owner only. */
  writeCred(name: string, content: string): Promise<void>;
  deleteCred(name: string): Promise<void>;
}

export interface GoogleServiceDeps {
  io: GoogleIo;
  fetch: Fetch;
  /** Where Google sends the browser back to — must match the OAuth client exactly. */
  redirectUri: string;
  /** Put the sidecar into the shared MCP list while it serves; take it out when not. */
  syncMcpEntry: (serving: boolean) => Promise<void>;
  log: (message: string) => void;
  now?: () => number;
}

/** A consent in flight, keyed by its `state`. */
interface PendingConsent {
  verifier: string;
  requested: GooglePermissions;
  expiresAt: number;
}

const CONSENT_TTL_MS = 10 * 60 * 1000;

/** A request we refuse, with a message fit for the user. */
export class GoogleAccessError extends Error {}

export class GoogleService {
  private readonly pending = new Map<string, PendingConsent>();
  /** Mutations read, decide, then write several files: one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: GoogleServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async load(): Promise<GoogleSettings> {
    return parseStoredGoogleSettings(await this.deps.io.readPolicy(GOOGLE_SETTINGS_FILE));
  }

  async status(): Promise<PublicGoogleSettings> {
    return toPublicGoogleSettings(await this.load());
  }

  /** Settings first, then the sidecar's config, then the MCP list. */
  private async persist(settings: GoogleSettings): Promise<void> {
    await this.deps.io.writePolicy(GOOGLE_SETTINGS_FILE, renderStoredGoogleSettings(settings));
    await this.deps.io.writePolicy(GOOGLE_SIDECAR_FILE, renderSidecarConfig(settings));
    try {
      await this.deps.syncMcpEntry(isServing(settings));
    } catch (error) {
      // The list is only discovery; access is decided in the sidecar. A failed
      // sync is retried on the next upstream connect.
      this.deps.log(`Google: could not update the MCP list: ${String(error)}`);
    }
  }

  /** On boot and every upstream connect: re-render from what is stored. */
  reapply(): Promise<void> {
    return this.serialized(async () => this.persist(await this.load()));
  }

  private async readRefreshToken(): Promise<string | null> {
    for (const name of await this.deps.io.listCreds()) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse((await this.deps.io.readCred(name)) ?? "") as {
          refresh_token?: unknown;
        };
        if (typeof parsed.refresh_token === "string") return parsed.refresh_token;
      } catch {
        // An unreadable file holds no token we can revoke.
      }
    }
    return null;
  }

  private async clearCreds(): Promise<void> {
    for (const name of await this.deps.io.listCreds()) await this.deps.io.deleteCred(name);
  }

  /**
   * Revoke the stored token at Google and delete every credential file. A
   * revoke that fails still clears the files: the sidecar must stop using the
   * token either way, and the user is told to remove access by hand.
   */
  private async dropGrant(settings: GoogleSettings, why: string): Promise<string | null> {
    let warning: string | null = null;
    const token = await this.readRefreshToken();
    if (token) {
      try {
        await revokeToken(this.deps.fetch, token);
        this.deps.log(`Google: revoked the token (${why})`);
      } catch (error) {
        warning =
          "Google did not confirm the revoke. Remove access by hand at " +
          "https://myaccount.google.com/permissions.";
        this.deps.log(`Google: revoke failed (${why}): ${String(error)}`);
      }
    }
    await this.clearCreds();
    settings.grant = null;
    return warning;
  }

  /** Scopes the token has that the policy does not want. */
  private excessScopes(settings: GoogleSettings, scopes: readonly string[]): string[] {
    const wanted = new Set(scopesForPermissions(settings.permissions));
    return scopes.filter((scope) => !wanted.has(scope));
  }

  async save(body: unknown): Promise<{ settings: PublicGoogleSettings; warning: string | null }> {
    return this.serialized(async () => {
      const current = await this.load();
      const next = applyGoogleSettingsUpdate(current, body);
      let warning: string | null = null;

      if (next.grant) {
        const clientChanged =
          next.clientId !== current.clientId || next.clientSecret !== current.clientSecret;
        if (clientChanged) {
          warning = await this.dropGrant(next, "OAuth client changed");
        } else if (this.excessScopes(next, next.grant.scopes).length > 0) {
          warning = await this.dropGrant(next, "access narrowed");
        }
      }

      await this.persist(next);
      return { settings: toPublicGoogleSettings(next), warning };
    });
  }

  /** Begin a consent for the current policy. Returns Google's URL. */
  async startConnect(): Promise<string> {
    const settings = await this.load();
    if (!settings.clientId || !settings.clientSecret) {
      throw new GoogleAccessError("Save an OAuth client ID and secret first");
    }
    if (!hasAnyService(settings.permissions)) {
      throw new GoogleAccessError("Choose at least one service first");
    }
    const now = this.now();
    for (const [state, consent] of this.pending) {
      if (consent.expiresAt < now) this.pending.delete(state);
    }
    const state = newState();
    const pkce = newPkce();
    this.pending.set(state, {
      verifier: pkce.verifier,
      requested: { ...settings.permissions },
      expiresAt: now + CONSENT_TTL_MS,
    });
    return buildAuthUrl({
      clientId: settings.clientId,
      redirectUri: this.deps.redirectUri,
      scopes: scopesForPermissions(settings.permissions),
      state,
      codeChallenge: pkce.challenge,
      loginHint: settings.grant?.email,
    });
  }

  /**
   * Google's redirect back. The `state` is what authorises this: it is
   * single-use, expires, and only `startConnect` — behind a signed-in session
   * that may change settings — mints one. Returns the connected account.
   */
  async finishConnect(query: {
    state?: string;
    code?: string;
    error?: string;
  }): Promise<{ email: string; settings: PublicGoogleSettings }> {
    const consent = query.state ? this.pending.get(query.state) : undefined;
    if (!query.state || !consent || consent.expiresAt < this.now()) {
      throw new GoogleAccessError("This sign-in link has expired. Start again from Settings.");
    }
    this.pending.delete(query.state);
    if (query.error) throw new GoogleAccessError(`Google said: ${query.error}`);
    if (!query.code) throw new GoogleAccessError("Google sent no authorisation code");
    const code = query.code;

    return this.serialized(async () => {
      const settings = await this.load();
      if (!settings.clientId || !settings.clientSecret) {
        throw new GoogleAccessError("The OAuth client was removed while signing in");
      }
      const tokens = await exchangeCode(this.deps.fetch, {
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        code,
        redirectUri: this.deps.redirectUri,
        codeVerifier: consent.verifier,
      });

      // The policy may have been narrowed while the consent screen was open,
      // or Google may have folded in an older grant: either way this token can
      // do more than is wanted now, so it is not kept.
      const excess = this.excessScopes(settings, tokens.scopes);
      if (excess.length > 0) {
        await revokeToken(this.deps.fetch, tokens.refreshToken).catch(() => undefined);
        throw new GoogleAccessError(
          `Google granted more than the current settings allow (${excess.join(", ")}); ` +
            "the token was revoked. Connect again.",
        );
      }

      const email = await fetchAccountEmail(this.deps.fetch, tokens.accessToken);
      const previous = await this.readRefreshToken();
      if (previous && previous !== tokens.refreshToken) {
        await revokeToken(this.deps.fetch, previous).catch((error) =>
          this.deps.log(`Google: could not revoke the replaced token: ${String(error)}`),
        );
      }
      // workspace-mcp's single-user mode takes the first credential file it
      // finds, so there must never be more than one.
      await this.clearCreds();
      await this.deps.io.writeCred(
        credentialFileName(email),
        renderCredentialFile(settings, tokens),
      );

      settings.grant = {
        email,
        scopes: tokens.scopes,
        requested: consent.requested,
        grantedAt: new Date(this.now()).toISOString(),
      };
      await this.persist(settings);
      this.deps.log(`Google: connected ${email} (${tokens.scopes.length} scopes)`);
      return { email, settings: toPublicGoogleSettings(settings) };
    });
  }

  /** Revoke and forget the token. The policy and client stay. */
  async disconnect(): Promise<{ settings: PublicGoogleSettings; warning: string | null }> {
    return this.serialized(async () => {
      const settings = await this.load();
      const warning = await this.dropGrant(settings, "disconnected");
      await this.persist(settings);
      return { settings: toPublicGoogleSettings(settings), warning };
    });
  }

  /**
   * Ask Google, now, what the token can do. The grant's scopes are otherwise
   * only what Google said at consent, and the account owner can revoke access
   * from their Google account at any time.
   */
  async verify(): Promise<{ settings: PublicGoogleSettings; warning: string | null }> {
    return this.serialized(async () => {
      const settings = await this.load();
      if (!settings.grant) throw new GoogleAccessError("Not connected");
      if (!settings.clientId || !settings.clientSecret) {
        throw new GoogleAccessError("No OAuth client is saved");
      }
      const refreshToken = await this.readRefreshToken();
      let warning: string | null = null;
      if (!refreshToken) {
        settings.grant = null;
        warning = "The token file is gone. Connect again.";
      } else {
        try {
          const live = await refreshGrant(this.deps.fetch, {
            clientId: settings.clientId,
            clientSecret: settings.clientSecret,
            refreshToken,
          });
          settings.grant = { ...settings.grant, scopes: live.scopes };
          if (this.excessScopes(settings, live.scopes).length > 0) {
            warning =
              (await this.dropGrant(settings, "token wider than the policy")) ??
              "The token could do more than the settings allow, so it was revoked.";
          }
        } catch (error) {
          if (!(error instanceof GoogleGrantRevokedError)) throw error;
          await this.clearCreds();
          settings.grant = null;
          warning = "Google no longer accepts this token (revoked or expired). Connect again.";
        }
      }
      await this.persist(settings);
      return { settings: toPublicGoogleSettings(settings), warning };
    });
  }
}
