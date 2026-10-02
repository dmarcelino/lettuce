#!/usr/bin/env bash
#
# One-shot: move letta-home and letta-data out of Docker named volumes and into
# host directories under $LETTA_STATE_DIR.
#
# This exists because agent memory is the only copy of itself. The memfs repos
# under letta-data/local-backend/memfs/<agent-id>/memory are git repositories
# whose history IS the provenance of everything the agent has learned; there is
# no backup and no way to reconstruct them. So this script COPIES, verifies, and
# never deletes: the named volumes are left exactly as they were, and the
# command to remove them is printed for you to run by hand once you are sure.
#
# Everything it copies is written by a container running as root, so the result
# is a root-owned tree the invoking user cannot fully traverse. Every check
# below therefore runs INSIDE a container rather than on the host — an earlier
# version counted files with host `find` and died on "Permission denied".
#
# A fresh prod host needs none of this — it starts empty and the compose file
# creates the directories on first boot.
#
# Usage: bun run migrate-state [<state-dir>]
set -euo pipefail

UI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$UI_ROOT/docker/compose.yml"
ENV_FILE="$UI_ROOT/docker/.env"
COMPOSE="docker compose -f $COMPOSE_FILE"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ── Resolve the destination exactly the way Compose would ────────────────────
# Compose resolves a relative bind source against the COMPOSE FILE's directory,
# not the repo root — so its `../..` default is $UI_ROOT/.., one level up from
# what a naive $UI_ROOT/../.. would give. Getting this wrong silently migrates
# into the wrong directory, which is how the first run of this script created a
# stray `letta-home` beside the repo.
env_value() { [ -f "$ENV_FILE" ] && sed -nE "s/^$1=(.*)$/\1/p" "$ENV_FILE" | tail -1; }

DEST="${1:-${LETTA_STATE_DIR:-$(env_value LETTA_STATE_DIR)}}"
DEST="${DEST:-$(cd "$UI_ROOT/.." && pwd)}"
case "$DEST" in
  /*) ;;
  *) DEST="$(cd "$UI_ROOT/docker/$DEST" && pwd)" ;;
esac

# The letta image carries git, and the stack already runs it, so verification
# needs no extra pull. Version comes from the same places Compose reads it.
VERSION="${LETTA_CODE_VERSION:-$(env_value LETTA_CODE_VERSION)}"
VERSION="${VERSION:-$(sed -nE 's/.*LETTA_CODE_VERSION:-([0-9][^}]*)\}.*/\1/p' "$COMPOSE_FILE" | head -1)}"
GIT_IMAGE="letta/letta:$VERSION"

# Compose prefixes volumes with the project name. This one-shot was written for
# installs that ran under the `letta` project name (compose.yml now says
# `lettuce`), which is why the names below are hard-coded: they are the volumes
# that hold the state being migrated, not today's project prefix. (There is also
# an unused letta-code_* pair from an even older project name — deliberately not
# touched.)
VOLUMES=(letta_letta-home letta_letta-data)

say "Destination: $DEST"
echo "  (verifying with $GIT_IMAGE)"

# ── 1. Refuse to race a running stack ────────────────────────────────────────
# Copying /data out from under a live app-server would capture a torn mid-write
# state — including a half-written git index in a memfs repo.
if [ -n "$($COMPOSE ps -q 2>/dev/null)" ]; then
  fail "The stack is running. Stop it first:  docker compose -f docker/compose.yml down"
fi

# ── 2. Copy each volume ──────────────────────────────────────────────────────
for volume in "${VOLUMES[@]}"; do
  target="${volume#letta_}"          # letta_letta-home -> letta-home
  dest="$DEST/$target"

  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    warn "  skip $volume — no such volume (already migrated?)"
    continue
  fi

  # Emptiness is checked in a container: a partially-migrated root-owned tree
  # is exactly the case the host cannot read.
  if docker run --rm -v "$DEST:/dst" alpine \
       sh -c "[ -d /dst/$target ] && [ -n \"\$(ls -A /dst/$target 2>/dev/null)\" ]"; then
    fail "$dest already exists and is not empty. Refusing to overwrite it."
  fi

  say "Copying $volume -> $dest"
  # -a preserves ownership, timestamps and symlinks; /src/. copies the contents
  # rather than nesting the directory itself.
  docker run --rm \
    -v "$volume:/src:ro" \
    -v "$DEST:/dst" \
    alpine sh -c "mkdir -p /dst/$target && cp -a /src/. /dst/$target/"

  src_count="$(docker run --rm -v "$volume:/src:ro" alpine sh -c 'find /src -type f | wc -l')"
  dst_count="$(docker run --rm -v "$DEST:/dst" alpine sh -c "find /dst/$target -type f | wc -l")"
  if [ "$src_count" -ne "$dst_count" ]; then
    fail "File count mismatch for $volume: volume=$src_count host=$dst_count"
  fi
  echo "  $dst_count files, counts match"
done

# ── 3. Verify the part that actually matters ─────────────────────────────────
# A file count proves bytes moved; it does not prove the memory repos are still
# valid git. Check that directly, in a container so root ownership is a non-issue.
say "Verifying agent memory repos"
docker run --rm -v "$DEST:/dst" --entrypoint sh "$GIT_IMAGE" -c '
  memfs=/dst/letta-data/local-backend/memfs
  [ -d "$memfs" ] || { echo "  no memfs directory — nothing to verify (new install?)"; exit 0; }
  found=0
  for repo in "$memfs"/*/memory; do
    [ -d "$repo/.git" ] || continue
    found=$((found + 1))
    agent=$(basename "$(dirname "$repo")")

    # An agent that has never written memory has an initialized repo with no
    # commits. `git log` fails there, but the repo is perfectly valid — treat it
    # as such, or the migration reports corruption that is not there.
    if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
      echo "  FAIL $agent: not a valid git repository"; exit 1
    fi
    if line=$(git -C "$repo" log -1 --format="%h %s" 2>/dev/null); then
      echo "  ok    $agent  $line"
    else
      echo "  empty $agent  (valid repo, no commits — agent never wrote memory)"
    fi
  done
  [ "$found" -eq 0 ] && echo "  no memory repos found under $memfs"
  echo "  $found repo(s) verified"
' || fail "A memory repo failed verification — DO NOT delete the source volumes."

say "Done. The named volumes were NOT deleted."
echo "Bring the stack up and confirm agents, history and MCP servers all look right:"
echo "  docker compose -f docker/compose.yml up -d"
echo
echo "Only once you are satisfied, reclaim the old volumes by hand:"
for volume in "${VOLUMES[@]}"; do
  echo "  docker volume rm $volume"
done
