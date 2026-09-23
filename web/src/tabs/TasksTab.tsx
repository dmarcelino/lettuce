import type {
  LaunchSubagentCommand,
  LaunchSubagentResponse,
} from "@letta-ai/letta-code/app-server-protocol";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { errorMessage } from "../lib/errors.ts";
import type { BackgroundProcessSummary } from "../state/use-conversation.ts";
import type { SessionApi } from "../state/use-session.ts";

interface CronTask {
  id: string;
  name: string;
  description: string;
  cron: string;
  timezone: string;
  recurring: boolean;
  prompt: string;
  status: string;
  last_fired_at: string | null;
  fire_count: number;
  scheduled_for: string | null;
  last_run_outcome: string | null;
  last_run_error: string | null;
}

const PROCESS_KIND_LABEL: Record<BackgroundProcessSummary["kind"], string> = {
  bash: "Shell",
  agent_task: "Subagent",
  monitor: "Monitor",
};

interface Props {
  session: SessionApi;
  agentId: string | null;
  conversationId: string | null;
  backgroundProcesses: BackgroundProcessSummary[];
  onStopMonitor: (processId: string) => void;
}

/**
 * Suggestions only — the field stays free text. The real list is resolved per
 * cwd (`getAllSubagentConfigs`, which also reads project-defined agents), is
 * not advertised anywhere in the protocol, and an unknown type comes back as
 * an error naming every valid one. The other builtins (fork, init,
 * reflection, memory) are harness internals.
 */
const SUBAGENT_TYPES = ["general-purpose", "recall", "history-analyzer"];

const BLANK_SUBAGENT = { type: "general-purpose", description: "", prompt: "" };

const BLANK = {
  name: "",
  description: "",
  cron: "0 9 * * *",
  prompt: "",
  recurring: true,
};

