/**
 * The small envelope the BFF adds on top of the app-server protocol for
 * browser sessions. Everything else on the wire is a verbatim app-server frame,
 * so the SPA can drive it with the same `AppServerClient` the BFF uses upstream.
 */

/** Attached by the BFF to every unsolicited frame, for exact resume. */
export const SEQ_FIELD = "__seq" as const;

export interface BffHelloMessage {
  type: "__bff_hello";
  session_id: string;
  user: { email: string };
  upstream: "connecting" | "connected" | "disconnected";
  app_server_info: unknown;
  latest_seq: number;
}

export interface BffResumeCommand {
  type: "__bff_resume";
  /** Last `__seq` the client rendered, or null on a cold start. */
  from_seq: number | null;
  /** Scopes to replay; omitted replays everything the buffer holds. */
  scopes?: { agent_id: string; conversation_id: string }[];
}

export interface BffResumeResultMessage {
  type: "__bff_resume_result";
  from_seq: number | null;
  latest_seq: number;
  replayed: number;
  /** Client must rebuild from conversation_messages_list. */
  resync_required: boolean;
}

export interface BffUpstreamStateMessage {
  type: "__bff_upstream_state";
  state: "connecting" | "connected" | "disconnected";
  app_server_info: unknown;
}

export interface BffErrorMessage {
  type: "__bff_error";
  message: string;
  request_id?: string;
}

export type BffServerMessage =
  | BffHelloMessage
  | BffResumeResultMessage
  | BffUpstreamStateMessage
  | BffErrorMessage;

export function isBffResumeCommand(value: unknown): value is BffResumeCommand {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { type?: unknown; from_seq?: unknown };
  return (
    candidate.type === "__bff_resume" &&
    (candidate.from_seq === null || typeof candidate.from_seq === "number")
  );
}

/**
 * Command types a browser session may send upstream.
 *
 * Deliberately an allowlist: the app-server exposes process-level surface
 * (terminals, arbitrary shell via execute_command, secrets) that should only be
 * reachable through screens we have actually built.
 */
export const ALLOWED_SESSION_COMMANDS: ReadonlySet<string> = new Set([
  // discovery + lifecycle
  "app_server_info",
  "runtime_start",
  "sync",
  "change_device_state",
  // conversation turns
  "input",
  "abort_message",
  "remove_queue_item",
  "resume_queue",
  "approval_response",
  // agents + conversations
  "agent_list",
  "agent_retrieve",
  "agent_create",
  "agent_update",
  "agent_delete",
  "create_agent",
  "conversation_list",
  "conversation_retrieve",
  "conversation_create",
  "conversation_update",
  "conversation_messages_list",
  "conversation_compact",
  "conversation_fork",
  "conversation_recompile",
  // models + toolset
  "list_models",
  "update_model",
  "update_toolset",
  "list_connect_providers",
  "connect_provider",
  "disconnect_provider",
  // files
  "get_tree",
  "list_in_directory",
  "search_files",
  "grep_in_files",
  "read_file",
  "write_file",
  "edit_file",
  "watch_file",
  "unwatch_file",
  // memory
  "list_memory",
  "read_memory_file",
  "write_memory_file",
  "delete_memory_file",
  "memory_history",
  "memory_file_at_ref",
  "memory_commit_diff",
  "enable_memfs",
  // tasks
  "cron_list",
  "cron_add",
  "cron_get",
  "cron_runs",
  "cron_trigger",
  "cron_update",
  "cron_delete",
  // skills
  "skill_enable",
  "skill_disable",
  // working directory
  "get_cwd_map",
  "set_boot_working_directory",
  // NOTE: channel_* commands are deliberately absent. The app-server only
  // dispatches them when a gateway registered `serviceCommandHandler`, which
  // happens over the CLI's stdio pipe to a child gateway process — never over
  // the app-server WebSocket. Sent from here they would hang with no response
  // rather than fail. Telegram is configured with `letta channels` inside the
  // gateway container; see CLAUDE.md.

  // slash commands. NOTE: the app-server does NOT enforce its own
  // SUPPORTED_REMOTE_COMMANDS on the inbound path — `isExecuteCommandCommand`
  // only checks that `command_id` is a string, and the constant is used purely
  // to advertise the list in DeviceStatus. An unknown id is answered with
  // `success: false` ("Unknown command"), not refused at the boundary.
  "execute_command",
]);

