import { useEffect, useState } from "react";
import type { RuntimeScope } from "../lib/protocol.ts";
import type { SessionApi } from "../state/use-session.ts";

interface ModelEntry {
  id: string;
  handle: string;
  label: string;
  updateArgs?: Record<string, unknown>;
}

interface Props {
  session: SessionApi;
  scope: RuntimeScope | null;
  onClose: () => void;
}

/** Applies to the conversation, not the agent, so each thread can differ. */
export function ModelPicker({ session, scope, onClose }: Props) {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [status, setStatus] = useState<string>("Loading models…");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await session.request<{ entries?: unknown[]; error?: string }>(
          "list_models",
        );
        if (cancelled) return;
        const entries = Array.isArray(response?.entries) ? response.entries : [];
        const parsed = entries.flatMap((raw) => {
          if (!raw || typeof raw !== "object") return [];
          const model = raw as {
            id?: unknown;
            handle?: unknown;
            label?: unknown;
            updateArgs?: unknown;
          };
          if (typeof model.id !== "string") return [];
          return [
            {
              id: model.id,
              handle: typeof model.handle === "string" ? model.handle : model.id,
              label: typeof model.label === "string" ? model.label : model.id,
              ...(model.updateArgs && typeof model.updateArgs === "object"
                ? { updateArgs: model.updateArgs as Record<string, unknown> }
                : {}),
            },
          ];
        });
        setModels(parsed);
        setStatus(
          parsed.length === 0
            ? "No models available. Configure a provider in Settings."
            : "",
        );
      } catch (cause) {
        if (!cancelled) setStatus(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const choose = async (model: ModelEntry) => {
    if (!scope) return;
    setStatus(`Switching to ${model.label}…`);
    try {
      const response = await session.request<{ success?: boolean; error?: string }>(
        "update_model",
        {
          runtime: scope,
          payload: model.updateArgs ?? { model: model.handle },
        },
      );
      if (response?.success === false) {
        setStatus(response.error ?? "Failed to switch model");
        return;
      }
      onClose();
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="sheet">
      <div className="sheet-body">
        <h2>Model for this conversation</h2>
        {status ? <p className="muted">{status}</p> : null}
        <ul className="picker">
          {models.map((model) => (
            <li key={model.id}>
              <button type="button" onClick={() => void choose(model)}>
                <strong>{model.label}</strong>
                <code>{model.handle}</code>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="sheet-actions">
        <button type="button" className="button ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
