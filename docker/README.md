# Running the stack

Everything here builds from **this repo alone**. The sibling `letta-code/` checkout
(a plain upstream clone) is dev tooling (drift reporting via `bun run sync-upstream`), not a build input:
the app-server and channel-gateway images come from upstream's published
`letta/letta:<version>`, and the UI consumes `@letta-ai/letta-code` from npm. A
host needs only `git` and `docker`.

## One-time setup

There is no allowlist file to create: the allowlist is the `ALLOWED_USERS`
environment variable, and in local mode `DEV_BYPASS_EMAIL` implies its own entry
(see Authentication below), so local dev needs nothing here at all.

```bash
cat > docker/.env <<'ENV'
PUBLIC_ORIGIN=http://localhost:8090
SESSION_SECRET=<openssl rand -hex 32>
# Pin the state root explicitly. The default is relative to this file, so
# running compose from a git worktree would otherwise point the stack at a
# DIFFERENT state directory than the main checkout does.
LETTA_STATE_DIR=/absolute/path/to/your/state/dir
# To actually sign in locally, also set all three (see Authentication below):
# DEV_BYPASS_EMAIL=you@example.com
# DEV_BYPASS_ALLOW_REMOTE=true   # required under Docker, even for localhost
# BFF_BIND=127.0.0.1             # keeps the published port off the LAN
ENV
```

## Where state lives

`LETTA_STATE_DIR` anchors every durable bind mount. It defaults to `../..`
relative to `docker/compose.yml`, which reproduces the original layout
alongside the two repos; prod sets an absolute path.

```
$LETTA_STATE_DIR/
  letta-home/     -> /root/.letta   settings.json, mcp-home/ (shared MCP list), global skills
  letta-data/     -> /data          conversations + agent memory (memfs git repos)
  workspaces/     -> /work          agent working directories
```

Back up that one directory and you have everything. The only named volume left
is `bff-data` (web-push device endpoints); losing it just means re-subscribing
from Settings → Notifications.

Docker creates missing bind sources as root, which is correct here — the
app-server runs as uid 0 — so a first boot on a clean host needs no `mkdir`.

Migrating an existing install that still uses the old `letta-home` /
`letta-data` named volumes:

```bash
docker compose -f docker/compose.yml down
bun run migrate-state          # copies, verifies, deletes nothing
docker compose -f docker/compose.yml up -d
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

`DEV_BYPASS_EMAIL` is the whole configuration — it implies its own allowlist
entry, so `ALLOWED_USERS` is not needed here. (Set both and they must agree;
if they name different people, sign-in is refused.)

Because that is easy to leave on by accident, exposing it beyond the local
machine takes a second, deliberate flag:

| Configuration | Result |
|---|---|
| `DEV_BYPASS_EMAIL` unset | Nobody can sign in (safe default, but unusable until set) |
| Set, loopback `PUBLIC_ORIGIN` | Bypass active, BFF bound to `127.0.0.1` — **unreachable under Docker**, see below |
| Set, non-loopback `PUBLIC_ORIGIN` (e.g. a LAN IP) | **Refuses to start** |
| Set, plus `DEV_BYPASS_ALLOW_REMOTE=true` | Bypass active and bound to all interfaces, with a startup banner |

**Under Docker, `DEV_BYPASS_ALLOW_REMOTE=true` is required even for localhost.**
The `127.0.0.1` bind in the second row happens *inside* the container, and a
published port forwards to the container's network interface, never to its
loopback — so the stack boots, logs "Bound to 127.0.0.1 only", and every
request to `BFF_PORT` is reset, from the host included. That bind is a real
boundary only when the BFF runs directly on the host (see Local development
without Docker). Under Docker the boundary is `BFF_BIND`, which decides where
the published port listens on the host:

| Goal | Set in `docker/.env` |
|---|---|
| This machine only | `DEV_BYPASS_EMAIL`, `DEV_BYPASS_ALLOW_REMOTE=true`, `BFF_BIND=127.0.0.1`, loopback `PUBLIC_ORIGIN` |
| Phones and other devices on the LAN | `DEV_BYPASS_EMAIL`, `DEV_BYPASS_ALLOW_REMOTE=true`, `PUBLIC_ORIGIN` at the machine's LAN IP (e.g. `http://192.168.1.4:8090`) |

