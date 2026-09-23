# The app-server image, plus the one package letta-code's filesystem sandbox
# needs and the upstream image does not ship.
#
# The base is upstream's OWN published image. That is not a shortcut around the
# fork — the fork's docker/Dockerfile never compiles fork source in the first
# place: it runs `npm install --global @letta-ai/letta-code@${VERSION}` and
# takes only docker/entrypoint.sh from its build context. Upstream's release CI
# publishes that same Dockerfile, same context and same build-arg as
# `letta/letta:<version>`, so pulling it is the identical recipe we used to
# build locally as `letta-app-server-base:<version>` — minus the two-step dance
# that existed only because Compose cannot express "build A, then FROM A".
#
# Consequence worth knowing: the whole stack now builds with plain
# `docker compose build`, and a prod host needs neither `bun` nor a checkout of
# the fork.
#
# Why bubblewrap: LETTA_FS_SANDBOX=1 is what confines an agent's shell commands,
# and letta-code's only Linux backend is bwrap (src/sandbox/availability.ts).
# Without it on PATH the gate degrades SILENTLY — it logs "sandbox backend
# unavailable" and runs every command unwrapped — so after any base image change
# re-verify that it is actually present and engaging, not just that the stack is
# green.
#
# Note that installing it is necessary but NOT sufficient: see `security_opt`
# and `cap_add` on the app-server service in compose.yml.
ARG LETTA_CODE_VERSION=0.32.19

FROM letta/letta:${LETTA_CODE_VERSION}

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends bubblewrap; \
    rm -rf /var/lib/apt/lists/*; \
    bwrap --version
