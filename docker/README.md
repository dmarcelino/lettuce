# Running the stack

## One-time setup

```bash
# 1. Capability token the BFF presents to the app-server.
mkdir -p docker/secrets
openssl rand -hex 32 > docker/secrets/ws-token
chmod 600 docker/secrets/ws-token

# 2. Allowlist.
cp config/users.example.json config/users.json   # edit it

# 3. Environment.
cat > docker/.env <<'ENV'
PUBLIC_ORIGIN=http://localhost:8090
SESSION_SECRET=<openssl rand -hex 32>
# To actually sign in locally, also set (see Authentication below):
# DEV_BYPASS_EMAIL=you@example.com
ENV

# 4. Build the fork so its dist/ (protocol types + client) exists.
cd ../letta-code && bun install && bun run build
```

## Modes: local (default) vs cloudflared

The stack runs in one of two modes, switched by **one setting**:
`COMPOSE_PROFILES` in `docker/.env`.

| | `COMPOSE_PROFILES` unset (default) | `COMPOSE_PROFILES=cloudflared` |
|---|---|---|
| Reachability | Directly on the LAN | Only through the Cloudflare Tunnel |
| Auth | `DEV_BYPASS_EMAIL` (see below) | Cloudflare Access |
| `cloudflared` container | Not created at all | Created, tunnels to `app-server:8080` |
| Cloudflare account needed | No | Yes |

Compose's own `COMPOSE_PROFILES` variable is also what the app reads (as
`LETTA_MODE`, passed through in `docker/compose.yml`) — one setting drives
both which containers exist and how the BFF behaves, nothing to keep in sync
by hand.

## Authentication

### Local mode (default)

Nothing is required beyond the one-time setup above to *boot*, but by
default **nothing signs anyone in either** — the app answers "not signed in"
until you configure `DEV_BYPASS_EMAIL`. It skips sign-in entirely: any
request that reaches the port becomes the configured user, no credential
check at all.

Because that is easy to leave on by accident, exposing it beyond the local
machine takes a second, deliberate flag:

| Configuration | Result |
|---|---|
| `DEV_BYPASS_EMAIL` unset | Nobody can sign in (safe default, but unusable until set) |
| Set, loopback `PUBLIC_ORIGIN` | Bypass active, bound to `127.0.0.1` only |
| Set, non-loopback `PUBLIC_ORIGIN` (e.g. a LAN IP) | **Refuses to start** |
| Set, plus `DEV_BYPASS_ALLOW_REMOTE=true` | Bypass active and reachable on the network, with a startup banner |

The last row is the normal local-mode configuration for reaching the UI from
your phone or another device on the same network — set `PUBLIC_ORIGIN` to
your machine's LAN IP (e.g. `http://192.168.1.4:8090`) alongside it. It means
anyone who can reach the port controls the agent — and the agent has your
Gmail, Calendar and shell — so use it only on a network you trust.

### Remote access via Cloudflare Tunnel (cloudflared mode)

Set `COMPOSE_PROFILES=cloudflared` and gate access with **Cloudflare
Access**, not anything this app runs itself — the app only verifies the JWT
Access injects once a visitor signs in. All of the following is manual, done
once in the Cloudflare Zero Trust dashboard (none of it is automatable from
this repo):

1. **Networks → Tunnels → Create a tunnel** (choose "Cloudflared"). Copy the
   token it gives you into `docker/.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
2. On that tunnel's **Public Hostname** tab, add a route: your chosen
   hostname → service `HTTP` → `app-server:8080` (yes, `app-server`, not
   `bff` — the BFF shares the app-server's network namespace and has no name
   of its own on the Docker network).
3. **Settings → Authentication → Login methods → Add → Google.** Needs its
   own Google OAuth client (Google Cloud Console → Credentials → OAuth client
   ID → Web application); the redirect URI Cloudflare shows you during setup
   is the one to register there.
4. **Access → Applications → Add an application → Self-hosted**, for the
   hostname from step 2. Add a policy with an Include rule listing the same
   email address(es) as `config/users.json` — **these two lists are not kept
   in sync automatically**; update both by hand when adding or removing a
   user.
5. Copy the Application's **Audience (AUD) tag** into `docker/.env` as
   `CF_ACCESS_AUD`, and the team domain (the `<team>` in
   `<team>.cloudflareaccess.com`) as `CF_ACCESS_TEAM_DOMAIN`.

Also update, in `docker/.env`:
- `PUBLIC_ORIGIN=https://<your-tunnel-hostname>` — the `https://` is what
  marks the session cookie `Secure`.