In the first row the startup banner still says the bypass is exposed on the
network; with `BFF_BIND=127.0.0.1` that network is the container's, not yours.
The second row means anyone who can reach the port controls the agent — and
the agent has your Gmail, Calendar and shell — so use it only on a network you
trust.

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
   email address(es) as the app's own `ALLOWED_USERS` — **these two lists are
   not kept in sync automatically**; update both by hand when adding or removing
   a user.
5. Copy the Application's **Audience (AUD) tag** into `docker/.env` as
   `CF_ACCESS_AUD`, and the team domain (the `<team>` in
   `<team>.cloudflareaccess.com`) as `CF_ACCESS_TEAM_DOMAIN`.
6. **Optional — only if the PWA will not install:** add a second
   **self-hosted application** for the same hostname whose path is the PWA
   static files, with a single policy of action **Bypass** / Include
   **Everyone** — a path-scoped app is matched before the catch-all one. A
   browser that fetches `manifest.webmanifest` or the manifest icons *without*
   the Access cookie gets the login page back and decides the app is not
   installable (no install button, only a plain shortcut). `index.html` sets
   `crossorigin="use-credentials"` on the manifest link, and current desktop
   Chrome installs without this step. The paths, all under `letta.<domain>`:
   `/manifest.webmanifest`, `/icon-192.png`, `/icon-512.png`,
   `/icon-maskable-512.png` — public metadata and three icons, nothing private.

   Push notifications do **not** need a Bypass. The service worker registers
   as a *classic* script (`web/src/lib/register-sw.ts`), whose fetch carries
   the Access cookie. Registered as a *module* it did not: Chrome sends no
   cookies with a module worker's script request, Access redirected it, and
   registration failed with "The script resource is behind a redirect".

Also update, in `docker/.env`:
- `PUBLIC_ORIGIN=https://<your-tunnel-hostname>` — the `https://` is what
  marks the session cookie `Secure`.
- `BFF_BIND=127.0.0.1` — Compose can't derive this from `COMPOSE_PROFILES`'s
  value, so it's a manual pairing. Once Access is the gate, the tunnel
  reaches the BFF over the internal Docker network, not this published port,
  so there's no legitimate reason to leave it reachable on the LAN too.
- Unset `DEV_BYPASS_EMAIL`. On its own it stops the BFF from starting: an
  `https://` `PUBLIC_ORIGIN` is not loopback, and the safety check above runs
  in every mode. Adding `DEV_BYPASS_ALLOW_REMOTE=true` gets past that check and
  opens BOTH doors — anyone who reaches the BFF, including anyone Access lets
  through regardless of `ALLOWED_USERS`, can take a session as that user.

If the Zero Trust team is ever renamed, JWKS moves to the new team domain but
outstanding tokens may still carry the old one in `iss`. Set
`CF_ACCESS_ISSUER` to the *old* `https://<old-team>.cloudflareaccess.com`
during the transition, and remove it once every session has naturally
re-authenticated.

## Prod deployment (Dockhand or any compose manager)

The host needs `git` + `docker` and a clone of **this repo only** — no `bun`, no
letta-code checkout, no pre-built images pushed to a registry. Point the manager at
`docker/compose.yml` and give it this stack environment:

| Variable | Value |
|---|---|
| `COMPOSE_PROFILES` | `cloudflared,google,search` (drop `google` / `search` to skip those sidecars) |
| `LETTA_STATE_DIR` | `/srv/letta` (absolute) |
| `PUBLIC_ORIGIN` | `https://<your-hostname>` |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `ALLOWED_USERS` | `you@example.com` |
| `CF_ACCESS_TEAM_DOMAIN` | team slug only, e.g. `acme` |
| `CF_ACCESS_AUD` | Access application Audience tag |
| `CLOUDFLARE_TUNNEL_TOKEN` | tunnel token from Zero Trust |
| `LETTA_CODE_VERSION` | must match the tracked pin — `bun run check-version-pin` |
| `BFF_BIND` | `127.0.0.1` |

