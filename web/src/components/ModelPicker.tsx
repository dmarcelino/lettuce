import { useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import type { RuntimeScope } from "../lib/protocol.ts";
import type { ToolsetSummary } from "../state/use-conversation.ts";
import { type ModelEntry, useModels } from "../state/use-models.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Icon } from "./Icon.tsx";
import { MenuRow } from "./MenuRow.tsx";
import { Sheet } from "./Sheet.tsx";

interface Props {
  session: SessionApi;
  scope: RuntimeScope | null;
  /** Lifted to App so the composer button reflects a switch made here. */
  currentModel: { handle: string | null; setHandle: (handle: string | null) => void };
  /** Live from device status — "auto" or an explicit toolset id. Null until the first status frame. */
  toolsetPreference: string | null;
  availableToolsets: ToolsetSummary[];
  onClose: () => void;
}

/** Applies to the conversation, not the agent, so each thread can differ. */
export function ModelPicker({
  session,
  scope,
  currentModel,
  toolsetPreference,
  availableToolsets,
  onClose,
}: Props) {
  const models = useModels(session);
  const current = currentModel;
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toolsetStatus, setToolsetStatus] = useState<string | null>(null);
  const [toolsetBusy, setToolsetBusy] = useState(false);

  const choose = async (model: ModelEntry) => {
    if (!scope) {
      setStatus("Select a conversation first.");
      return;
    }
    setBusy(true);
    setStatus(`Switching to ${model.label}…`);
    try {
      // `isUpdateModelCommand` requires model_id or model_handle to be a
      // string. A payload without either (the old `{ model: handle }`, or the
      // entry's `updateArgs`) fails the guard, matches no handler, and gets
      // **no response at all** — same silent-hang class as `grep_in_files`
      // with the wrong key. Verified against the local app-server.
      const response = await session.request<{
        success?: boolean;
        model_handle?: string;
        error?: string;
      }>("update_model", {
        runtime: scope,
        payload: { model_id: model.id, model_handle: model.handle },
      });

      if (response?.success === false) {
        setStatus(response.error ?? "Failed to switch model");
        return;
      }
      current.setHandle(response?.model_handle ?? model.handle);
      onClose();
    } catch (cause) {
      setStatus(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const chooseToolset = async (toolset: ToolsetSummary) => {
    if (!scope) {
      setToolsetStatus("Select a conversation first.");
      return;
    }
    setToolsetBusy(true);
    setToolsetStatus(`Switching to ${toolset.label}…`);
    try {
      const response = await session.request<{ success?: boolean; error?: string }>(
        "update_toolset",
        { runtime: scope, toolset_preference: toolset.id },
      );
      // The picked value reflects back through the next update_device_status
      // frame, same as permission mode — no optimistic local state needed.
      setToolsetStatus(
        response?.success === false ? (response.error ?? "Failed to switch toolset") : null,
      );
    } catch (cause) {
      setToolsetStatus(errorMessage(cause));
    } finally {
      setToolsetBusy(false);
    }
  };

  const notice =
    models.availability === "lookup-failed"
      ? "Could not reach the provider to check availability — showing the built-in list."
      : models.availability === "not-reported"
        ? "This server does not report model availability — showing the built-in list."
        : null;

  return (
    <Sheet
      title="Model"
      onClose={onClose}
      status={status ?? models.error}
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
      {notice ? <p className="warning small">{notice}</p> : null}

      {models.loading ? <p className="muted">Loading models…</p> : null}

      {!models.loading && models.models.length === 0 ? (
        <p className="muted">
          No models are being served. Connect a provider in Settings, then Refresh.
        </p>
      ) : null}

      <ul className="menu-list">
        {models.models.map((model) => (
          <MenuRow
            key={model.id}
            title={model.label}
            description={model.handle}
            mark="check"
            selected={model.handle === current.handle}
            disabled={busy}
            onClick={() => void choose(model)}
          />
        ))}
      </ul>

      {availableToolsets.length > 0 ? (
        <>
          <p className="menu-section">Toolset</p>
          {toolsetStatus ? <p className="menu-intro">{toolsetStatus}</p> : null}
          <ul className="menu-list">
            {availableToolsets
              .filter((toolset) => toolset.featured || toolset.id === toolsetPreference)
              .map((toolset) => (
                <MenuRow
                  key={toolset.id}
                  title={toolset.label}
                  description={toolset.description}
                  mark="check"
                  selected={toolset.id === toolsetPreference}
                  disabled={toolsetBusy}
                  onClick={() => void chooseToolset(toolset)}
                />
              ))}
          </ul>
        </>
      ) : null}
    </Sheet>
  );
}
