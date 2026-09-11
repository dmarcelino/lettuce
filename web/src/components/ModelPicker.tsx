import { useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import type { RuntimeScope } from "../lib/protocol.ts";
import type { ToolsetSummary } from "../state/use-conversation.ts";
import { type ModelEntry, useModels } from "../state/use-models.ts";
import type { SessionApi } from "../state/use-session.ts";
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
      title="Model for this conversation"
      onClose={onClose}
      status={status ?? models.error}
      actions={
        <>
          <button
            type="button"
            className="button ghost"
            disabled={models.loading}
            onClick={() => void models.refresh()}
          >
            Refresh
          </button>
          <button type="button" className="button ghost" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {notice ? <p className="warning small">{notice}</p> : null}

      {models.loading ? <p className="muted">Loading models…</p> : null}

      {!models.loading && models.models.length === 0 ? (
        <p className="muted">
          No models are being served. Connect a provider in Settings, then Refresh.
        </p>
      ) : null}

      <ul className="picker">
        {models.models.map((model) => {
          const active = model.handle === current.handle;
          return (
            <li key={model.id}>
              <button
                type="button"
                disabled={busy}
                aria-current={active ? "true" : undefined}
                className={active ? "active" : ""}
                onClick={() => void choose(model)}
              >
                <strong>
                  {model.label}
                  {active ? <span className="tag">current</span> : null}
                </strong>
                <code>{model.handle}</code>
              </button>
            </li>
          );
        })}
      </ul>

      {availableToolsets.length > 0 ? (
        <>
          <p className="section-note">Toolset</p>
          {toolsetStatus ? <p className="muted small">{toolsetStatus}</p> : null}
          <ul className="picker">
            {availableToolsets
              .filter((toolset) => toolset.featured || toolset.id === toolsetPreference)
              .map((toolset) => {
                const active = toolset.id === toolsetPreference;
                return (
                  <li key={toolset.id}>
                    <button
                      type="button"
                      disabled={toolsetBusy}
                      aria-current={active ? "true" : undefined}
                      className={active ? "active" : ""}
                      onClick={() => void chooseToolset(toolset)}
                    >
                      <strong>
                        {toolset.label}
                        {active ? <span className="tag">current</span> : null}
                      </strong>
                      <span className="muted small">{toolset.description}</span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </>
      ) : null}
    </Sheet>
  );
}
