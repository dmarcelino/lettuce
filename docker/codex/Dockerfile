# The app-server image: upstream's letta/letta, unmodified, plus the Codex CLI
# that letta-code's `codex` subagent workers run and the GitHub CLI its
# `WatchPR` tool shells out to. Build context is this
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

# GitHub CLI for WatchPR (letta-code 0.33.3+ runs `gh api …`). The base image
# has no apt, gzip or git, so this is the release tarball, checked against the
# release's own checksum list and gunzipped with node's zlib.
ARG GH_VERSION
ARG TARGETARCH
RUN set -eu; \
    asset="gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    base="https://github.com/cli/cli/releases/download/v${GH_VERSION}"; \
    cd /tmp; \
    curl -fsSLO "$base/$asset"; \
    curl -fsSL "$base/gh_${GH_VERSION}_checksums.txt" | grep " $asset\$" | sha256sum -c -; \
    node -e 'process.stdin.pipe(require("zlib").createGunzip()).pipe(process.stdout)' < "$asset" \
      | tar -x -C /tmp; \
    install -m 755 "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh_*; \
    gh --version
