import { useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import type { AgentsApi } from "../state/use-agents.ts";
import { Sheet } from "./Sheet.tsx";

interface Props {
  agents: AgentsApi;
  agent: { id: string; name: string };
  onClose: () => void;
  /** After the agent is gone. */
  onDeleted?: () => void;
}

/**
 * Delete an agent, confirmed by typing its name: it takes every conversation
 * with it and cannot be undone. One sheet for the switcher's ⋯ menu and
 * Agent → General, so the two can never ask differently.
 */
export function DeleteAgentSheet({ agents, agent, onClose, onDeleted }: Props) {
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setStatus("Deleting agent…");
    try {
      await agents.deleteAgent(agent.id);
      onDeleted?.();
      onClose();
    } catch (cause) {
      setStatus(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="Delete agent"
      size="compact"
      onClose={onClose}
      status={status}
      actions={
        <>
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button danger"
            disabled={busy || confirmName.trim() !== agent.name.trim()}
            onClick={() => void remove()}
          >
            Delete
          </button>
        </>
      }
    >
      <p className="warning">
        Deleting <strong>{agent.name}</strong> removes the agent and all of its conversations. This
        cannot be undone.
      </p>
      <label className="field">
        Type the agent name to confirm
        <input
          value={confirmName}
          placeholder={agent.name}
          autoComplete="off"
          onChange={(event) => setConfirmName(event.target.value)}
        />
      </label>
    </Sheet>
  );
}
