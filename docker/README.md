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

The Google OAuth client needs `${PUBLIC_ORIGIN}/auth/google/callback` as an
authorized redirect URI.

## Run

```bash
docker compose -f docker/compose.yml up --build
```

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
