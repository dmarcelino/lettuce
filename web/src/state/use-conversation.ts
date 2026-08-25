import { useCallback, useEffect, useRef, useState } from "react";
import {
  addLocalUserMessage,
  applyStreamDelta,
  createStreamIndex,
  type StreamIndex,
  settleStreaming,
  sortedEntries,
  type Transcript,
  type TranscriptEntry,
  transcriptFromHistory,
} from "../lib/messages.ts";
import { frameSeq, type RuntimeScope, type SequencedFrame } from "../lib/protocol.ts";
import {
  agentWorkspace,
  isPermissionMode,
  type PermissionMode,
  readCommands,
  type SlashCommand,
  WORKSPACE_ROOT,
} from "../lib/workspace.ts";
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
  /** Live permission mode, from device status. Null until the first status frame. */
  permissionMode: PermissionMode | null;
  setPermissionMode: (mode: PermissionMode) => void;
  /** Slash commands this server advertises, built-ins plus mod-contributed. */
  commands: SlashCommand[];
  /** Null until a runtime starts; false when the kernel sandbox was unavailable. */
  sandboxed: boolean | null;
}

/**
 * Whether this stream delta is the successful end of a `/clear`.
 *
 * `execute_command_response` would be the obvious signal, but it carries only a
 * `request_id` — no command id — and awaiting it is not an option either: the
 * same frame type answers `/init` and `/doctor`, which run whole agent turns
 * and would outlive the client's request timeout. The lifecycle delta names the
 * command, so it is what we match on.
 */
