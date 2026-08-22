import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
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

interface Props {
  session: SessionApi;
  agentId: string | null;
  conversationId: string | null;
}

const BLANK = {
  name: "",
  description: "",
  cron: "0 9 * * *",
  prompt: "",
  recurring: true,
};

export function TasksTab({ session, agentId, conversationId }: Props) {
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<CronTask | null>(null);
  const [draft, setDraft] = useState({ ...BLANK });
  const [creating, setCreating] = useState(false);

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
      setStatus(cause instanceof Error ? cause.message : String(cause));
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
      setStatus(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
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

      {creating || editing ? (
        <div className="sheet">
          <div className="sheet-body">
            <h2>{editing ? "Edit task" : "New task"}</h2>

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
          </div>

          <div className="sheet-actions">
            <button
              type="button"
              className="button ghost"
              onClick={() => {
                setCreating(false);
                setEditing(null);
              }}
            >
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
          </div>
        </div>
      ) : null}
    </div>
  );
}
