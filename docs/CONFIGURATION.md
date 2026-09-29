# Configuration

Every setting lives in one file: **`docker/.env`**, next to
`docker/compose.yml`. Compose reads it automatically, and the BFF reads the
same values through the environment. Copy the template and edit it:

```bash
cp docker/.env.example docker/.env
```

`docker/.env` is gitignored and is the only place these belong. Nothing here
is read from a file by the app itself, and a value you leave commented out is
a value you are **not** setting — every one of them has a default in
`docker/compose.yml` or in `bff/src/config.ts`.

For day-to-day operational detail (logs, restarts, container-level quirks)
see [`docker/README.md`](../docker/README.md). This document is the
reference: what each variable does, which mode needs it, and the full
deployment walkthroughs.

## Required

| Variable | What it is |
|---|---|
| `PUBLIC_ORIGIN` | The origin people actually open the app on. Not cosmetic: the session cookie's `Secure` flag, the CSP's websocket allowance and the Google OAuth redirect are all derived from it. A trailing `/` is stripped. |
| `SESSION_SECRET` | Signs the session cookie (HMAC-SHA256 over `{email, exp}`). Generate with `openssl rand -hex 32`. |
| `LETTA_STATE_DIR` | Absolute path anchoring `letta-home/`, `letta-data/` and `workspaces/`. |

`SESSION_SECRET` is checked at boot and the BFF **refuses to start** if it is
shorter than 32 characters, one character repeated, or a short pattern tiled
to reach the minimum. That is the floor, not the recommendation: a guessable
secret lets anyone forge a session for any address in `ALLOWED_USERS`, and
there is no server-side session store to invalidate one against afterwards.
`LETTA_APP_SERVER_URL` is also required by the BFF, but
`docker/compose.yml` sets it; you only override it when running the BFF
outside Docker.

## Modes and profiles

One setting decides both which optional containers exist and how the BFF
behaves: `COMPOSE_PROFILES`. Compose passes it through to the BFF as
`LETTA_MODE`, so there is nothing to keep in sync by hand.

| `COMPOSE_PROFILES` | Mode | Sign-in |
|---|---|---|
| unset (default) | local | `DEV_BYPASS_EMAIL`, or nobody |
| `cloudflared` | cloudflared | Cloudflare Access |

Other profiles add sidecars and are orthogonal to the mode:

| Profile | Adds |
|---|---|
| `google` | the Gmail / Calendar / Tasks sidecar |
| `search` | SearXNG + `ddg-mcp`, behind the agents' web tools |
| `telegram` | the messaging channel gateway |

Combine them with commas and keep any profile you already have when adding
another: `COMPOSE_PROFILES=cloudflared,google,search`.

