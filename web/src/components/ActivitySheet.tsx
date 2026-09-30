import { useEffect, useMemo, useState } from "react";
import { type ActivityRow, activityRows } from "../lib/activity.ts";
import { parseScopeKey } from "../lib/protocol.ts";
import type { NamedConversation } from "../lib/tasks.ts";
import type { AgentsApi } from "../state/use-agents.ts";
import { readConversations } from "../state/use-agents.ts";
import type { SessionApi } from "../state/use-session.ts";
import { MenuRow } from "./MenuRow.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  session: SessionApi;
  agents: AgentsApi;
  onClose: () => void;
}

/**
 * Conversation titles for agents other than the open one, kept for the page
 * lifetime — NOT the sheet's own state. `use-agents` only ever holds the
 * selected agent's list, and `__bff_activity` frames arrive often: refetching
 * from a render path keyed on `activeScopes` identity would draw a
 * `conversation_list` request per frame. Same last-known-cache pattern as
 * `use-agent-stats`; a failed agent is simply absent, so its rows fall back to
 * the unlisted title and the next open retries.
 */
const titlesCache = new Map<string, readonly NamedConversation[]>();

/**
 * Every conversation with a response in progress, across agents, opened from
 * the pulsing status dot. Rows vanish live as turns finish; the sheet stays
 * open on an empty list rather than disappearing under the cursor.
 */
export function ActivitySheet({ session, agents, onClose }: Props) {
  const [fetched, setFetched] =
    useState<ReadonlyMap<string, readonly NamedConversation[]>>(titlesCache);

  // The agents whose titles are missing, as a stable string: the effect fires
  // on mount and when a scope for a new unknown agent appears, never on every
  // activity frame.
  const missing = useMemo(() => {
    const ids = new Set<string>();
    for (const key of session.activeScopes) {
      const [agentId] = parseScopeKey(key);
      if (agentId !== agents.agentId && !titlesCache.has(agentId)) ids.add(agentId);
    }
    return [...ids].sort().join(",");
  }, [session.activeScopes, agents.agentId]);

  useEffect(() => {
    if (!missing) return;
    let cancelled = false;
    void Promise.all(
      missing.split(",").map(async (id) => {
        try {
          const response = await session.request("conversation_list", {
            query: { agent_id: id, limit: 100 },
          });
          return [id, readConversations(response)] as const;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      for (const entry of results) if (entry) titlesCache.set(entry[0], entry[1]);
      if (!cancelled) setFetched(new Map(titlesCache));
    });
    return () => {
      cancelled = true;
    };
  }, [missing, session.request]);

  const conversationsByAgent = useMemo(() => {
    const map = new Map<string, readonly NamedConversation[]>(fetched);
    if (agents.agentId) map.set(agents.agentId, agents.conversations);
    return map;
  }, [fetched, agents.agentId, agents.conversations]);

  const rows = activityRows(
    session.activeScopes,
    agents.agents,
    agents.agentId,
    agents.conversationId,
    conversationsByAgent,
  );

  const pick = (row: ActivityRow) => {
    if (row.isCurrent) {
      onClose();
      return;
    }
    // Same-handler sequence: `selectAgent` clears the conversation until its
    // list arrives, and `refreshConversations` keeps a selection that appears
    // in its fresh list — so the conversation set after it survives the switch.
    if (row.agentId !== agents.agentId) agents.selectAgent(row.agentId);
    agents.selectConversation(row.conversationId);
    onClose();
  };

  return (
    <Sheet title="Responding now" size="compact" onClose={onClose}>
      {rows.length === 0 ? (
        <p className="muted small activity-sheet-empty">Nothing is running.</p>
      ) : (
        <ul className="menu-list">
          {rows.map((row) =>
            row.kind === "default" ? (
              // Not listable, so not switchable — a note, like the sidebar's.
              <li
                key={`${row.agentId}::${row.conversationId}`}
                className="activity-note small muted"
              >
                <span className="activity-dot" aria-hidden="true" />
                {row.agentName}: {row.title}
              </li>
            ) : (
              <MenuRow
                key={`${row.agentId}::${row.conversationId}`}
                title={
                  <>
                    <span className="activity-dot" aria-hidden="true" />
                    {row.title}
                  </>
                }
                description={row.agentName}
                mark="check"
                selected={row.isCurrent}
                onClick={() => pick(row)}
              />
            ),
          )}
        </ul>
      )}
    </Sheet>
  );
}
