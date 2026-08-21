import { useEffect, useState } from "react";
import {
  AGENT_PRESETS,
  type AgentDraft,
  type AgentPreset,
  type AgentsApi,
} from "../state/use-agents.ts";
import { useModels } from "../state/use-models.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Sheet } from "./Sheet.tsx";

interface Props {
  session: SessionApi;
  agents: AgentsApi;
  /** The agent to edit, or null to create a new one. */
  agentId: string | null;
  onClose: () => void;
}

const EMPTY: AgentDraft = { name: "", system: "", modelHandle: null };

export function AgentEditor({ session, agents, agentId, onClose }: Props) {
  const creating = agentId === null;
  const models = useModels(session);

  const [draft, setDraft] = useState<AgentDraft>(EMPTY);
  /** What the model was on load, so an untouched field is not re-applied. */
  const [savedModel, setSavedModel] = useState<string | null>(null);
  const [preset, setPreset] = useState<AgentPreset>("memo");
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(!creating);

  const { retrieveAgent } = agents;

  useEffect(() => {
    if (agentId === null) {
      setDraft(EMPTY);
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const detail = await retrieveAgent(agentId);
        if (cancelled) return;
        setDraft({ name: detail.name, system: detail.system, modelHandle: detail.modelHandle });
        setSavedModel(detail.modelHandle);
      } catch (cause) {
        if (!cancelled) setStatus(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, retrieveAgent]);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    setStatus(label);
    try {
      await action();
      onClose();
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const save = () => {
    // Re-sending the current handle would make the server redo the whole model
    // switch (and its context-window reconciliation) for no change.
    const submitted: AgentDraft =
      draft.modelHandle === savedModel ? { ...draft, modelHandle: null } : draft;
    return run(creating ? "Creating agent…" : "Saving…", () =>
      creating ? agents.createAgent(preset, submitted) : agents.updateAgent(agentId, submitted),
    );
  };

  const remove = () => {
    if (agentId === null) return;
    void run("Deleting agent…", () => agents.deleteAgent(agentId));
  };

  // A model the endpoint no longer serves must stay selectable, or saving the
  // name would silently move the agent onto a different model.
  const known = models.models.some((model) => model.handle === draft.modelHandle);

  return (
    <Sheet
      title={creating ? "New agent" : "Edit agent"}
      onClose={onClose}
      status={status}
      actions={
        deleting ? (
          <>
            <button
              type="button"
              className="button ghost"
              onClick={() => {
                setDeleting(false);
                setConfirmName("");
              }}
            >
              Back
            </button>
            <button
              type="button"
              className="button danger"
              disabled={busy || confirmName.trim() !== draft.name.trim()}
              onClick={remove}
            >
              Delete
            </button>
          </>
        ) : (
          <>
            {creating ? null : (
              <button
                type="button"
                className="button danger ghost"
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                Delete
              </button>
            )}
            <button type="button" className="button ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="button"
              disabled={busy || !draft.name.trim()}
              onClick={() => void save()}
            >
              {creating ? "Create" : "Save"}
            </button>
          </>
        )
      }
    >
      {deleting ? (
        <>
          <p className="warning">
            Deleting <strong>{draft.name}</strong> removes the agent and all of its conversations.
            This cannot be undone.
          </p>
          <label className="field">
            Type the agent name to confirm
            <input
              value={confirmName}
              placeholder={draft.name}
              onChange={(event) => setConfirmName(event.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          <label className="field">
            Name
            <input
              value={draft.name}
              placeholder="my-assistant"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>

          {creating ? (
            <label className="field">
              Personality preset
              <select
                value={preset}
                onChange={(event) => setPreset(event.target.value as AgentPreset)}
              >
                {AGENT_PRESETS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="field">
            Model
            <select
              value={draft.modelHandle ?? ""}
              disabled={models.loading}
              onChange={(event) => setDraft({ ...draft, modelHandle: event.target.value || null })}
            >
              <option value="">{creating ? "Preset default" : "Unchanged"}</option>
              {draft.modelHandle && !known ? (
                <option value={draft.modelHandle}>{draft.modelHandle} (not served)</option>
              ) : null}
              {models.models.map((model) => (
                <option key={model.id} value={model.handle}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>

          {creating ? null : (
            <label className="field">
              System prompt
              <textarea
                className="deny-reason"
                value={draft.system}
                rows={8}
                onChange={(event) => setDraft({ ...draft, system: event.target.value })}
              />
            </label>
          )}
        </>
      )}
    </Sheet>
  );
}
