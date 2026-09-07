# The app-server image, plus the one package letta-code's filesystem sandbox
# needs and the upstream image does not ship.
#
# This is a thin layer over the fork's OWN unmodified Dockerfile output, not a
# reimplementation of it: duplicating the runtime package list here would drift
# from upstream on every sync. `scripts/build-images.sh` builds that base first
# and tags it, because Compose cannot express "build A, then FROM A".
#
# Why bubblewrap: `runtime_start.workspace_sandbox` is what confines an agent's
# shell commands to its own directory, and letta-code's only Linux backend is
# bwrap (src/sandbox/availability.ts). Without it on PATH the probe returns no
# backend and runtime_start rejects the whole command.
#
# Note that installing it is necessary but NOT sufficient: the probe also runs
# a real `--unshare-user` mount, which Docker's default seccomp profile blocks.
# See `security_opt` on the app-server service in compose.yml.
ARG LETTA_CODE_VERSION=0.31.13

FROM letta-app-server-base:${LETTA_CODE_VERSION}

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends bubblewrap; \
    rm -rf /var/lib/apt/lists/*; \
    bwrap --version
