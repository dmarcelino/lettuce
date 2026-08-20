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

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
}

export interface QueuedItem {
  id: string;
  source: string;
  content: string;
}

export interface ConversationApi {
  entries: TranscriptEntry[];
  processing: boolean;
  /** Working directory of this runtime, from device status. */
  cwd: string | null;
  /** Skills the runtime currently has loaded, from device status. */
  skills: SkillSummary[];
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
  // Individually stable; depending on the whole session object would re-fire
  // these effects on every link-state change.
  const { request, send, setScopes, onFrame, onResync, ready } = session;

  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [processing, setProcessing] = useState(false);
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);

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
      const response = await request<{ messages?: unknown[] }>(
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
  }, [conversationId, request, flush]);

  // Start (or resume) the runtime for this conversation, then load its history.
  useEffect(() => {
    if (!ready || !scope) return;
    const key = `${scope.agent_id}::${scope.conversation_id}`;
    if (startedRef.current === key) return;
    startedRef.current = key;

    transcriptRef.current = new Map();
    seqRef.current = 0;
    setEntries([]);
    setQueue([]);
    setApprovals([]);

    setScopes([scope]);
    void (async () => {
      try {
        await request("runtime_start", {
          agent_id: scope.agent_id,
          conversation_id: scope.conversation_id,
          wait_for_replay: true,
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      await loadHistory();
    })();
  }, [ready, scope?.agent_id, scope?.conversation_id, request, setScopes, loadHistory]);

  // A resync means the BFF buffer could not cover the gap while we were away.
  useEffect(() => onResync(() => void loadHistory()), [onResync, loadHistory]);

  useEffect(() => {
    return onFrame((frame: SequencedFrame) => {
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
          const status = (frame as {
            device_status?: {
              is_processing?: unknown;
              current_working_directory?: unknown;
              current_available_skills?: unknown;
            };
          }).device_status;
          setProcessing(status?.is_processing === true);
          if (typeof status?.current_working_directory === "string") {
            setCwd(status.current_working_directory);
          }
          if (Array.isArray(status?.current_available_skills)) {
            setSkills(status.current_available_skills as SkillSummary[]);
          }
          break;
        }
        case "update_loop_status": {
          // LoopState is an object and has no "idle" member; the terminal state
          // is WAITING_ON_INPUT. Comparing the object to a string left the
          // composer permanently stuck showing "stop".
          const loop = (frame as { loop_status?: { status?: unknown } }).loop_status;
          const loopStatus = loop?.status;
          setProcessing(
            typeof loopStatus === "string" && loopStatus !== "WAITING_ON_INPUT",
          );
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
  }, [onFrame, scope?.conversation_id, flush]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!scope || !text.trim()) return;
      setProcessing(true);
      try {
        send({
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
    [scope, send],
  );

  const abort = useCallback(() => {
    if (!scope) return;
    send({ type: "abort_message", runtime: scope, request_id: `abort-${Date.now()}` });
  }, [scope, send]);

  const respondToApproval = useCallback(
    (requestId: string, approve: boolean, reason?: string) => {
      if (!scope) return;
      send({
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
    [scope, send],
  );

  const removeQueued = useCallback(
    (itemId: string) => {
      if (!scope) return;
      send({
        type: "remove_queue_item",
        runtime: scope,
        request_id: `dequeue-${Date.now()}`,
        item_id: itemId,
      });
    },
    [scope, send],
  );

  const runCommand = useCallback(
    (commandId: string, args?: string) => {
      if (!scope) return;
      send({
        type: "execute_command",
        runtime: scope,
        request_id: `cmd-${Date.now()}`,
        command_id: commandId,
        ...(args ? { args } : {}),
      });
    },
    [scope, send],
  );

  return {
    entries,
    processing,
    cwd,
    skills,
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
