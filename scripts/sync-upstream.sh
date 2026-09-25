#!/usr/bin/env bash
# Sync the letta-code fork from upstream and report protocol / behavioral drift.
#
# Usage: scripts/sync-upstream.sh [<upstream-ref>]     (default: upstream/main)
set -euo pipefail

UI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORK="${LETTA_CODE_DIR:-$(cd "$UI_ROOT/.." && pwd)/letta-code}"
REF="${1:-upstream/main}"

# Files whose *types* we consume — drift here is also caught by `bun run typecheck`.
PROTOCOL_FILES=(
  "src/types/protocol_v2.ts"
  "src/types/app-server-info.ts"
  "src/types/app-server-protocol.ts"
  "src/types/cwd-protocol.ts"
  "src/types/queue-update-protocol.ts"
  "src/types/conversation-fork-protocol.ts"
  "src/websocket/listener/listener-constants.ts"
)

# Files whose *behavior* we depend on but whose types will NOT catch a change.
# See CLAUDE.md — these are the invariants that keep chat alive across tab switches.
BEHAVIOR_FILES=(
  "src/websocket/listener/connection-lifecycle.ts"
  "src/websocket/listener/lifecycle.ts"
  "src/channels/gateway-supervisor.ts"
  "src/websocket/app-server.ts"
  "src/websocket/app-server-auth.ts"
  "src/websocket/listener/interrupts.ts"
  "src/websocket/listener/control-inputs.ts"
)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

cd "$FORK"

say "Fork: $FORK"

# ── 1. The zero-delta rule ────────────────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
  git status --short
  fail "Fork has local changes. The zero-delta rule is broken — see CLAUDE.md."
fi

CURRENT="$(git rev-parse HEAD)"
git fetch upstream --tags
TARGET="$(git rev-parse "$REF")"

if [[ "$CURRENT" == "$TARGET" ]]; then
  say "Already at $REF ($(git rev-parse --short HEAD)). Nothing to sync."
  exit 0
fi

say "Syncing $(git rev-parse --short "$CURRENT") -> $(git rev-parse --short "$TARGET") ($REF)"
git --no-pager log --oneline "$CURRENT".."$TARGET" | head -40 || true
echo "  ($(git rev-list --count "$CURRENT".."$TARGET") commits)"

# ── 2. Protocol drift ─────────────────────────────────────────────────────────
say "Protocol drift"
PROTO_CHANGED=0
for f in "${PROTOCOL_FILES[@]}"; do
  if ! git diff --quiet "$CURRENT" "$TARGET" -- "$f"; then
    PROTO_CHANGED=1
    printf '  changed: %s\n' "$f"
    # Message types added / removed, so the report is readable at a glance.
    git diff "$CURRENT" "$TARGET" -- "$f" \
      | grep -E '^[+-]  type: "' \
      | sed -E 's/^([+-])  type: "([^"]+)".*/    \1 \2/' \
      | sort -u -k2 || true
  fi
done
[[ $PROTO_CHANGED -eq 0 ]] && echo "  none"

OLD_VER="$(git show "$CURRENT:src/types/app-server-info.ts" | grep -oP 'APP_SERVER_PROTOCOL_VERSION = \K[0-9]+' || echo '?')"
NEW_VER="$(git show "$TARGET:src/types/app-server-info.ts"  | grep -oP 'APP_SERVER_PROTOCOL_VERSION = \K[0-9]+' || echo '?')"
if [[ "$OLD_VER" != "$NEW_VER" ]]; then
  warn "  APP_SERVER_PROTOCOL_VERSION: $OLD_VER -> $NEW_VER  (breaking — review the client)"
else
  echo "  APP_SERVER_PROTOCOL_VERSION: $NEW_VER (unchanged)"
fi

# ── 3. Behavioral drift (types will not catch these) ──────────────────────────
say "Behavioral drift — invariants types cannot check"
BEHAV_CHANGED=0
for f in "${BEHAVIOR_FILES[@]}"; do
  if ! git diff --quiet "$CURRENT" "$TARGET" -- "$f"; then
    BEHAV_CHANGED=1
    warn "  changed: $f  ($(git diff --shortstat "$CURRENT" "$TARGET" -- "$f" | xargs))"
  fi
done
if [[ $BEHAV_CHANGED -eq 1 ]]; then
  warn ""
  warn "  Re-verify by hand before trusting this sync:"
  warn "   * connection-lifecycle.ts — does closing the LAST subscribed connection still"
  warn "     cancel the turn? Our whole multiplexer design exists because of this."
  warn "   * lifecycle.ts — do process services (cron scheduler, channels) still start on"
  warn "     first client attach?"
  warn "   * gateway-supervisor.ts — did channels move to the spawned gateway? It has no"
  warn "     --ws-auth support and would break Telegram under capability-token auth."
  warn "   * app-server.ts / app-server-auth.ts — did the Origin / Bearer handling change?"
  warn "   * interrupts.ts — is a live tool_return_message still BOTH the singular fields and"
  warn "     a tool_returns[] array? web/src/lib/messages.ts reads both; protocol_v2.ts types"
  warn "     neither, so typecheck sees nothing."
  warn "   * control-inputs.ts — does handleAbortMessageInput still return false with no frames"
  warn "     when nothing is active, and still emit Interrupted before the turn unwinds?"
else
  echo "  none"
fi

# ── 4. Apply ──────────────────────────────────────────────────────────────────
say "Applying"
git merge --ff-only "$TARGET" || fail "Fast-forward failed — the fork has diverged from upstream."

if [[ -n "$(git status --porcelain)" ]]; then
  fail "Fork is dirty after merge. The zero-delta rule is broken."
fi
echo "  now at $(git rev-parse --short HEAD), delta still zero"

# ── 5. Re-pin to the new release ──────────────────────────────────────────────
# The fork is no longer a build input — the UI consumes @letta-ai/letta-code
# from npm and the images come from letta/letta on Docker Hub. So there is
# nothing to rebuild here; what has to move is the version literal.
VERSION="$(node -p "require('$FORK/package.json').version")"
say "Re-pinning to $VERSION"

# Both artifacts must actually exist, or the stack pins a version it cannot run.
npm view "@letta-ai/letta-code@$VERSION" version >/dev/null 2>&1 \
  || fail "npm has no @letta-ai/letta-code@$VERSION — sync to a published release tag."
docker manifest inspect "letta/letta:$VERSION" >/dev/null 2>&1 \
  || fail "Docker Hub has no letta/letta:$VERSION — sync to a published release tag."
echo "  published on npm and Docker Hub"

cd "$UI_ROOT"
# Every tracked home of the literal; check-version-pin.ts asserts the result.
sed -i -E "s|(\"@letta-ai/letta-code\": \")[^\"]+(\")|\1$VERSION\2|" \
  package.json bff/package.json web/package.json
sed -i -E "s|(LETTA_CODE_VERSION:-)[^}]+(\})|\1$VERSION\2|g" docker/compose.yml

bun install
bun scripts/check-version-pin.ts || fail "Version pins disagree after the bump."

say "Typechecking UI against the new protocol"
if bun run typecheck; then
  say "Sync complete. No typed protocol breakage."
  echo "  docker/.env is gitignored — update LETTA_CODE_VERSION there by hand if you set it."
  echo "  A version bump is a full rebuild: docker compose -f docker/compose.yml up -d --build"
else
  fail "Typecheck failed — the protocol changed under us. Fix the UI, do NOT patch the fork."
fi