function isClearCompleted(delta: unknown): boolean {
  if (!delta || typeof delta !== "object") return false;
  const message = delta as { message_type?: unknown; command_id?: unknown; success?: unknown };
  return (
    message.message_type === "slash_command_end" &&
    message.command_id === "clear" &&
    message.success !== false
  );
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
  /**
   * Fired when the agent reports that `/clear` completed. `/clear` does not
   * clear in place: the app-server creates a fresh conversation and re-points
   * its runtime at it, so the caller has to go and find it.
   */
  onConversationCleared?: () => void,
): ConversationApi {
  // Individually stable; depending on the whole session object would re-fire
  // these effects on every link-state change.
  const { request, send, setScopes, onFrame, onResync, ready } = session;

  // Held in a ref, not a dep: the frame subscription below must not re-run when
  // a caller passes a fresh closure, and re-subscribing per render is exactly
  // the unbounded loop `use-session.ts` documents.
  const clearedRef = useRef(onConversationCleared);
  clearedRef.current = onConversationCleared;

  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [processing, setProcessing] = useState(false);
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [permissionMode, setPermissionModeFromStatus] = useState<PermissionMode | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  /**
   * Whether the agent's own tools are confined to its workspace directory.
   * False means bubblewrap is missing on the app-server host: the browser is
   * still clamped by the BFF, but the agent itself can reach the whole
   * container filesystem through its tools.
   */
  const [sandboxed, setSandboxed] = useState<boolean | null>(null);

  const transcriptRef = useRef<Transcript>(new Map());
  // Alias maps that hold a streamed message together; reset wherever the
  // transcript is, so a stale otid can never bind to a rebuilt transcript.
  const streamIndexRef = useRef<StreamIndex>(createStreamIndex());
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
      const response = await request<{ messages?: unknown[] }>("conversation_messages_list", {
        conversation_id: conversationId,
        query: { limit: 200 },
      });
      const messages = Array.isArray(response?.messages) ? response.messages : [];
      transcriptRef.current = transcriptFromHistory(messages);
      streamIndexRef.current = createStreamIndex();
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
    streamIndexRef.current = createStreamIndex();
    seqRef.current = 0;
    setEntries([]);
    setQueue([]);
    setApprovals([]);

    setScopes([scope]);
    void (async () => {
      const home = agentWorkspace(scope.agent_id);
      try {
        // resolveWorkspaceSandbox refuses a root that does not exist, and no
        // mkdir command exists — but write_file does `mkdir -p` on the parent
        // before writing, so seeding a marker file is how the directory gets
        // created. Best effort: a failure here should not block the turn, it
        // just means the sandbox is declined below.
        await request("write_file", {
          path: `${home}/.keep`,
          content: "",
        }).catch(() => undefined);

        const base = {
          agent_id: scope.agent_id,
          conversation_id: scope.conversation_id,
          wait_for_replay: true,
          cwd: home,
        };

        // Ask for the kernel sandbox: root inside isolation_root means the
        // agent works in its own directory but can still reach the shared level
        // above it. It needs bubblewrap, and runtime_start REJECTS the whole
        // command when bwrap is missing rather than degrading — so an
        // unsandboxed retry is what keeps the conversation usable on a host
        // without it. `success: false` does not throw, so it is checked here.
        const sandboxed = await request<{ success?: boolean; error?: string }>("runtime_start", {
          ...base,
          workspace_sandbox: { root: home, isolation_root: WORKSPACE_ROOT },
        });

        if (sandboxed?.success === false) {
          setSandboxed(false);
          const retry = await request<{ success?: boolean; error?: string }>("runtime_start", base);
          if (retry?.success === false) {
            setError(retry.error ?? "Failed to start the runtime");
          }
        } else {
          setSandboxed(true);
        }
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
            streamIndexRef.current,
            delta,
            seqRef.current,
            typeof subagentId === "string" ? subagentId : undefined,
          );
          flush();
          // The one signal that /clear landed which actually reaches us. The
          // device status the app-server emits afterwards is scoped to the NEW
          // conversation, so the BFF's per-scope frame filter drops it for a
          // browser still subscribed to this one; this end marker carries the
          // scope captured before the runtime was re-pointed.
          if (isClearCompleted(delta)) clearedRef.current?.();
          break;
        }
        case "turn_finished": {
          settleStreaming(transcriptRef.current);
          setProcessing(false);
          flush();
          break;
        }
        case "update_device_status": {
          const status = (
            frame as {
              device_status?: {
                is_processing?: unknown;
                current_working_directory?: unknown;
                current_available_skills?: unknown;
                current_permission_mode?: unknown;
                supported_commands?: unknown;
                mod_commands?: unknown;
              };
            }
          ).device_status;
          setProcessing(status?.is_processing === true);
          if (typeof status?.current_working_directory === "string") {
            setCwd(status.current_working_directory);
          }
          if (Array.isArray(status?.current_available_skills)) {
            setSkills(status.current_available_skills as SkillSummary[]);
          }
          // `change_device_state` has no response frame; this is the only
          // acknowledgement a mode change ever gets, so the status frame is the
          // source of truth rather than optimistic local state.
          if (isPermissionMode(status?.current_permission_mode)) {
            setPermissionModeFromStatus(status.current_permission_mode);
          }
          // The command palette is advertised here, not enumerable on demand.
          if (Array.isArray(status?.supported_commands)) {
            setCommands(readCommands(status.supported_commands, status.mod_commands));
          }
          break;
        }
        case "update_loop_status": {
          // LoopState is an object and has no "idle" member; the terminal state
          // is WAITING_ON_INPUT. Comparing the object to a string left the
          // composer permanently stuck showing "stop".
          const loop = (frame as { loop_status?: { status?: unknown } }).loop_status;
          const loopStatus = loop?.status;
          setProcessing(typeof loopStatus === "string" && loopStatus !== "WAITING_ON_INPUT");
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
      const clientMessageId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Render it ourselves: the app-server echoes a user message back only
      // when it was queued behind a busy agent, so on the ordinary path no
      // frame ever arrives and the transcript would show the reply without the
      // question. The id doubles as the otid, so a queued echo merges into this
      // entry rather than duplicating it.
      seqRef.current += 1;
      addLocalUserMessage(
        transcriptRef.current,
        streamIndexRef.current,
        clientMessageId,
        text,
        seqRef.current,
      );
      flush();

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
                client_message_id: clientMessageId,
              },
            ],
          },
        });
      } catch (cause) {
        setProcessing(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [scope, send, flush],
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

  const setPermissionMode = useCallback(
    (mode: PermissionMode) => {
      if (!scope) return;
      // Fire-and-forget: there is no change_device_state_response. The mode we
      // display comes back on the next update_device_status frame, so nothing
      // is set optimistically here — a rejected change would otherwise leave
      // the button showing a mode the server never adopted.
      send({
        type: "change_device_state",
        runtime: scope,
        payload: { mode },
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
    permissionMode,
    setPermissionMode,
    commands,
    sandboxed,
  };
}
