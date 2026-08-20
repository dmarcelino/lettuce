# ── Stage 1: install dependencies ────────────────────────────────────────────
FROM oven/bun:1.3 AS deps

WORKDIR /app

# The workspace depends on letta-code via `file:../letta-code` for its protocol
# types, so both trees must be present at install time. Build context is the
# parent of both repos (see compose.yml).
COPY letta-code/package.json        letta-code/package.json
COPY letta-code/dist                letta-code/dist
COPY letta-code-ui/package.json     letta-code-ui/package.json
COPY letta-code-ui/bun.lock         letta-code-ui/bun.lock
COPY letta-code-ui/bff/package.json letta-code-ui/bff/package.json
COPY letta-code-ui/web/package.json letta-code-ui/web/package.json

WORKDIR /app/letta-code-ui
# --ignore-scripts: letta-code is consumed for its protocol types and the
# app-server client only. Its native dependencies (node-pty, sharp) are never
# loaded here and their postinstall builds would need a toolchain this image
# does not carry.
RUN bun install --frozen-lockfile --ignore-scripts

# ── Stage 2: build the SPA ───────────────────────────────────────────────────
FROM deps AS web-build

COPY letta-code-ui/tsconfig.base.json ./tsconfig.base.json
COPY letta-code-ui/web/src            ./web/src
COPY letta-code-ui/web/index.html     ./web/index.html
COPY letta-code-ui/web/tsconfig.json  ./web/tsconfig.json
COPY letta-code-ui/web/vite.config.ts ./web/vite.config.ts

RUN cd web && bun run build

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM deps AS runtime

COPY letta-code-ui/tsconfig.base.json ./tsconfig.base.json
COPY letta-code-ui/bff/src            ./bff/src
COPY letta-code-ui/bff/tsconfig.json  ./bff/tsconfig.json

# The BFF serves this build at / (see the static routes in bff/src/index.ts).
COPY --from=web-build /app/letta-code-ui/web/dist ./web/dist

ENV NODE_ENV=production
ENV WEB_DIST=web/dist
EXPOSE 8080
CMD ["bun", "bff/src/index.ts"]
