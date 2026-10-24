import { useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import {
  AGENT_PRESETS,
  type AgentDraft,
  type AgentPreset,
  type AgentsApi,
  agentPresetDescription,
} from "../state/use-agents.ts";
import { type ModelsApi, useModels } from "../state/use-models.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Icon } from "./Icon.tsx";
import { ModelChoices } from "./ModelPicker.tsx";
import { Sheet } from "./Sheet.tsx";
import { toast } from "./Toast.tsx";

interface Props {
  session: SessionApi;
  agents: AgentsApi;
  onClose: () => void;
}

const EMPTY: AgentDraft = { name: "", system: "", modelHandle: null };

/**
 * New agent. Editing an existing one is the Agent tab's General section
 * (`AgentGeneralSection`), next to the agent's other settings.
 */
export function AgentEditor({ session, agents, onClose }: Props) {
  const models = useModels(session);
  const [draft, setDraft] = useState<AgentDraft>(EMPTY);
  const [preset, setPreset] = useState<AgentPreset>("memo");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await agents.createAgent(preset, draft);
      toast(`Created ${draft.name.trim()}.`);
      onClose();
    } catch (cause) {
      setStatus(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="New agent"
      onClose={onClose}
      status={status}
      actions={
        <>
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || !draft.name.trim()}
            onClick={() => void create()}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <label className="field">
        Name
        <input
          value={draft.name}
          placeholder="my-assistant"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>

      <label className="field">
        Personality preset
        <select value={preset} onChange={(event) => setPreset(event.target.value as AgentPreset)}>
          {AGENT_PRESETS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="small">{agentPresetDescription(preset)}</span>
      </label>

      <ModelField
        models={models}
        value={draft.modelHandle}
        emptyLabel="Preset default"
        onChange={(modelHandle) => setDraft({ ...draft, modelHandle })}
      />
    </Sheet>
  );
}

/**
 * The agent's model: a field that opens the conversation's model sheet.
 *
 * Two idioms for the same choice is what this replaced — a native select here, a
 * grouped sheet there — and only one of them said which endpoint serves what.
 * Picking here **stages**: an agent's model is saved with everything else on its
 * tab, so the sheet sets the draft and `Save` commits, exactly as the name and
 * the system prompt do.
 */
export function ModelField({
  models,
  value,
  emptyLabel,
  hint,
  onChange,
}: {
  models: ModelsApi;
  value: string | null;
  emptyLabel: string;
  /** Shown under the field when the pick is staged rather than applied. */
  hint?: string | null;
  onChange: (handle: string | null) => void;
}) {
  const [picking, setPicking] = useState(false);
  const known = models.models.find((model) => model.handle === value);
  // A handle the endpoint stopped serving shows as itself — the sheet keeps it
  // selectable so saving the name cannot silently move the agent.
  const shown = value === null ? emptyLabel : (known?.label ?? value);
  return (
    <div className="field">
      Model
      <button
        type="button"
        className="field-trigger"
        disabled={models.loading}
        onClick={() => setPicking(true)}
      >
        <span className={`trigger-value${value === null ? " muted" : ""}`}>{shown}</span>
      </button>
      {hint ? <span className="small">{hint}</span> : null}
      {picking ? (
        <Sheet
          title="Model"
          size="compact"
          status={models.error}
          onClose={() => setPicking(false)}
          headerAction={
            <button
              type="button"
              className="sheet-head-icon"
              disabled={models.loading}
              onClick={() => void models.refresh()}
              aria-label="Refresh the model list"
              title="Refresh"
            >
              <Icon name="refresh" />
            </button>
          }
        >
          <ModelChoices
            models={models}
            currentHandle={value}
            emptyLabel={emptyLabel}
            onPick={(handle) => {
              onChange(handle);
              setPicking(false);
            }}
          />
        </Sheet>
      ) : null}
    </div>
  );
}