Optional: the three `PUSH_VAPID_*` values, `BFF_PORT`, `SESSION_TTL_SECONDS`,
`FRAME_BUFFER_SIZE`, and `CF_ACCESS_ISSUER` (only during a team rename).

## Web apps agents serve

An agent that builds a web app runs it inside the app-server container. Only ports
**3000-3099** are published from there, on `AGENT_APPS_BIND` (default `0.0.0.0`), so
`http://<server>:3000` from another machine reaches whatever an agent serves on port 3000.

| Variable | Set it to |
|---|---|
| `AGENT_APP_HOST` | the address people open apps on — e.g. the server's LAN IP `172.31.0.102`. Agents put it in the URLs they give you; unset, they ask you to fill it in. |
| `AGENT_APPS_BIND` | optional; `0.0.0.0` (default) publishes on every interface. Use the LAN IP to keep it off other interfaces, or `127.0.0.1` to close it. |

Agents learn the rules from a global skill shipped in this repo,
[`agent-skills/serving-web-apps`](agent-skills/serving-web-apps/SKILL.md). It travels in
the bff image and the BFF writes it into `/root/.letta/skills/` on every connect to the
app-server (so a `bff` deploy is enough to update it). Its description in every agent's
skill list says to load it before starting a server, and it says to bind `0.0.0.0`, pick a
port in the range, run detached with a log, and hand out `http://$AGENT_APP_HOST:<port>`.
It is not a bind mount on purpose: under Dockhand, compose runs inside Dockhand's own
container, so a relative mount source does not exist on the host and Docker silently
mounts an empty directory instead.

These apps have **no authentication** and **do not survive an app-server restart** — the
processes live in that container. Changing the range or `AGENT_APPS_BIND` recreates
`app-server`: run `docker compose -f docker/compose.yml up -d` unscoped.

**Leave `DEV_BYPASS_EMAIL` and `DEV_BYPASS_ALLOW_REMOTE` unset.** Together they
open a second door that bypasses Cloudflare Access and `ALLOWED_USERS`
completely. Separately, `DEV_BYPASS_EMAIL` refuses to start on an `https://`
origin and `DEV_BYPASS_ALLOW_REMOTE` does nothing — neither belongs in prod.

`ALLOWED_USERS` is a comma-separated list of addresses:

```
ALLOWED_USERS=a@example.com, b@example.com
```

It is the only source of the allowlist — prod places no files on disk at all —
and it is **required** in cloudflared mode. Keep it in sync with the Cloudflare
Access policy by hand: **the two lists are unrelated**. Access is the gate that
actually matters, and this one is what still stands if that policy is ever
misconfigured, so it deliberately mirrors the policy's list shape rather than
collapsing to a single address.

## Web search and other MCP servers

Settings → MCP holds **one list shared by every agent**. Agents learn it from the `mcp-servers`
global skill the BFF generates, and call it with
`sh /root/.letta/skills/mcp-servers/scripts/mcp.sh <list|tools|search|schema|call> …`. The list
itself is `/root/.letta/mcp-home/.letta/settings.json`, not upstream's `settings.json` (CLAUDE.md
explains why).

A fresh install starts with an empty list.

### Web search: native `web_search` and `fetch_webpage`

Every agent gets two native tools — no MCP, no skill — from a letta-code mod the BFF installs in
the app-server (`/root/.letta/mods/letta-ui-web-tools.mjs`). Searches go to the `searxng`
service, falling back to `ddg-mcp`; pages are read through `ddg-mcp`. Neither publishes a port.
Settings → Web has the switch, the backend status and a test search.

Both sidecars sit behind the **`search`** compose profile: add it to `COMPOSE_PROFILES`
(e.g. `cloudflared,google,search`). Without it the tools are still registered and every call
fails with the backend's error, so switch them off in Settings → Web. Removing the profile
leaves running containers alone — `docker compose -f docker/compose.yml --profile search rm -sf
searxng ddg-mcp`.

| Variable (`docker/.env`) | Default | |
|---|---|---|
| `SEARXNG_VERSION` | `2026.9.23-3cd69d30e` | `searxng/searxng` image tag; pinned |
| `SEARXNG_URL` | `http://searxng:8080` | on the bff; empty switches SearXNG off |
| `DDG_MCP_VERSION` | `0.7.0` | `duckduckgo-mcp-server` release; pinned |
| `DDG_REGION` | `us-en` | results region |
| `DDG_SAFE_SEARCH` | `OFF` | `STRICT`, `MODERATE` or `OFF` |
| `DDG_MCP_URL` | `http://ddg-mcp:8000/mcp` | on the bff; empty switches page reading and the fallback off |