- `BFF_BIND=127.0.0.1` — Compose can't derive this from `COMPOSE_PROFILES`'s
  value, so it's a manual pairing. Once Access is the gate, the tunnel
  reaches the BFF over the internal Docker network, not this published port,
  so there's no legitimate reason to leave it reachable on the LAN too.
- Optionally unset `DEV_BYPASS_EMAIL` — it still works in cloudflared mode
  exactly as in local mode (it's unrelated to and unaffected by Access), so
  leaving it set means BOTH doors are open. Decide deliberately.

If the Zero Trust team is ever renamed, JWKS moves to the new team domain but
outstanding tokens may still carry the old one in `iss`. Set
`CF_ACCESS_ISSUER` to the *old* `https://<old-team>.cloudflareaccess.com`
during the transition, and remove it once every session has naturally
re-authenticated.

## Run

```bash
docker compose -f docker/compose.yml up --build
```

The BFF serves the built SPA at `PUBLIC_ORIGIN` (default
`http://localhost:8090`) and the app-server stays on loopback only. The image
builds `web/` in its own stage and the BFF serves it from `WEB_DIST`
(`web/dist`); API, auth and health routes are registered first, so the SPA
fallback cannot shadow them.

## Connect the model

llama.cpp runs on the host. Point the app-server at it once:

```bash
docker compose -f docker/compose.yml exec app-server letta connect
# choose "llama.cpp (local)", base URL http://host.docker.internal:8080/v1
```

## Telegram

Channel configuration is not available in the web UI — the app-server has no path
for it (see CLAUDE.md). Set it up once in the gateway container:

```bash
C="docker compose -f docker/compose.yml exec channel-gateway"

$C letta channels install telegram        # installs the runtime dependency
$C letta channels status                  # should show telegram configured:false

# Interactive; needs a bot token from @BotFather. -it, not exec -T.
docker compose -f docker/compose.yml exec -it channel-gateway \
  letta channels configure telegram

docker compose -f docker/compose.yml restart channel-gateway
```

Then message the bot, and pair the chat to an agent:

```bash
$C letta channels pair --channel telegram --code <code-from-bot> \
  --agent <agent-id> --conversation <conversation-id>
$C letta channels status
```

## Push notifications

Fully optional and self-gating — leave the three `PUSH_VAPID_*` variables
unset and the BFF runs with push disabled, no error. The only trigger today
is "the agent finished a turn while nobody was watching that conversation".

Generate a VAPID keypair once:

```bash
cd bff && bunx web-push generate-vapid-keys
```

Put the public/private pair into `docker/.env` as `PUSH_VAPID_PUBLIC_KEY` /
`PUSH_VAPID_PRIVATE_KEY`, and set `PUSH_VAPID_CONTACT_EMAIL` to the
allowlisted email (it becomes the VAPID `sub` claim, as a bare `mailto:`
address — push services use it to contact you if your server is misbehaving).

**Rotating these keys silently invalidates every existing subscription** —
every previously-subscribed device stops receiving pushes until it
re-subscribes from Settings → Notifications. There is no migration path;
this is an operational fact to plan around, not a bug.

Subscriptions persist in `bff-data/push-subscriptions.json` on the host (bind
mounted, gitignored — it holds device push endpoints, not secrets, but isn't
meant to be committed either).

iOS only delivers Web Push to a PWA actually added to the Home Screen — a
Safari tab (or Chrome/Firefox on iOS, which can't install a PWA at all) never
receives it. The Notifications settings section shows an install prompt
instead of a toggle when it detects this.

## Local development without Docker

```bash
# Terminal 1 — app-server on the host
LETTA_LOCAL_BACKEND_EXPERIMENTAL=true letta server --listen ws://127.0.0.1:4500

# Terminal 2 — BFF (dev bypass; local mode needs no CF_ACCESS_* vars at all)
cd bff && \
  LETTA_APP_SERVER_URL=ws://127.0.0.1:4500 \
  LETTA_APP_SERVER_TOKEN=unused \
  PUBLIC_ORIGIN=http://localhost:8080 \
  SESSION_SECRET=$(openssl rand -hex 32) \
  USERS_FILE=../config/users.json \
  DEV_BYPASS_EMAIL=you@example.com \
  bun --watch src/index.ts

# Terminal 3 — Vite
cd web && bun run dev
```

Note: an app-server started without `--ws-auth` ignores the `Authorization`
header entirely, so the token value is irrelevant there — but the BFF still
requires one of `LETTA_APP_SERVER_TOKEN` / `LETTA_APP_SERVER_TOKEN_FILE` to be
set, hence the placeholder.
