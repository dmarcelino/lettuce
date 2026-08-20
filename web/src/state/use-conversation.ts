import { useCallback, useEffect, useRef, useState } from "react";
import { frameSeq, type RuntimeScope, type SequencedFrame } from "../lib/protocol.ts";
import {
  applyStreamDelta,
  settleStreaming,
  sortedEntries,
  transcriptFromHistory,
  type Transcript,
  type TranscriptEntry,
} from "../lib/messages.ts";
import type { SessionApi } from "./use-session.ts";

export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolCallId: string;
  blockedPath: string | null;
  suggestions: { id: string; text: string }[];
  diffs: unknown[];
}

export interface QueuedItem {
  id: string;
  source: string;
  content: string;
}

export interface ConversationApi {
  entries: TranscriptEntry[];
  processing: boolean;
  queue: QueuedItem[];
  approvals: PendingApproval[];
  loadingHistory: boolean;
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
  abort: () => void;
  respondToApproval: (requestId: string, approve: boolean, reason?: string) => void;
  removeQueued: (itemId: string) => void;
  runCommand: (commandId: string, args?: string) => void;
  reload: () => Promise<void>;
}

function readQueue(raw: unknown): QueuedItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as { id?: unknown; source?: unknown; content?: unknown };
    if (typeof entry.id !== "string") return [];
    const content = entry.content;
    return [
      {
        id: entry.id,
        source: typeof entry.source === "string" ? entry.source : "user",
        content: typeof content === "string" ? content : JSON.stringify(content ?? ""),
      },
    ];
  });
}

function readApproval(raw: unknown): PendingApproval | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as { request_id?: unknown; request?: unknown };
  if (typeof frame.request_id !== "string") return null;
  const request = frame.request as
    | {
        tool_name?: unknown;
        input?: unknown;
        tool_call_id?: unknown;
        blocked_path?: unknown;
        permission_suggestions?: unknown;
        diffs?: unknown;
      }
    | undefined;
  if (!request) return null;

  return {
    requestId: frame.request_id,
    toolName: typeof request.tool_name === "string" ? request.tool_name : "tool",
    input:
      request.input && typeof request.input === "object"
        ? (request.input as Record<string, unknown>)
        : {},
    toolCallId: typeof request.tool_call_id === "string" ? request.tool_call_id : "",
    blockedPath: typeof request.blocked_path === "string" ? request.blocked_path : null,
    suggestions: Array.isArray(request.permission_suggestions)
      ? request.permission_suggestions.flatMap((s) => {
          if (!s || typeof s !== "object") return [];
          const suggestion = s as { id?: unknown; text?: unknown };
          if (typeof suggestion.id !== "string" || typeof suggestion.text !== "string") return [];
          return [{ id: suggestion.id, text: suggestion.text }];
        })
      : [],
    diffs: Array.isArray(request.diffs) ? request.diffs : [],
  };
}