SearXNG's engines and settings are baked into its image from `docker/searxng/settings.yml`, which
records which engines answer from a home IP. To check the tools end to end from the host, the
route the mod calls answers only inside the app-server's network namespace:

```bash
docker compose -f docker/compose.yml exec app-server \
  wget -qO- --post-data '{"query":"letta code"}' --header 'content-type: application/json' \
  http://127.0.0.1:8080/internal/web-tools/search
```

## Run

```bash
docker compose -f docker/compose.yml up -d --build
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

The gateway is **off by default**: `channel-gateway` sits behind the `telegram`
compose profile. Turn it on by adding the profile to `COMPOSE_PROFILES` in
`docker/.env` (or the Dockhand stack variables), keeping any profile already
there — e.g. `COMPOSE_PROFILES=cloudflared,telegram` — then
`docker compose -f docker/compose.yml up -d`. To turn it off again, remove the
profile and stop the container yourself; `up -d` leaves an existing one running:

```bash
docker compose -f docker/compose.yml --profile telegram rm -sf channel-gateway
```

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

## GitHub (WatchPR)

Agents' `WatchPR` tool watches a pull request through the GitHub CLI, which the
app-server image carries (pinned by `GH_VERSION`). Sign it in once; the login is
stored in `GH_CONFIG_DIR=/root/.letta/gh` on the state root, so it survives
recreates. Use a fine-grained token with read access to the repos you want
watched (pull requests, checks, commit statuses):

```bash
docker compose -f docker/compose.yml exec -T app-server \
  gh auth login --with-token < token.txt