export function TasksTab({
  session,
  agentId,
  conversationId,
  backgroundProcesses,
  onStopMonitor,
}: Props) {
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<CronTask | null>(null);
  const [draft, setDraft] = useState({ ...BLANK });
  const [creating, setCreating] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [subagent, setSubagent] = useState({ ...BLANK_SUBAGENT });
  const [launchBusy, setLaunchBusy] = useState(false);

  const load = useCallback(async () => {
    if (!agentId) return;
    setStatus("Loading tasks…");
    try {
      const response = await session.request<{
        tasks?: CronTask[];
        success?: boolean;
        error?: string;
      }>("cron_list", { agent_id: agentId });
      if (response?.success === false) {
        setStatus(response.error ?? "Failed to list tasks");
        return;
      }
      setTasks(response?.tasks ?? []);
      setStatus("");
    } catch (cause) {
      setStatus(errorMessage(cause));
    }
  }, [agentId, session.request]);

  useEffect(() => {
    if (session.ready && agentId) void load();
  }, [session.ready, agentId, load]);

  // The agent can schedule its own work; keep the list live.
  useEffect(
    () =>
      session.onFrame((frame) => {
        if ((frame as { type?: unknown }).type === "crons_updated") void load();
      }),
    [session.onFrame, load],
  );

  const act = async (type: string, body: Record<string, unknown>, label: string) => {
    setStatus(`${label}…`);
    try {
      const response = await session.request<{
        success?: boolean;
        error?: string;
        warning?: string;
      }>(type, body);
      if (response?.success === false) {
        setStatus(response.error ?? `${label} failed`);
        return false;
      }
      setStatus(response?.warning ?? "");
      await load();
      return true;
    } catch (cause) {
      setStatus(errorMessage(cause));
      return false;
    }
  };

  /** Shared by Cancel, the scrim and Escape, now that the Sheet supplies all three. */
  const closeEditor = () => {
    setCreating(false);
    setEditing(null);
  };

  const submit = async () => {
    if (!agentId) return;
    const ok = editing
      ? await act(
          "cron_update",
          {
            task_id: editing.id,
            name: draft.name,
            description: draft.description,
            cron: draft.cron,
            prompt: draft.prompt,
            recurring: draft.recurring,
          },
          "Saving",
        )
      : await act(
          "cron_add",
          {
            agent_id: agentId,
            ...(conversationId ? { conversation_id: conversationId } : {}),
            name: draft.name,
            description: draft.description || draft.name,
            cron: draft.cron,
            recurring: draft.recurring,
            prompt: draft.prompt,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          "Creating",
        );
    if (ok) {
      setEditing(null);
      setCreating(false);
      setDraft({ ...BLANK });
    }
  };

  /**
   * `launch_subagent` runs beside the parent's turn without taking its lease,
   * so it works mid-turn too. The child shows up under "Running now" via
   * device status and reports back into this conversation when it finishes.
   */
  const launchSubagent = async () => {
    if (!agentId || !conversationId) return;
    const args: LaunchSubagentCommand["args"] = {
      subagent_type: subagent.type.trim() || "general-purpose",
      description: subagent.description.trim(),
      prompt: subagent.prompt.trim(),
    };
    setLaunchBusy(true);
    setStatus("Launching subagent…");
    try {
      const response = await session.request<LaunchSubagentResponse>("launch_subagent", {
        runtime: { agent_id: agentId, conversation_id: conversationId },
        args,
      });
      if (!response.success) {
        setStatus(response.error);
        return;
      }
      setStatus(`Subagent started (${response.task_id}); it reports back to this conversation.`);
      setLaunching(false);
      setSubagent({ ...BLANK_SUBAGENT });
    } catch (cause) {
      setStatus(errorMessage(cause));
    } finally {
      setLaunchBusy(false);
    }
  };

  if (!agentId) {
    return (
      <div className="pane">
        <p className="muted pad">Select an agent.</p>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="pane-bar">
        <button
          type="button"
          className="link"
          onClick={() => {
            setDraft({ ...BLANK });
            setEditing(null);
            setCreating(true);
          }}
        >
          <Icon name="plus" /> New task
        </button>
        <button
          type="button"
          className="link"
          disabled={!conversationId}
          onClick={() => {
            setSubagent({ ...BLANK_SUBAGENT });
            setLaunching(true);
          }}
          title={conversationId ? "Launch a subagent" : "Open a conversation first"}
        >
          <Icon name="plus" /> Subagent
        </button>
        <button
          type="button"
          className="link"
          onClick={() => void load()}
          title="Reload tasks"
          aria-label="Reload tasks"
        >
          <Icon name="refresh" />
        </button>
        <span className="spacer" />
        <span className="muted small">{tasks.length} scheduled</span>
      </div>

      {status ? <p className="muted small pad">{status}</p> : null}

      {backgroundProcesses.length > 0 ? (
        <>
          <p className="section-note">Running now</p>
          <ul className="list">
            {backgroundProcesses.map((process) => (
              <li key={process.processId} className="task">
                <div className="task-head">
                  <span className="tag muted">{PROCESS_KIND_LABEL[process.kind]}</span>
                  <span className="small">{process.label}</span>
                </div>
                <div className="muted small">{process.status}</div>
                {process.stoppable ? (
                  <div className="task-actions">
                    <button
                      type="button"
                      className="link danger"
                      onClick={() => onStopMonitor(process.processId)}
                    >
                      Stop
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="section-note">Scheduled</p>
        </>
      ) : null}

      <ul className="list">
        {tasks.map((task) => (
          <li key={task.id} className="task">
            <div className="task-head">
              <strong>{task.name}</strong>
              <span className={`tag ${task.status === "active" ? "" : "muted"}`}>
                {task.status}
              </span>
            </div>
            <div className="muted small">
              <code>{task.cron}</code> · {task.timezone} ·{" "}
              {task.recurring ? "repeating" : "one-shot"}
            </div>
            {task.description ? <div className="small">{task.description}</div> : null}
            <div className="muted small">
              {task.last_fired_at
                ? `Last fired ${new Date(task.last_fired_at).toLocaleString()} (${task.fire_count}×)`
                : task.scheduled_for
                  ? `Scheduled for ${new Date(task.scheduled_for).toLocaleString()}`
                  : "Never fired"}
              {task.last_run_outcome ? ` · ${task.last_run_outcome}` : ""}
            </div>
            {task.last_run_error ? <div className="small bad">{task.last_run_error}</div> : null}

            <div className="task-actions">
              <button
                type="button"
                className="link"
                onClick={() => void act("cron_trigger", { task_id: task.id }, "Running")}
              >
                Run now
              </button>
              {task.status === "active" ? (
                <button
                  type="button"
                  className="link"
                  onClick={() => void act("cron_pause", { task_id: task.id }, "Pausing")}
                >
                  Pause
                </button>
              ) : null}
              {task.status === "paused" ? (
                <button
                  type="button"
                  className="link"
                  onClick={() => void act("cron_resume", { task_id: task.id }, "Resuming")}
                >
                  Resume
                </button>
              ) : null}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setEditing(task);
                  setCreating(false);
                  setDraft({
                    name: task.name,
                    description: task.description,
                    cron: task.cron,
                    prompt: task.prompt,
                    recurring: task.recurring,
                  });
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="link danger"
                onClick={() => {
                  if (confirm(`Delete "${task.name}"?`)) {
                    void act("cron_delete", { task_id: task.id }, "Deleting");
                  }
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
        {tasks.length === 0 && !status ? <li className="muted pad">No scheduled tasks</li> : null}
      </ul>

      {launching ? (
        <Sheet
          title="Launch subagent"
          onClose={() => setLaunching(false)}
          actions={
            <>
              <button type="button" className="button ghost" onClick={() => setLaunching(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="button"
                disabled={launchBusy || !subagent.description.trim() || !subagent.prompt.trim()}
                onClick={() => void launchSubagent()}
              >
                {launchBusy ? "Launching…" : "Launch"}
              </button>
            </>
          }
        >
          <label className="field">
            Type
            <input
              value={subagent.type}
              list="subagent-types"
              onChange={(event) => setSubagent({ ...subagent, type: event.target.value })}
            />
            <datalist id="subagent-types">
              {SUBAGENT_TYPES.map((type) => (
                <option key={type} value={type} />
              ))}
            </datalist>
          </label>

          <label className="field">
            Description
            <input
              value={subagent.description}
              placeholder="A few words, shown in Running now"
              onChange={(event) => setSubagent({ ...subagent, description: event.target.value })}
            />
          </label>

          <label className="field">
            Prompt
            <textarea
              value={subagent.prompt}
              rows={5}
              onChange={(event) => setSubagent({ ...subagent, prompt: event.target.value })}
            />
            <span className="muted small">
              Runs in this conversation's working directory and reports back here when done.
            </span>
          </label>
        </Sheet>
      ) : null}

      {creating || editing ? (
        <Sheet
          title={editing ? "Edit task" : "New task"}
          onClose={closeEditor}
          actions={
            <>
              <button type="button" className="button ghost" onClick={closeEditor}>
                Cancel
              </button>
              <button
                type="button"
                className="button"
                disabled={!draft.name.trim() || !draft.prompt.trim()}
                onClick={() => void submit()}
              >
                {editing ? "Save" : "Create"}
              </button>
            </>
          }
        >
          <label className="field">
            Name
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>

          <label className="field">
            Description
            <input
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>

          <label className="field">
            Schedule (cron)
            <input
              value={draft.cron}
              placeholder="0 9 * * *"
              onChange={(event) => setDraft({ ...draft, cron: event.target.value })}
            />
            <span className="muted small">
              minute hour day month weekday — e.g. <code>0 9 * * *</code> is 9am daily
            </span>
          </label>

          <label className="field">
            Prompt sent to the agent
            <textarea
              value={draft.prompt}
              rows={4}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.recurring}
              onChange={(event) => setDraft({ ...draft, recurring: event.target.checked })}
            />
            Repeating
          </label>
        </Sheet>
      ) : null}
    </div>
  );
}
