# The app-server image: upstream's letta/letta, unmodified, plus the Codex CLI
# that letta-code's `codex` subagent workers run. Build context is this
# directory only (see compose.yml), so nothing else from the repo — least of
# all docker/.env — ever reaches the daemon.
ARG LETTA_CODE_VERSION
FROM letta/letta:${LETTA_CODE_VERSION}

# The real CLI stays off PATH; `codex` on PATH is the shim (codex-shim.mjs).
ARG CODEX_VERSION
RUN npm install --global --prefix /opt/codex "@openai/codex@${CODEX_VERSION}" \
    && /opt/codex/bin/codex --version

COPY shim-core.mjs codex-shim.mjs /opt/codex-shim/
RUN chmod 755 /opt/codex-shim/codex-shim.mjs \
    && ln -s /opt/codex-shim/codex-shim.mjs /usr/local/bin/codex
