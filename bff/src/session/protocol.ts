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
  user: { email: string; name: string };
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
  // channels (Telegram)
  "channels_list",
  "channel_accounts_list",
  "channel_account_create",
  "channel_account_update",
  "channel_account_bind",
  "channel_account_unbind",
  "channel_account_delete",
  "channel_account_start",
  "channel_account_stop",
  "channel_get_config",
  "channel_set_config",
  "channel_start",
  "channel_stop",
  "channel_pairings_list",
  "channel_pairing_bind",
  "channel_routes_list",
  "channel_route_remove",
  "channel_route_update",
  "channel_targets_list",
  "channel_target_bind",
  // slash commands (the app-server enforces its own SUPPORTED_REMOTE_COMMANDS)
  "execute_command",
]);
