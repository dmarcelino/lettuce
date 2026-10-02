import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { fetchModelCaps, type ModelCaps } from "../lib/model-caps.ts";
import {
  handleProvider,
  isCapabilityLessHandle,
  isLocalHandle,
  localProviderKeys,
  normalizeProviderKey,
} from "../lib/providers.ts";
import { useModels } from "../state/use-models.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Icon } from "./Icon.tsx";
import { ModelEditSheet, type ModelEditTarget } from "./ModelEditSheet.tsx";
import { Sheet } from "./Sheet.tsx";

interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
}

interface ProviderEntry {
  id: string;
  display_name: string;
  description: string;
  provider_name: string;
  requires_api_key: boolean;
  is_oauth?: boolean;
  fields?: ProviderField[];
  /** The nested flag is `is_connected`, not `connected`. */
  connected?: { is_connected?: boolean; base_url?: string } | boolean;
  connected_providers?: unknown[];
  /** Handle prefixes this provider serves, used to group its models. */
  provider_names?: string[];
}

function isConnected(provider: ProviderEntry): boolean {
  if (typeof provider.connected === "boolean") return provider.connected;
  if (provider.connected && typeof provider.connected === "object") {
    return provider.connected.is_connected === true;
  }
  return (provider.connected_providers?.length ?? 0) > 0;
}

/**
 * Values to seed an edit form with.
 *
 * Only `base_url` comes back from the server — the API key is never echoed, by
 * design. That matters because blank is treated as *absent*, not *unchanged*
 * (`resolveProviderConnectionFields`), so submitting an untouched empty key
 * field would clear a stored key. `connect` below only sends fields the user
 * actually typed, which is what makes an edit non-destructive.
 */
function currentValues(provider: ProviderEntry): Record<string, string> {
  const state = typeof provider.connected === "object" ? provider.connected : null;
  return state?.base_url ? { baseUrl: state.base_url } : {};
}

/** The connection row a handle prefix belongs to, following BYOK aliases. */
function providerForPrefix(
  providers: readonly ProviderEntry[],
  aliases: Readonly<Record<string, string>>,
  prefix: string,
): ProviderEntry | undefined {
  const base = aliases[prefix] ?? prefix;
  const key = normalizeProviderKey(base);
  return providers.find((p) =>
    [p.provider_name, ...(p.provider_names ?? [])].some(
      (n) => n && normalizeProviderKey(n) === key,
    ),
  );
}