export function useConversation(
  session: SessionApi,
  agentId: string | null,
  conversationId: string | null,
): ConversationApi {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [processing, setProcessing] = useState(false);
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transcriptRef = useRef<Transcript>(new Map());
  const seqRef = useRef(0);
  const startedRef = useRef<string | null>(null);

  const scope: RuntimeScope | null =
    agentId && conversationId ? { agent_id: agentId, conversation_id: conversationId } : null;

  const flush = useCallback(() => {
    setEntries(sortedEntries(transcriptRef.current));
  }, []);

  const loadHistory = useCallback(async () => {
    if (!conversationId) return;
    setLoadingHistory(true);
    setError(null);
    try {
      const response = await session.request<{ messages?: unknown[] }>(
        "conversation_messages_list",
        { conversation_id: conversationId, query: { limit: 200 } },
      );
      const messages = Array.isArray(response?.messages) ? response.messages : [];
      transcriptRef.current = transcriptFromHistory(messages);
      seqRef.current = messages.length;
      flush();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingHistory(false);
    }
  }, [conversationId, session, flush]);

  // Start (or resume) the runtime for this conversation, then load its history.
  useEffect(() => {
    if (!session.ready || !scope) return;
    const key = `${scope.agent_id}::${scope.conversation_id}`;
    if (startedRef.current === key) return;
    startedRef.current = key;

    transcriptRef.current = new Map();
    seqRef.current = 0;
    setEntries([]);
    setQueue([]);
    setApprovals([]);

    session.setScopes([scope]);
    void (async () => {
      try {
        await session.request("runtime_start", {
          agent_id: scope.agent_id,
          conversation_id: scope.conversation_id,
          wait_for_replay: true,
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      await loadHistory();
    })();
  }, [session, scope?.agent_id, scope?.conversation_id, session.ready, loadHistory]);

  // A resync means the BFF buffer could not cover the gap while we were away.
  useEffect(() => session.onResync(() => void loadHistory()), [session, loadHistory]);

  useEffect(() => {
    return session.onFrame((frame: SequencedFrame) => {
      const type = (frame as { type?: unknown }).type;
      const runtime = (frame as { runtime?: RuntimeScope }).runtime;

      // Ignore traffic for other conversations sharing the app-server.
      if (runtime && scope && runtime.conversation_id !== scope.conversation_id) return;

      const seq = frameSeq(frame);
      if (seq !== null) seqRef.current = Math.max(seqRef.current, seq);

      switch (type) {
        case "stream_delta": {
          const delta = (frame as { delta?: unknown }).delta;
          const subagentId = (frame as { subagent_id?: unknown }).subagent_id;
          applyStreamDelta(
            transcriptRef.current,
            delta,
            seqRef.current,
            typeof subagentId === "string" ? subagentId : undefined,
          );
          flush();
          break;
        }
        case "turn_finished": {
          settleStreaming(transcriptRef.current);
          setProcessing(false);
          flush();
          break;
        }
        case "update_device_status": {
          const status = (frame as { device_status?: { is_processing?: unknown } }).device_status;
          setProcessing(status?.is_processing === true);
          break;
        }
        case "update_loop_status": {
          const loop = (frame as { loop_status?: unknown }).loop_status;
          setProcessing(loop !== "idle" && loop !== null && loop !== undefined);
          break;
        }
        case "update_queue": {
          setQueue(readQueue((frame as { queue?: unknown }).queue));
          break;
        }
        case "control_request": {
          const approval = readApproval(frame);
          if (approval) {
            setApprovals((current) =>
              current.some((a) => a.requestId === approval.requestId)
                ? current
                : [...current, approval],
            );
          }
          break;
        }
        default:
          break;
      }
    });
  }, [session, scope?.conversation_id, flush]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!scope || !text.trim()) return;
      setProcessing(true);
      try {
        session.send({
          type: "input",
          runtime: scope,
          payload: {
            kind: "create_message",
            messages: [
              {
                role: "user",
                content: text,
                client_message_id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              },
            ],
          },
        });
      } catch (cause) {
        setProcessing(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [scope, session],
  );

  const abort = useCallback(() => {
    if (!scope) return;
    session.send({ type: "abort_message", runtime: scope, request_id: `abort-${Date.now()}` });
  }, [scope, session]);

  const respondToApproval = useCallback(
    (requestId: string, approve: boolean, reason?: string) => {
      if (!scope) return;
      session.send({
        type: "input",
        runtime: scope,
        payload: {
          kind: "approval_response",
          request_id: requestId,
          decision: approve
            ? { behavior: "allow" }
            : { behavior: "deny", message: reason ?? "Denied from the web UI" },
        },
      });
      setApprovals((current) => current.filter((a) => a.requestId !== requestId));
    },
    [scope, session],
  );

  const removeQueued = useCallback(
    (itemId: string) => {
      if (!scope) return;
      session.send({
        type: "remove_queue_item",
        runtime: scope,
        request_id: `dequeue-${Date.now()}`,
        item_id: itemId,
      });
    },
    [scope, session],
  );

  const runCommand = useCallback(
    (commandId: string, args?: string) => {
      if (!scope) return;
      session.send({
        type: "execute_command",
        runtime: scope,
        request_id: `cmd-${Date.now()}`,
        command_id: commandId,
        ...(args ? { args } : {}),
      });
    },
    [scope, session],
  );

  return {
    entries,
    processing,
    queue,
    approvals,
    loadingHistory,
    error,
    sendMessage,
    abort,
    respondToApproval,
    removeQueued,
    runCommand,
    reload: loadHistory,
  };
}
