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
PUBLIC_ORIGIN=https://<your-tunnel-hostname>
SESSION_SECRET=<openssl rand -hex 32>
CF_ACCESS_TEAM_DOMAIN=<your-team>.cloudflareaccess.com's <your-team> part
CF_ACCESS_AUD=<from the Access Application, see Authentication below>
CLOUDFLARE_TUNNEL_TOKEN=<from the Cloudflare Tunnel, see Authentication below>
ENV

# 4. Build the fork so its dist/ (protocol types + client) exists.
cd ../letta-code && bun install && bun run build
```

## Authentication

The compose stack is gated by **Cloudflare Access**, not by anything this app
runs itself — the app only verifies the JWT Access injects once a visitor
signs in. All of the following is manual, done once in the Cloudflare Zero
Trust dashboard (none of it is automatable from this repo):

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

If the Zero Trust team is ever renamed, JWKS moves to the new team domain but
outstanding tokens may still carry the old one in `iss`. Set
`CF_ACCESS_ISSUER` to the *old* `https://<old-team>.cloudflareaccess.com`
during the transition, and remove it once every session has naturally
re-authenticated.

`DEV_BYPASS_EMAIL` skips sign-in entirely, for local development only. It
authenticates **nobody** — any request that reaches the port becomes the
configured user. It is unrelated to Cloudflare Access and unaffected by it.

Because that is easy to leave switched on by accident, exposing it beyond the
local machine takes a second, deliberate flag:

| Configuration | Result |
|---|---|
| `DEV_BYPASS_EMAIL` unset | Cloudflare Access required (default for the compose stack) |
| Set, loopback `PUBLIC_ORIGIN` | Bypass active, bound to `127.0.0.1` |
| Set, non-loopback `PUBLIC_ORIGIN` | **Refuses to start** |
| Set, plus `DEV_BYPASS_ALLOW_REMOTE=true` | Bypass active and reachable on the network, with a startup banner |

The last row means anyone who can reach the port controls the agent — and the
agent has your Gmail, Calendar and shell. Use it only on a network you trust,
and only until Access is configured.

Once Access is the only gate, `BFF_BIND` defaults to `127.0.0.1` — the tunnel
reaches the BFF over the internal Docker network (`app-server:8080`), not
through this published port, so there is no legitimate reason for it to be
reachable from the LAN any more. Override to `0.0.0.0` only if you deliberately
want a second, unauthenticated way in.

## Run

```bash
docker compose -f docker/compose.yml up --build
```

The BFF serves the built SPA at `PUBLIC_ORIGIN` (default
`http://localhost:8090`) and the app-server stays on loopback only. The image
builds `web/` in its own stage and the BFF serves it from `WEB_DIST`
(`web/dist`); API, auth and health routes are registered first, so the SPA
fallback cannot shadow them.

`PUBLIC_ORIGIN` should be the tunnel's `https://` hostname in production —
that's what marks the session cookie `Secure`, and it's the only supported
production entry point now that Cloudflare Access is the sole auth gate. Plain
LAN IP access (`http://192.168.1.4:8090`) still works for reaching
`DEV_BYPASS_EMAIL` locally, but is not a supported way to reach real users.

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

## Local development without Docker

```bash
# Terminal 1 — app-server on the host
LETTA_LOCAL_BACKEND_EXPERIMENTAL=true letta server --listen ws://127.0.0.1:4500

# Terminal 2 — BFF (dev bypass skips Cloudflare Access entirely)
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
