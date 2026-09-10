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
# A fresh prod host needs none of this — it starts empty and the compose file
# creates the directories on first boot.
#
# Usage: bun run migrate-state [<state-dir>]
#        (default state dir: the repo's parent's parent, matching compose.yml's
#         ${LETTA_STATE_DIR:-../..})
set -euo pipefail

UI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-${LETTA_STATE_DIR:-$(cd "$UI_ROOT/../.." && pwd)}}"
COMPOSE="docker compose -f $UI_ROOT/docker/compose.yml"

# Compose prefixes volumes with the project name, which compose.yml pins to
# `letta` (there is also an unused letta-code_* pair from an older project
# name — deliberately not touched).
VOLUMES=(letta_letta-home letta_letta-data)

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "Destination: $DEST"

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

  if [ -d "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
    fail "$dest already exists and is not empty. Refusing to overwrite it."
  fi

  say "Copying $volume -> $dest"
  mkdir -p "$dest"
  # -a preserves ownership, timestamps and symlinks; /src/. copies the contents
  # rather than nesting the directory itself.
  docker run --rm \
    -v "$volume:/src:ro" \
    -v "$dest:/dst" \
    alpine sh -c 'cp -a /src/. /dst/'

  src_count="$(docker run --rm -v "$volume:/src:ro" alpine sh -c 'find /src -type f | wc -l')"
  dst_count="$(find "$dest" -type f | wc -l)"
  if [ "$src_count" -ne "$dst_count" ]; then
    fail "File count mismatch for $volume: volume=$src_count host=$dst_count"
  fi
  echo "  $dst_count files, counts match"
done

# ── 3. Verify the part that actually matters ─────────────────────────────────
# A file count proves bytes moved; it does not prove the memory repos are still
# valid git. Check that directly.
say "Verifying agent memory repos"
memfs="$DEST/letta-data/local-backend/memfs"
if [ ! -d "$memfs" ]; then
  warn "  no memfs directory at $memfs — nothing to verify (new install?)"
else
  found=0
  for repo in "$memfs"/*/memory; do
    [ -d "$repo/.git" ] || continue
    found=$((found + 1))
    if git -C "$repo" log -1 --format='  %h %s' 2>/dev/null; then
      echo "    ^ $(basename "$(dirname "$repo")")"
    else
      fail "git log failed in $repo — DO NOT delete the source volumes."
    fi
  done
  [ "$found" -eq 0 ] && warn "  no memory repos found under $memfs"
fi

say "Done. The named volumes were NOT deleted."
echo "Bring the stack up and confirm agents, history and MCP servers all look right:"
echo "  docker compose -f docker/compose.yml up -d"
echo
echo "Only once you are satisfied, reclaim the old volumes by hand:"
for volume in "${VOLUMES[@]}"; do
  echo "  docker volume rm $volume"
done
