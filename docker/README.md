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

`DEV_BYPASS_EMAIL` skips sign-in entirely for local development. It
authenticates **nobody** — any request becomes the configured user — so the BFF
refuses to start when `PUBLIC_ORIGIN` is not loopback, and binds to `127.0.0.1`
whenever it is set. That makes it unusable through a published container port
by construction; it is for `bun run dev` only.

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