**Local mode authenticates nobody.** Whoever can reach the port *is* the
configured user, and that user's agent has your shell, your files and your
integrations. See [Security model](#security-model) before exposing it.

## Authentication

| Variable | Mode | Effect |
|---|---|---|
| `DEV_BYPASS_EMAIL` | local | Every request becomes this address. No credential check. Implies its own allowlist entry, so `ALLOWED_USERS` is not needed alongside it (set both and they must name the same people). |
| `DEV_BYPASS_ALLOW_REMOTE` | local | Required to serve the bypass beyond loopback. Without it, a non-loopback `PUBLIC_ORIGIN` + bypass refuses to boot. |
| `ALLOWED_USERS` | cloudflared | Comma-separated allowlist. Required. A defense-in-depth mirror of the Cloudflare Access policy — **not** synced automatically; update both by hand. |

Under Docker, `DEV_BYPASS_ALLOW_REMOTE=true` is needed **even for localhost**:
the BFF's loopback bind happens inside the container, where a published port
cannot reach it. The host-side boundary is `BFF_BIND`.

| Goal | Set |
|---|---|
| This machine only | `DEV_BYPASS_EMAIL`, `DEV_BYPASS_ALLOW_REMOTE=true`, `BFF_BIND=127.0.0.1`, loopback `PUBLIC_ORIGIN` |
| Devices on your LAN | `DEV_BYPASS_EMAIL`, `DEV_BYPASS_ALLOW_REMOTE=true`, `PUBLIC_ORIGIN=http://<lan-ip>:8090` |
| The internet | don't — use `cloudflared` mode |

In cloudflared mode, leave `DEV_BYPASS_EMAIL` and `DEV_BYPASS_ALLOW_REMOTE`
unset: together they open a second door that bypasses Access and
`ALLOWED_USERS` completely.

## Networking

| Variable | Default | Effect |
|---|---|---|
| `BFF_PORT` | `8090` | Host port the app is published on. |
| `BFF_BIND` | `0.0.0.0` | Host interface the published port listens on. Set `127.0.0.1` in cloudflared mode — the tunnel reaches the BFF over Docker's internal network, so a LAN-reachable port is a door nobody needs open. |
| `PORT` | `8080` | The BFF's own listen port, inside the container. Rarely worth changing. |

## Session and tuning

| Variable | Default | Effect |
|---|---|---|
| `SESSION_TTL_SECONDS` | `2592000` (30 days) | Session cookie lifetime. |
| `FRAME_BUFFER_SIZE` | `5000` | Total streaming frames retained for session resume, across all conversations. |
| `SHUTDOWN_DRAIN_TIMEOUT_SECONDS` | `540` (9 min) | How long `SIGTERM` waits for in-flight turns before closing upstream. Must stay below the container's `stop_grace_period` (10m), and drain + image build under Dockhand's 900 s `compose up` timeout. |

## Cloudflare Access (cloudflared mode)

All of this comes from the Zero Trust dashboard; the click-by-click setup is
in
[`docker/README.md` → Remote access via Cloudflare Tunnel](../docker/README.md).

| Variable | Example |
|---|---|
| `CLOUDFLARE_TUNNEL_TOKEN` | tunnel token from Zero Trust |
| `CF_ACCESS_TEAM_DOMAIN` | `acme` — the `<team>` in `<team>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | the Access application's Audience (AUD) tag |
| `CF_ACCESS_ISSUER` | only during a Zero Trust team rename, while old tokens still name the old team |

`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are required in cloudflared mode
unless the dev bypass is active. Local mode never reads them.

## Version pins

Every third-party thing the stack runs is pinned. `bun run check-version-pin`
verifies every copy agrees; leave these alone unless you are deliberately
upgrading.

| Variable | Default | Pins |
|---|---|---|
| `LETTA_CODE_VERSION` | `0.33.3` | the letta-code release — app-server image, channel gateway image, and the `@letta-ai/letta-code` the UI was built against |
| `CODEX_VERSION` | `0.157.1` | the Codex CLI worker |
| `GH_VERSION` | `2.101.0` | GitHub CLI, used by the `WatchPR` tool |
| `WORKSPACE_MCP_VERSION` | `1.29.0` | the workspace MCP server |
| `SEARXNG_VERSION` | `2026.9.23-3cd69d30e` | `searxng/searxng` image tag |
| `DDG_MCP_VERSION` | `0.7.0` | `duckduckgo-mcp-server` release |

## Web search

Needs the `search` profile. Agents get `web_search` and `fetch_webpage` as
native tools; SearXNG answers searches, `ddg-mcp` reads pages and is the
search fallback. Neither publishes a port. Settings → Web has the switch,
backend status and a test search.

| Variable | Default | Effect |
|---|---|---|
| `SEARXNG_URL` | `http://searxng:8080` | empty switches SearXNG off |
| `DDG_MCP_URL` | `http://ddg-mcp:8000/mcp` | empty switches page reading and the fallback off |
| `DDG_REGION` | `us-en` | results region |
| `DDG_SAFE_SEARCH` | `OFF` | `STRICT`, `MODERATE` or `OFF` |

Without the profile the tools stay registered and every call fails with the
backend's error, so switch them off in Settings → Web.

## Google (Gmail, Calendar, Tasks)

Needs the `google` profile. The client ID/secret and the per-service
permission levels are entered in **Settings → Google**, not here.

| Variable | Default | Effect |
|---|---|---|
| `GOOGLE_OAUTH_REDIRECT_URI` | `${PUBLIC_ORIGIN}/api/google/oauth/callback` | override; must match a redirect URI on the OAuth client exactly. Google accepts only `https` or `localhost`, so a plain-http LAN origin needs `http://localhost:8090/...` plus a browser on the host. |
| `GOOGLE_ALLOW_DEV_BYPASS` | `false` | lets a dev-bypass session change Google access. Off by default because agent shells share the BFF's network namespace and could change the levels themselves; behind Cloudflare Access they cannot. |

## Push notifications

Fully optional and self-gating: all three or none. With any one missing,
push is off silently — a typo in one name looks exactly like "not
configured".

| Variable | Effect |
|---|---|
| `PUSH_VAPID_PUBLIC_KEY` | VAPID public key |
| `PUSH_VAPID_PRIVATE_KEY` | VAPID private key |
| `PUSH_VAPID_CONTACT_EMAIL` | the VAPID `sub` claim; bare address, the BFF adds `mailto:` |

Generate a keypair once with `cd bff && bunx web-push generate-vapid-keys`.
Rotating the keys invalidates every existing subscription; each device must
re-subscribe from Settings → Notifications. Full behaviour (what triggers a
push, the visibility check, iOS requirements) is in
[`docker/README.md` → Push notifications](../docker/README.md).

## Web apps agents serve

Agents can run small web apps inside the app-server container. Only ports
**3000-3099** are published, and they have **no authentication**.

| Variable | Default | Effect |
|---|---|---|
| `AGENT_APP_HOST` | unset | the address people open apps on, e.g. the server's LAN IP. Agents put it in the URLs they hand you; unset, they ask you to fill it in. |
| `AGENT_APPS_BIND` | `0.0.0.0` | published interface. Use the LAN IP to keep it off other interfaces, or `127.0.0.1` to close it. |

Changing either recreates `app-server`: run
`docker compose -f docker/compose.yml up -d` unscoped.

## Telegram

Needs the `telegram` profile. There are no environment variables for it —
channel configuration happens once inside the gateway container with
`letta channels configure telegram`, and pairing with `letta channels pair`.
The walkthrough is in
[`docker/README.md` → Telegram](../docker/README.md).

## Where state lives

Everything durable is under `LETTA_STATE_DIR`, and copying that one directory
backs up the whole install.

```
$LETTA_STATE_DIR/
  letta-home/     settings, global skills, CLI logins
  letta-data/     conversations and agent memory
  workspaces/     the directories agents work in
```

The default is `../..` relative to `docker/compose.yml`, which is a trap:
run compose from a git worktree and the stack comes up healthy against a
*different*, usually empty, state directory. Always set it absolutely.

The only named volume left is `bff-data` (web-push device endpoints, pinned
and archived agent lists, per-agent tool access). Losing it means
re-subscribing devices and re-pinning agents; nothing else is lost.

Migrating an install still on the old named volumes:

```bash
docker compose -f docker/compose.yml down
bun run migrate-state          # copies, verifies, deletes nothing
docker compose -f docker/compose.yml up -d
```

## Deployment walkthroughs

### Local, this machine only

```bash
cp docker/.env.example docker/.env
# PUBLIC_ORIGIN=http://localhost:8090
# SESSION_SECRET=$(openssl rand -hex 32)
# LETTA_STATE_DIR=/absolute/path/to/state
# DEV_BYPASS_EMAIL=you@example.com
# DEV_BYPASS_ALLOW_REMOTE=true
# BFF_BIND=127.0.0.1
docker compose -f docker/compose.yml up -d --build
```

Then point it at a model once:

```bash
docker compose -f docker/compose.yml exec app-server letta connect
# choose "llama.cpp (local)", base URL http://host.docker.internal:8080/v1
```

### LAN (phones and other devices)

Same as above, but `PUBLIC_ORIGIN=http://<lan-ip>:8090` and drop
`BFF_BIND` so the port is reachable on the LAN interface. Anyone who can
reach that port controls the agent — use it only on a network you trust.

### Cloudflare Tunnel (recommended for remote)

```
COMPOSE_PROFILES=cloudflared
LETTA_STATE_DIR=/srv/letta
PUBLIC_ORIGIN=https://<your-hostname>
SESSION_SECRET=<openssl rand -hex 32>
ALLOWED_USERS=you@example.com
CF_ACCESS_TEAM_DOMAIN=acme
CF_ACCESS_AUD=<Access application Audience tag>
CLOUDFLARE_TUNNEL_TOKEN=<tunnel token>
BFF_BIND=127.0.0.1
```

Create the tunnel, the public hostname pointing at `app-server:8080` (not
`bff` — the BFF shares the app-server's network namespace), the Google login
method and the Access application in the Zero Trust dashboard, then mirror
that application's policy in `ALLOWED_USERS` by hand.

### Production (Dockhand or any compose manager)

The host needs `git` + `docker` and a clone of this repo only — no Bun, no
letta-code checkout, no pre-built images.

| Variable | Value |
|---|---|
| `COMPOSE_PROFILES` | `cloudflared,google,search` (drop what you don't want) |
| `LETTA_STATE_DIR` | `/srv/letta` |
| `PUBLIC_ORIGIN` | `https://<your-hostname>` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `ALLOWED_USERS` | `you@example.com` |
| `CF_ACCESS_TEAM_DOMAIN` | `acme` |
| `CF_ACCESS_AUD` | Access application Audience tag |
| `CLOUDFLARE_TUNNEL_TOKEN` | tunnel token |
| `LETTA_CODE_VERSION` | must match the tracked pin — `bun run check-version-pin` |
| `BFF_BIND` | `127.0.0.1` |

Optional: the three `PUSH_VAPID_*` values, `BFF_PORT`,
`SESSION_TTL_SECONDS`, `FRAME_BUFFER_SIZE`, `CF_ACCESS_ISSUER`.

### Without Docker (development)

Requires [Bun](https://bun.sh).

```bash
# Terminal 1 — app-server on the host
LETTA_LOCAL_BACKEND_EXPERIMENTAL=true letta server --listen ws://127.0.0.1:4500

# Terminal 2 — BFF
cd bff && \
  LETTA_APP_SERVER_URL=ws://127.0.0.1:4500 \
  PUBLIC_ORIGIN=http://localhost:8080 \
  SESSION_SECRET=$(openssl rand -hex 32) \
  DEV_BYPASS_EMAIL=you@example.com \
  bun --watch src/index.ts

# Terminal 3 — Vite
cd web && bun run dev
```

Here the BFF's loopback bind *is* a real boundary, so
`DEV_BYPASS_ALLOW_REMOTE` is not needed.

## Security model

- **Cloudflare Access is the gate** in cloudflared mode. The app only
  verifies the JWT Access injects after a human signs in; `ALLOWED_USERS` is
  what still stands if that policy is ever misconfigured.
- **Local mode has no gate.** `DEV_BYPASS_EMAIL` authenticates nobody, which
  is why a non-loopback origin with a bypass refuses to start unless
  `DEV_BYPASS_ALLOW_REMOTE=true` says so explicitly.
- **The session secret is the whole trust anchor.** There is no server-side
  session store, so a leaked secret forges sessions until it is rotated.
  Hence the boot-time strength check.
- **HSTS is sent only on an `https` `PUBLIC_ORIGIN`.** Pinning a host whose
  TLS may not work yet would lock the operator out for a year.
- **Agent tokens are not equally protected.** The GitHub token under
  `/root/.letta` is readable by every agent shell; the Google token and its
  permission levels live on volumes only the BFF and the sidecar mount.
- **Agent-served web apps are unauthenticated** and do not survive an
  app-server restart.

## Troubleshooting boot failures

| Message | Fix |
|---|---|
| `Missing required environment variable SESSION_SECRET` | Set it: `openssl rand -hex 32`. |
| `SESSION_SECRET is too short (N characters, minimum 32)` | Same — a longer, random value. |
| `SESSION_SECRET is one character repeated` / `N-character pattern repeated` | Same — don't pad a short secret. |
| `Refusing to start: DEV_BYPASS_EMAIL is set but PUBLIC_ORIGIN is reachable from other machines` | Use a loopback origin, or switch to cloudflared mode, or set `DEV_BYPASS_ALLOW_REMOTE=true` knowingly. |
| `Missing required environment variable CF_ACCESS_AUD` (or `CF_ACCESS_TEAM_DOMAIN`) | You're in cloudflared mode without Access credentials. |
| `PORT` / `SESSION_TTL_SECONDS` / `FRAME_BUFFER_SIZE` "must be a positive number" | The value isn't a positive number; empty means "use the default". |
| Boots fine, every request resets | Loopback bind under Docker. Set `DEV_BYPASS_ALLOW_REMOTE=true` and check `BFF_BIND`. |
| Healthy stack, empty state | `LETTA_STATE_DIR` is relative and you ran compose from a worktree. Set it absolutely. |
