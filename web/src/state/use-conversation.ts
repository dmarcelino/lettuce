import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import {
  addLocalUserMessage,
  applyStreamDelta,
  clearLocalNotice,
  createStreamIndex,
  type StreamIndex,
  setLocalNotice,
  settleStreaming,
  sortedEntries,
  type Transcript,
  type TranscriptEntry,
  transcriptFromHistory,
} from "../lib/messages.ts";
import { frameSeq, type RuntimeScope, type SequencedFrame, scopeKey } from "../lib/protocol.ts";
import {
  agentWorkspace,
  isPermissionMode,
  type PermissionMode,
  readCommands,
  type SlashCommand,
} from "../lib/workspace.ts";
import type { SessionApi } from "./use-session.ts";

/**
 * Transcript id for the client's own line about a stop.
 *
 * Fixed, so pressing Stop twice replaces the note instead of stacking notes.
 */
const STOP_NOTICE_ID = "local-stop-notice";

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

export interface ToolsetSummary {
  id: string;
  label: string;
  description: string;
  featured: boolean;
}

export interface BackgroundProcessSummary {
  processId: string;
  kind: "bash" | "agent_task" | "monitor";
  label: string;
  status: string;
  /** Only monitors can be stopped from here — bash jobs and subagent tasks have no client-reachable stop command. */
  stoppable: boolean;
}

export interface QueuedItem {
  id: string;
  content: string;
  /** Parked by abort_message/Esc; needs resume_queue or a new message to drain. */
  paused: boolean;
}

export interface ConversationApi {
  entries: TranscriptEntry[];
  processing: boolean;
  /**
   * A stop was accepted upstream but the turn has not ended yet.
   *
   * Not the same as `!processing`: the app-server reports idle the instant it
   * accepts the abort, long before the turn actually unwinds. See `abort`.
   */
  stopping: boolean;
  /** Working directory of this runtime, from device status. */
  cwd: string | null;
  /** Skills the runtime currently has loaded, from device status. */
  skills: SkillSummary[];
  queue: QueuedItem[];
  approvals: PendingApproval[];
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  respondToApproval: (requestId: string, approve: boolean, reason?: string) => void;
  /**
   * `AskUserQuestion` gets no special protocol treatment — it arrives as an
   * ordinary `approval_request_message`, and plain allow/deny re-runs the
   * tool with its original `input`, which has no way to carry the user's
   * answers back in. `updated_input` is the generic escape hatch every
   * allow decision already supports (see `ApprovalResponseAllowDecision` in
   * the fork's protocol_v2.ts); the Telegram gateway answers this same tool
   * the same way (`channels/interactive.ts`, `buildAllowResponse` with
   * `updated_input: {...input, answers}}`).
   */
  answerQuestions: (
    requestId: string,
    input: Record<string, unknown>,
    answers: Record<string, string>,
  ) => void;
  removeQueued: (itemId: string) => void;
  /** Releases items parked by an interrupt so they start the next turn. */
  resumeQueue: () => void;
  runCommand: (commandId: string, args?: string) => void;
  /** True once a skill was enabled or disabled but no turn has rebuilt the list yet. */
  skillsStale: boolean;
  /** Live permission mode, from device status. Null until the first status frame. */
  permissionMode: PermissionMode | null;
  setPermissionMode: (mode: PermissionMode) => void;
  /** Slash commands this server advertises, built-ins plus mod-contributed. */
  commands: SlashCommand[];
  /** Preference driving the active toolset — "auto" or an explicit id. Null until the first status frame. */
  toolsetPreference: string | null;
  /** Toolsets this runtime can load, from device status. */
  availableToolsets: ToolsetSummary[];
  /** Bash jobs, subagent tasks and monitors currently running, from device status. */
  backgroundProcesses: BackgroundProcessSummary[];
  /** Stops a persistent monitor. No-op for bash/agent_task processes — see BackgroundProcessSummary.stoppable. */
  stopMonitor: (processId: string) => void;
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
    const entry = item as { id?: unknown; content?: unknown; paused?: unknown };
    if (typeof entry.id !== "string") return [];
    const content = entry.content;
    return [
      {
        id: entry.id,
        content: typeof content === "string" ? content : JSON.stringify(content ?? ""),
        paused: entry.paused === true,
      },
    ];
  });
}

function readToolsets(raw: unknown): ToolsetSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as {
      id?: unknown;
      label?: unknown;
      description?: unknown;
      is_featured?: unknown;
    };
    if (typeof entry.id !== "string") return [];
    return [
      {
        id: entry.id,
        label: typeof entry.label === "string" ? entry.label : entry.id,
        description: typeof entry.description === "string" ? entry.description : "",
        featured: entry.is_featured === true,
      },
    ];
  });
}

