# ── Stage 1: install dependencies ────────────────────────────────────────────
FROM oven/bun:1.3 AS deps

WORKDIR /app

# Build context is this repo's root (see compose.yml). `@letta-ai/letta-code` is
# a pinned npm dependency rather than the sibling fork checkout, so nothing
# outside this repo is needed to build the image — which is what lets a prod
# host deploy with only `git` and `docker` installed.
COPY package.json     package.json
COPY bun.lock         bun.lock
COPY bff/package.json bff/package.json
COPY web/package.json web/package.json

# --ignore-scripts: letta-code is consumed for its protocol types and the
# app-server client only, and dist/app-server-client.js is a self-contained
# bundle with no bare imports. Its native dependencies (node-pty, sharp) are
# never loaded here and their postinstall builds would need a toolchain this
# image does not carry.
RUN bun install --frozen-lockfile --ignore-scripts

# ── Stage 2: build the SPA ───────────────────────────────────────────────────
FROM deps AS web-build

COPY tsconfig.base.json ./tsconfig.base.json
COPY web/src            ./web/src
COPY web/public         ./web/public
COPY web/index.html     ./web/index.html
COPY web/tsconfig.json  ./web/tsconfig.json
COPY web/vite.config.ts ./web/vite.config.ts

RUN cd web && bun run build

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM deps AS runtime

# The first apt use in this image. The Files tab's History reads the commit log
# here (bff/src/git/) — against the BFF's read-only /work mount — because
# upstream exposes only branch commands and the app-server image ships no git
# binary. Deliberately unpinned: pinning a Debian package version breaks on
# every base refresh, and the accepted residual risk is git's object parser
# running on agent-authored repositories inside this container, mitigated by
# the read-only mount, argv-only spawns, timeouts and output caps. Only `git`
# itself is needed; --no-install-recommends keeps perl manpages etc. out.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

COPY tsconfig.base.json ./tsconfig.base.json
COPY bff/src            ./bff/src
COPY bff/tsconfig.json  ./bff/tsconfig.json
# This build's release tag, served at /api/status and shown in Settings → About.
# A file rather than `git describe`: .dockerignore excludes .git, and the git
# install above must not become the reason this build could not be derived
# (see CLAUDE.md "Versioning and tags").
COPY VERSION            ./VERSION
# Skills the BFF installs into every agent's global skill directory on connect
# (bff/src/agent-skills.ts). In the image, not a bind mount: under Dockhand a
# relative mount source resolves inside Dockhand's container, not on the host.
COPY docker/agent-skills ./docker/agent-skills

# The BFF serves this build at / (see the static routes in bff/src/index.ts).
COPY --from=web-build /app/web/dist ./web/dist

ENV NODE_ENV=production
ENV WEB_DIST=web/dist
EXPOSE 8080
CMD ["bun", "bff/src/index.ts"]