export function ConnectionSection({ session }: { session: SessionApi }) {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<ProviderEntry | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [showCloud, setShowCloud] = useState(false);
  const [showCloudProviders, setShowCloudProviders] = useState(false);
  // Same hook the chat model picker uses, so the two can never disagree about
  // what is being served.
  const models = useModels(session);
  // What the operator declared per model (bff/src/providers/store.ts); the
  // row's tags are the save confirmation, so this is display state only.
  const [caps, setCaps] = useState<Record<string, ModelCaps>>({});
  const [editingModel, setEditingModel] = useState<ModelEditTarget | null>(null);

  const loadCaps = useCallback(async () => {
    try {
      setCaps(await fetchModelCaps());
    } catch {
      // Non-fatal: without the store the list simply shows no tags.
    }
  }, []);

  const load = useCallback(async () => {
    setStatus("Loading providers…");
    try {
      const response = await session.request<{
        providers?: ProviderEntry[];
        success?: boolean;
        error?: string;
      }>("list_connect_providers", { target: "local" });
      if (response?.success === false) {
        setStatus(response.error ?? "Failed to list providers");
        return;
      }
      setProviders(response?.providers ?? []);
      setStatus("");
    } catch (cause) {
      setStatus(errorMessage(cause));
    }
  }, [session.request]);

  useEffect(() => {
    if (session.ready) {
      void load();
      void loadCaps();
    }
  }, [session.ready, load, loadCaps]);

  // `connect_provider` routes to createOrUpdateProvider, keyed on provider
  // name, so re-issuing it with new fields IS the edit path — there is no
  // separate update command and no disconnect/reconnect needed.
  const connect = async () => {
    if (!editing) return;
    const wasConnected = isConnected(editing);
    setStatus(`${wasConnected ? "Updating" : "Connecting"} ${editing.display_name}…`);
    try {
      // Only send what the user actually typed. A blank field is read as
      // *absent* rather than unchanged, so passing an untouched empty API key
      // would clear the stored one on every save.
      const fields = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value.trim() !== ""),
      );
      const response = await session.request<{
        success?: boolean;
        error?: string;
        providers?: ProviderEntry[];
        models_may_have_changed?: boolean;
      }>("connect_provider", {
        target: "local",
        provider_id: editing.id,
        fields,
      });
      if (response?.success === false) {
        setStatus(response.error ?? "Connection failed");
        return;
      }
      setProviders(response?.providers ?? providers);
      setEditing(null);
      setValues({});
      setStatus(wasConnected ? "Updated." : "Connected.");
      if (response?.models_may_have_changed !== false) void models.refresh();
    } catch (cause) {
      setStatus(errorMessage(cause));
    }
  };

  const disconnect = async (provider: ProviderEntry) => {
    setStatus(`Disconnecting ${provider.display_name}…`);
    try {
      const response = await session.request<{ providers?: ProviderEntry[]; error?: string }>(
        "disconnect_provider",
        { target: "local", provider_id: provider.id, provider_name: provider.provider_name },
      );
      setProviders(response?.providers ?? providers);
      setStatus("");
    } catch (cause) {
      setStatus(errorMessage(cause));
    }
  };

  // Local endpoints first: this deployment is meant to run without cloud providers.
  const local = providers.filter((p) => !p.requires_api_key && !p.is_oauth);
  const rest = providers.filter((p) => p.requires_api_key || p.is_oauth);

  // Comparing the handle's provider segment literally against provider_name
  // fails for llama.cpp and only llama.cpp: it reports "llama-cpp" but stamps
  // "llama.cpp/" onto every handle. See lib/providers.ts.
  const localKeys = localProviderKeys(local);
  const localModels = models.models.filter((m) => isLocalHandle(m.handle, localKeys));
  const cloudModels = models.models.filter((m) => !isLocalHandle(m.handle, localKeys));

  const open = (provider: ProviderEntry) => {
    setEditing(provider);
    // Prefill, so an edit amends rather than starts from blank.
    setValues(currentValues(provider));
  };

  return (
    <>
      {status ? <p className="muted small pad">{status}</p> : null}

      <p className="section-note">
        Local endpoints — no cloud account needed. Point llama.cpp at its own host and port.
      </p>
      <ul className="list">
        {local.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            onConnect={() => open(provider)}
            onDisconnect={() => void disconnect(provider)}
          />
        ))}
      </ul>

      <p className="section-note">
        Models served{localModels.length > 0 ? ` (${localModels.length})` : ""}
        {models.loading ? " — loading…" : ""}
      </p>

      {/* A model list that changes between refreshes means the endpoint is
          answering each /models call from a different backend — the symptom is
          otherwise invisible, because any single call looks plausible. */}
      {models.changed ? (
        <p className="warning small">
          This endpoint returned a different set of models on the last refresh —{" "}
          {models.changed.currentCount} now versus {models.changed.previousCount} before. That
          usually means it load-balances <code>/models</code> across several backends, so each call
          is answered by a different one. Point the connection at an aggregating endpoint, or at a
          single backend.
        </p>
      ) : null}

      {localModels.length === 0 && !models.loading ? (
        <p className="muted small pad">
          Nothing served yet. Connect an endpoint above, then Refresh.
        </p>
      ) : null}
      <ul className="list">
        {localModels.map((model) => {
          const prefix = handleProvider(model.handle);
          const declared = caps[model.handle];
          // Only capability-less endpoints can be declared; native ones
          // already report their own capabilities and need no editing.
          const editable = isCapabilityLessHandle(model.handle, models.aliases);
          const connection = providerForPrefix(providers, models.aliases, prefix);
          return (
            <li key={model.id}>
              <div className="row static">
                <span className="grow-text">
                  {model.label}
                  {declared?.vision ? (
                    <span className="tag muted" style={{ marginLeft: 6 }}>
                      Vision
                    </span>
                  ) : null}
                  {declared?.thinking ? (
                    <span className="tag muted" style={{ marginLeft: 6 }}>
                      Thinking
                    </span>
                  ) : null}
                </span>
                <code className="muted small">{prefix}</code>
                {editable ? (
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      setEditingModel({
                        handle: model.handle,
                        label: model.label,
                        baseUrl:
                          typeof connection?.connected === "object"
                            ? connection.connected.base_url
                            : undefined,
                        requiresKey: connection?.requires_api_key === true,
                        caps: declared ?? null,
                      })
                    }
                  >
                    Edit
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="pad">
        <button
          type="button"
          className="link"
          disabled={models.loading}
          onClick={() => void models.refresh()}
        >
          Refresh models
        </button>
      </p>

      {cloudModels.length > 0 ? (
        <>
          <button type="button" className="tool-head" onClick={() => setShowCloud((v) => !v)}>
            <span className="tag">Cloud models ({cloudModels.length})</span>
            <Icon name={showCloud ? "chevron-down" : "chevron-right"} />
          </button>
          {showCloud ? (
            <ul className="list">
              {cloudModels.map((model) => (
                <li key={model.id} className="row-between pad">
                  <span className="muted">{model.label}</span>
                  <code className="muted small">{model.handle}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {rest.length > 0 ? (
        <>
          <button
            type="button"
            className="tool-head"
            onClick={() => setShowCloudProviders((v) => !v)}
          >
            <span className="tag">Cloud providers ({rest.length})</span>
            <Icon name={showCloudProviders ? "chevron-down" : "chevron-right"} />
          </button>
          {showCloudProviders ? (
            <ul className="list">
              {rest.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  onConnect={() => open(provider)}
                  onDisconnect={() => void disconnect(provider)}
                />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {editingModel ? (
        <ModelEditSheet
          target={editingModel}
          onClose={() => setEditingModel(null)}
          onSaved={() => {
            setEditingModel(null);
            void loadCaps();
            void models.refresh();
          }}
        />
      ) : null}

      {editing ? (
        <Sheet
          title={editing.display_name}
          size="compact"
          onClose={() => setEditing(null)}
          actions={
            <>
              <button type="button" className="button ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button"
                disabled={editing.is_oauth}
                onClick={() => void connect()}
              >
                {isConnected(editing) ? "Save" : "Connect"}
              </button>
            </>
          }
        >
          <p className="muted small">{editing.description}</p>

          {(editing.fields ?? []).map((field) => (
            <label className="field" key={field.key}>
              {field.label}
              <input
                type={field.secret ? "password" : "text"}
                placeholder={
                  field.secret && isConnected(editing)
                    ? "Leave blank to keep the stored value"
                    : (field.placeholder ?? "")
                }
                value={values[field.key] ?? ""}
                onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
              />
            </label>
          ))}

          {editing.is_oauth ? (
            <p className="warning small">
              This provider uses OAuth, which needs an interactive browser flow on the app-server
              host. Connect it with <code>letta connect</code> there instead.
            </p>
          ) : null}
        </Sheet>
      ) : null}
    </>
  );
}

function ProviderRow({
  provider,
  onConnect,
  onDisconnect,
}: {
  provider: ProviderEntry;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const connected = isConnected(provider);
  return (
    <li>
      <div className="row static">
        <span className="grow-text">
          <strong>{provider.display_name}</strong>
          <div className="muted small">{provider.description}</div>
        </span>
        {connected ? (
          <>
            <span className="tag ok-tag">connected</span>
            {/* Without this the field sheet is unreachable once connected, so a
                base URL could only be changed by disconnecting first. */}
            <button type="button" className="link" onClick={onConnect}>
              Edit
            </button>
            <button type="button" className="link danger" onClick={onDisconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <button type="button" className="link" onClick={onConnect}>
            Connect
          </button>
        )}
      </div>
    </li>
  );
}