function readBackgroundProcesses(raw: unknown): BackgroundProcessSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as {
      process_id?: unknown;
      kind?: unknown;
      status?: unknown;
      command?: unknown;
      description?: unknown;
      task_type?: unknown;
    };
    if (typeof entry.process_id !== "string") return [];
    if (entry.kind !== "bash" && entry.kind !== "agent_task" && entry.kind !== "monitor") return [];
    const status = typeof entry.status === "string" ? entry.status : "unknown";
    const label =
      entry.kind === "bash"
        ? typeof entry.command === "string"
          ? entry.command
          : "(command)"
        : typeof entry.description === "string" && entry.description
          ? entry.description
          : typeof entry.task_type === "string"
            ? entry.task_type
            : entry.kind;
    return [
      {
        processId: entry.process_id,
        kind: entry.kind,
        label,
        status,
        stoppable: entry.kind === "monitor" && status === "running",
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
  const { request, send, setScopes, onFrame, onResync, ready, markResynced } = session;

  // Held in a ref, not a dep: the frame subscription below must not re-run when
  // a caller passes a fresh closure, and re-subscribing per render is exactly
  // the unbounded loop `use-session.ts` documents.
  const clearedRef = useRef(onConversationCleared);
  clearedRef.current = onConversationCleared;

  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [processing, setProcessing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsStale, setSkillsStale] = useState(false);
  /** Ids behind the last `skills` we accepted, to notice when a turn refreshed them. */
  const skillIdsRef = useRef("");
  const [permissionMode, setPermissionModeFromStatus] = useState<PermissionMode | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [toolsetPreference, setToolsetPreferenceFromStatus] = useState<string | null>(null);
  const [availableToolsets, setAvailableToolsets] = useState<ToolsetSummary[]>([]);
  const [backgroundProcesses, setBackgroundProcesses] = useState<BackgroundProcessSummary[]>([]);
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

  const loadHistory = useCallback(
    async (afterResync = false) => {
      if (!conversationId) return;
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
        // A request/response frame like this one never carries the sequence
        // number that would otherwise flip the link back to "live" on its
        // own — see session-client.ts's markResynced. Only relevant when this
        // reload was resync-triggered; an ordinary load has nothing to un-stick.
        if (afterResync) markResynced();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [conversationId, request, flush, markResynced],
  );

  // Start (or resume) the runtime for this conversation, then load its history.
  useEffect(() => {
    if (!ready || !scope) return;
    const key = scopeKey(scope);
    if (startedRef.current === key) return;
    startedRef.current = key;

    transcriptRef.current = new Map();
    streamIndexRef.current = createStreamIndex();
    seqRef.current = 0;
    setEntries([]);
    setQueue([]);
    setApprovals([]);
    setStopping(false);

    setScopes([scope]);
    void (async () => {
      const home = agentWorkspace(scope.agent_id);
      try {
        // `cwd` below refuses a directory that does not exist, and no mkdir
        // command exists — but write_file does `mkdir -p` on the parent before
        // writing, so seeding a marker file is how the directory gets created.
        // Best effort: a failure here should not block the turn.
        await request("write_file", {
          path: `${home}/.keep`,
          content: "",
        }).catch(() => undefined);

        // No `workspace_sandbox`. Agent shells are confined by the app-server's
        // LETTA_FS_SANDBOX cross-agent profile instead — see the long note in
        // docker/compose.yml for why. Briefly: workspace_sandbox is
        // write-scoped to a SINGLE root, which left the agent's own memfs
        // memory, /tmp and /root/.letta read-only, and it rode on the
        // per-conversation runtime, so cron- and Telegram-fired turns escaped
        // it entirely. `cwd` still points each runtime at its own directory —
        // that is now a convention, not a kernel boundary.
        const started = await request<{ success?: boolean; error?: string }>("runtime_start", {
          agent_id: scope.agent_id,
          conversation_id: scope.conversation_id,
          wait_for_replay: true,
          cwd: home,
        });

        // `success: false` does not throw, so it is checked here.
        if (started?.success === false) {
          setError(started.error ?? "Failed to start the runtime");
        }
      } catch (cause) {
        setError(errorMessage(cause));
      }
      await loadHistory();
    })();
  }, [ready, scope?.agent_id, scope?.conversation_id, request, setScopes, loadHistory]);

  // A resync means the BFF buffer could not cover the gap while we were away.
  useEffect(() => onResync(() => void loadHistory(true)), [onResync, loadHistory]);

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
          // The turn has genuinely unwound now, whatever the app-server said
          // when it accepted the abort. Our own note was about the gap between
          // those two moments, so it goes; the app-server's "Interrupted"
          // status line stays as the record.
          setStopping(false);
          clearLocalNotice(transcriptRef.current, STOP_NOTICE_ID);
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
                current_toolset_preference?: unknown;
                available_toolsets?: unknown;
                background_processes?: unknown;
              };
            }
          ).device_status;
          setProcessing(status?.is_processing === true);
          if (typeof status?.current_working_directory === "string") {
            setCwd(status.current_working_directory);
          }
          if (Array.isArray(status?.current_available_skills)) {
            const next = status.current_available_skills as SkillSummary[];
            // A turn recomputes the list (turn-setup.ts); nothing else does. So
            // a list that actually changed is the only evidence that whatever
            // was enabled or disabled has landed.
            const ids = next
              .map((skill) => skill.id)
              .sort()
              .join(",");
            if (ids !== skillIdsRef.current) {
              skillIdsRef.current = ids;
              setSkillsStale(false);
            }
            setSkills(next);
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
          if (typeof status?.current_toolset_preference === "string") {
            setToolsetPreferenceFromStatus(status.current_toolset_preference);
          }
          if (Array.isArray(status?.available_toolsets)) {
            setAvailableToolsets(readToolsets(status.available_toolsets));
          }
          if (Array.isArray(status?.background_processes)) {
            setBackgroundProcesses(readBackgroundProcesses(status.background_processes));
          }
          break;
        }
        case "skills_updated": {
          // Enable/disable only moves a symlink in /root/.letta/skills; the
          // advertised list is rebuilt in turn-setup.ts and NOWHERE else, and
          // no protocol command asks for a fresh one. So there is nothing to
          // reload here — all the client can honestly do is say the list it is
          // showing is behind, until the next turn rebuilds it.
          setSkillsStale(true);
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
      setStopping(false);
      clearLocalNotice(transcriptRef.current, STOP_NOTICE_ID);
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
        setError(errorMessage(cause));
      }
    },
    [scope, send, flush],
  );

  const abort = useCallback(async () => {
    if (!scope) return;

    // `send` was fire-and-forget, which threw away the only frame that says
    // whether anything was actually cancelled — and swallowed the "Not
    // connected" throw with it. `request` correlates the response back.
    try {
      const response = await request<{ aborted?: boolean; success?: boolean; error?: string }>(
        "abort_message",
        { runtime: scope },
      );

      if (response?.success === false) {
        setError(response.error ?? "Could not stop the turn");
        return;
      }

      if (response?.aborted === false) {
        // `handleAbortMessageInput` returns early with no active turn and no
        // pending approval, emitting NOTHING — so without this the press was
        // invisible. It also means our `processing` was stale.
        setProcessing(false);
        setStopping(false);
        seqRef.current += 1;
        setLocalNotice(
          transcriptRef.current,
          STOP_NOTICE_ID,
          "Nothing to stop — the agent is not running.",
          "info",
          seqRef.current,
        );
        flush();
        return;
      }

      // Accepted, but NOT finished. The app-server flips its lifecycle to
      // `cancelling` and emits "Interrupted" synchronously, then asks the
      // backend to cancel the run — and against a local provider that request
      // reaches a dead end: `createProviderLettaStream` hands out an
      // AbortController wired to nothing and `PiStreamAdapter` is built with no
      // `abortSignal`, so the HTTP request to the model is never aborted. The
      // turn can only end when the model's next chunk arrives. Saying so is the
      // honest thing the UI can do; see CLAUDE.md.
      setStopping(true);
      seqRef.current += 1;
      setLocalNotice(
        transcriptRef.current,
        STOP_NOTICE_ID,
        "Stopping — the response already in flight may still finish first.",
        "warning",
        seqRef.current,
      );
      flush();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [scope, request, flush]);

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

  const answerQuestions = useCallback(
    (requestId: string, input: Record<string, unknown>, answers: Record<string, string>) => {
      if (!scope) return;
      send({
        type: "input",
        runtime: scope,
        payload: {
          kind: "approval_response",
          request_id: requestId,
          decision: { behavior: "allow", updated_input: { ...input, answers } },
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

  const resumeQueue = useCallback(() => {
    if (!scope) return;
    send({
      type: "resume_queue",
      runtime: scope,
      request_id: `resume-${Date.now()}`,
    });
  }, [scope, send]);

  const stopMonitor = useCallback(
    (processId: string) => {
      if (!scope) return;
      send({
        type: "monitor_stop",
        runtime: scope,
        request_id: `monitor-stop-${Date.now()}`,
        process_id: processId,
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
    stopping,
    cwd,
    skills,
    queue,
    approvals,
    error,
    sendMessage,
    abort,
    respondToApproval,
    answerQuestions,
    removeQueued,
    resumeQueue,
    runCommand,
    skillsStale,
    permissionMode,
    setPermissionMode,
    commands,
    toolsetPreference,
    availableToolsets,
    backgroundProcesses,
    stopMonitor,
  };
}