/**
 * Root every file operation is confined to.
 *
 * The app-server applies NO root of its own: `read_file` with
 * `/root/.letta/settings.json` or `write_file` into a cron directory both
 * succeed, and no `../` is needed to get there. The only guards upstream
 * (PROTECTED_HOME_NAMES, the $HOME grep short-circuit) are browsing
 * conveniences, explicitly documented as not being security boundaries. So the
 * confinement has to live here, next to the command allowlist and for the same
 * reason: the browser may only reach surfaces we actually built for it.
 *
 * `/work` is the bind mount from the host (see docker/compose.yml). Agents get
 * `/work/<agent-id>`; `/work` itself is the shared level above.
 */
export const WORKSPACE_ROOT = "/work";

/**
 * Path-bearing commands, and which field carries the path.
 *
 * The field name is not uniform: search_files and grep_in_files take `cwd`
 * (falling back to the server's process cwd when absent), skill_enable takes
 * `skill_path`, everything else takes `path`. A clamp keyed only on `path`
 * would leave those unguarded.
 *
 * `skill_enable` is here for the same reason the file commands are, and it is
 * the one that would hurt most: it symlinks whatever directory it is given into
 * `/root/.letta/skills`, from where the skill is loaded for every agent and its
 * `scripts/` earn their own scoped permission rules upstream
 * (`permissions/analyzer.ts`). Nothing legitimate is lost by the clamp —
 * `/work` is the only place either the browser or a sandboxed agent can put
 * files in the first place.
 */
export const FILE_PATH_FIELDS: ReadonlyMap<string, "path" | "cwd" | "skill_path"> = new Map([
  ["get_tree", "path"],
  ["list_in_directory", "path"],
  ["read_file", "path"],
  ["write_file", "path"],
  ["edit_file", "path"],
  ["watch_file", "path"],
  ["unwatch_file", "path"],
  ["search_files", "cwd"],
  ["grep_in_files", "cwd"],
  ["skill_enable", "skill_path"],
]);

/**
 * Paths outside the workspace that a screen we built genuinely needs.
 *
 * MCP servers are not in the protocol — they live in settings.json under the
 * agent's own entry, so the MCP editor reads and merges that exact file (see
 * CLAUDE.md). Allowing the one file keeps that screen working without opening
 * the directory it sits in: `/root/.letta/` also holds transcripts and agent
 * secrets, and none of those have a screen.
 *
 * Exact paths only, never prefixes — a prefix here would re-open the traversal
 * this clamp exists to close.
 */
export const PATH_EXCEPTIONS: ReadonlySet<string> = new Set(["/root/.letta/settings.json"]);

/** Normalise a POSIX path, resolving `.` and `..` without touching the disk. */
function normalizePosixPath(input: string): string {
  const segments: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * The reason this command must be refused, or null when it is allowed.
 *
 * A relative path is refused outright rather than resolved: the app-server
 * would interpret it against its own cwd, which is not something the browser
 * can see or reason about.
 */
export function workspaceViolation(
  command: Record<string, unknown> & { type: string },
): string | null {
  const field = FILE_PATH_FIELDS.get(command.type);
  if (!field) return null;

  const raw = command[field];
  // An absent path is left to the app-server. For `cwd` that is deliberate — it
  // means "the server's own cwd", which compose anchors inside the workspace —
  // and for the required fields it is simply the app-server's error to give.
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw === "") {
    return `${command.type}.${field} must be a non-empty string`;
  }
  if (!raw.startsWith("/")) {
    return `${command.type}.${field} must be an absolute path inside ${WORKSPACE_ROOT}`;
  }

  const resolved = normalizePosixPath(raw);
  if (PATH_EXCEPTIONS.has(resolved)) return null;
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    return `Path is outside the workspace: ${resolved} is not under ${WORKSPACE_ROOT}`;
  }
  return null;
}