docker compose -f docker/compose.yml exec app-server gh auth status
```

Every agent shell can read that token — the same reach as any other file under
`/root/.letta` (see the sandbox notes in CLAUDE.md).

## Google (Gmail, Calendar, Tasks)

Agents use one Google account through the `google-mcp` sidecar, at the levels
chosen in **Settings → Google** (e.g. Gmail read-only, Tasks and Calendar
read-write). Unlike the GitHub token above, this token is **not** readable by
agents: it and the levels live on the `google-policy` / `google-creds` volumes,
which only the BFF and the sidecar mount.

The sidecar sits behind the **`google`** compose profile: add it to `COMPOSE_PROFILES`
(e.g. `cloudflared,google,search`). Without it, leave Settings → Google disabled — the
shared-MCP-list entry follows that switch, not the container. Removing the profile leaves a
running container alone — `docker compose -f docker/compose.yml --profile google rm -sf
google-mcp`.

One-time Google Cloud setup (your own project, free):

1. Create a project at <https://console.cloud.google.com/> and enable the
   **Gmail API**, **Google Calendar API** and **Google Tasks API**.
2. **OAuth consent screen** (Google Auth Platform → Branding / Audience): user
   type **External**, then **Publish app** so the
   status reads **In production**. Leave it in *Testing* and Google expires
   the refresh token after 7 days. Verification is not needed for your own
   account; you click through an "unverified app" warning once per consent.
3. **Clients → Create client → Web application**, with the authorized redirect
   URI Settings → Google shows — by default
   `${PUBLIC_ORIGIN}/api/google/oauth/callback`. Google accepts only `https`
   or `localhost`, so a plain-http LAN origin cannot be used: set
   `GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8090/api/google/oauth/callback`
   in `docker/.env` and connect from a browser on the host (or through
   `ssh -L 8090:localhost:8090`).
4. In Settings → Google: paste the client ID and secret, choose the levels,
   tick **Allow agents to use Google**, **Save**, then **Connect Google**.

Changing a level down (or turning a service off) **revokes** the token, and
you connect again; changing one up keeps the old access until you reconnect.
Disconnect revokes it at Google too. You can always check or revoke access at
<https://myaccount.google.com/permissions>.

**Settings → Google is read-only in dev-bypass mode.** Agent shells share the
BFF's network namespace, so they could `curl 127.0.0.1:8080/auth/dev-login`
and change the levels themselves. Behind Cloudflare Access they cannot. For a
machine only you use, `GOOGLE_ALLOW_DEV_BYPASS=true` lifts the lock.

## Push notifications

Fully optional and self-gating — leave the three `PUSH_VAPID_*` variables
unset and the BFF runs with push disabled, no error. **All three are needed:**
with any one missing, push is off just as silently, so a typo in one name looks
exactly like "not configured".

A push fires only while no **visible** browser session has that conversation on
screen, for three events: a turn completed, a turn failed, and a tool approval
is needed. Each device opts in or out of each one under Settings →
Notifications; all three start on.

"Visible" is literal, and it has to be: a backgrounded desktop tab keeps its
WebSocket open for hours, so "still connected" was never evidence anyone was
looking — it suppressed every push, on every device, for as long as one tab
stayed open. The browser now reports both the conversation on screen and
`document.visibilityState` (`__bff_watching`), and that is the only input to the
check (`SessionRegistry.isScopeWatched`).

**Send a test notification** — Settings → Notifications, once subscribed —
delivers one to that device immediately, skipping both the watching check and
the per-event preferences. It is the way to tell "delivery is broken" apart from
"suppressed because you were watching".

The BFF logs one line per decision; `docker compose logs bff | grep Push`:

```
Push for turn_finished in <agent>::<conversation> suppressed: a visible session is watching it
Push (completed): sent to 2 of 2 device(s)
Push (completed): no device wants it (1 registered)
Push test: sent to https://fcm.googleapis.com/...
```

An agent cannot notify on demand — no tool does that, and the three events above
are the only triggers. To schedule a nudge, give it a cron task (Tasks tab): the
turn it fires finishes with nobody watching, which notifies.

Generate a VAPID keypair once:

```bash
cd bff && bunx web-push generate-vapid-keys
```

Put the public/private pair into `docker/.env` as `PUSH_VAPID_PUBLIC_KEY` /
`PUSH_VAPID_PRIVATE_KEY`, and set `PUSH_VAPID_CONTACT_EMAIL` to an address you
read. It becomes the VAPID `sub` claim, which push services use to contact you
if your server misbehaves. Give the bare address — the BFF adds `mailto:`
itself — and it need not be on `ALLOWED_USERS`; nothing checks it against that.

**Rotating these keys silently invalidates every existing subscription** —
every previously-subscribed device stops receiving pushes until it
re-subscribes from Settings → Notifications. There is no migration path;
this is an operational fact to plan around, not a bug.

Subscriptions persist in `push-subscriptions.json` on the `bff-data` named
volume, not on the host — losing it only means re-subscribing each device from
Settings → Notifications.

iOS only delivers Web Push to a PWA actually added to the Home Screen — a
Safari tab (or Chrome/Firefox on iOS, which can't install a PWA at all) never
receives it. The Notifications settings section shows an install prompt
instead of a toggle when it detects this.

If Settings → Notifications says **"Notifications are unavailable: …"**, the
service worker did not register or install, and the text after the colon is
the browser's own reason — DevTools → Application → Service Workers shows the
same. After deploying a UI change, a hard reload picks up the new bundle and
worker.

## Local development without Docker

```bash
# Terminal 1 — app-server on the host
LETTA_LOCAL_BACKEND_EXPERIMENTAL=true letta server --listen ws://127.0.0.1:4500

# Terminal 2 — BFF (dev bypass; local mode needs no CF_ACCESS_* vars, and no
# ALLOWED_USERS either — DEV_BYPASS_EMAIL implies its own allowlist entry)
cd bff && \
  LETTA_APP_SERVER_URL=ws://127.0.0.1:4500 \
  PUBLIC_ORIGIN=http://localhost:8080 \
  SESSION_SECRET=$(openssl rand -hex 32) \
  DEV_BYPASS_EMAIL=you@example.com \
  bun --watch src/index.ts

# Terminal 3 — Vite
cd web && bun run dev
```

The BFF sends no token: the app-server runs on loopback without `--ws-auth` by
design, because the channel gateway cannot authenticate (see the header comment
in `docker/compose.yml`).
