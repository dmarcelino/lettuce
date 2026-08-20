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
PUBLIC_ORIGIN=http://localhost:8080
SESSION_SECRET=<openssl rand -hex 32>
GOOGLE_CLIENT_ID=<from Google Cloud console>
GOOGLE_CLIENT_SECRET=<from Google Cloud console>
ENV

# 4. Build the fork so its dist/ (protocol types + client) exists.
cd ../letta-code && bun install && bun run build
```

## Authentication

The compose stack always uses real Google sign-in. Create an OAuth client at
<https://console.cloud.google.com/apis/credentials> → **Create credentials** →
**OAuth client ID** → **Web application**, and register exactly:

```
${PUBLIC_ORIGIN}/auth/google/callback
```

Then put the client id and secret in `docker/.env`. Only addresses listed in
`config/users.json` can sign in; everyone else gets a 403 after Google
authenticates them.

`DEV_BYPASS_EMAIL` skips sign-in entirely. It authenticates **nobody** — any
request that reaches the port becomes the configured user.

Because that is easy to leave switched on by accident, exposing it beyond the
local machine takes a second, deliberate flag:

| Configuration | Result |
|---|---|
| `DEV_BYPASS_EMAIL` unset | Real Google sign-in (required for the compose stack by default) |
| Set, loopback `PUBLIC_ORIGIN` | Bypass active, bound to `127.0.0.1` |
| Set, non-loopback `PUBLIC_ORIGIN` | **Refuses to start** |
| Set, plus `DEV_BYPASS_ALLOW_REMOTE=true` | Bypass active and reachable on the network, with a startup banner |

The last row means anyone who can reach the port controls the agent — and the
agent has your Gmail, Calendar and shell. Use it only on a network you trust,
and only until OAuth is configured.

## Run

```bash
docker compose -f docker/compose.yml up --build
```

The BFF serves the built SPA at `PUBLIC_ORIGIN` (default
`http://localhost:8090`) and the app-server stays on loopback only. The image
builds `web/` in its own stage and the BFF serves it from `WEB_DIST`
(`web/dist`); API, auth and health routes are registered first, so the SPA
fallback cannot shadow them.

Accessing it from another device on the LAN? Set `PUBLIC_ORIGIN` to that
address (e.g. `http://192.168.1.4:8090`) — it is what the Google OAuth
redirect URI is built from.

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

# Terminal 2 — BFF (dev bypass skips Google OAuth)
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
