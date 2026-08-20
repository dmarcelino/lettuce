FROM oven/bun:1.3

WORKDIR /app

# The BFF depends on letta-code via `file:../letta-code` for its protocol types,
# so both trees must be present at install time. Build context is the parent of
# both repos (see compose.yml).
COPY letta-code/package.json      letta-code/package.json
COPY letta-code/dist              letta-code/dist
COPY letta-code-ui/package.json   letta-code-ui/package.json
COPY letta-code-ui/bun.lock       letta-code-ui/bun.lock
COPY letta-code-ui/bff/package.json letta-code-ui/bff/package.json
COPY letta-code-ui/web/package.json letta-code-ui/web/package.json

WORKDIR /app/letta-code-ui
RUN bun install --frozen-lockfile

COPY letta-code-ui/bff ./bff
COPY letta-code-ui/tsconfig.base.json ./tsconfig.base.json

ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "bff/src/index.ts"]
