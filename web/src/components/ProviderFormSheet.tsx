import { useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { KEEP_STORED_HINT } from "../lib/field-hints.ts";
import type { ModState } from "../lib/model-caps.ts";
import {
  customEndpointNote,
  type Provider,
  type ProviderType,
  probeModels,
  probeToast,
  saveProvider,
} from "../lib/provider-registry.ts";
import type { ConnectionTarget } from "./ConnectionPickerSheet.tsx";
import { Icon } from "./Icon.tsx";
import { MenuRow } from "./MenuRow.tsx";
import { Sheet } from "./Sheet.tsx";
import { toast } from "./Toast.tsx";

interface HeaderRow {
  id: number;
  name: string;
  value: string;
}

interface Draft {
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** The header rows in the form; may hold half-filled rows, dropped on save. */
  headerRows: HeaderRow[];
}

/** Rows need a stable key of their own: they are removed from the middle. */
let nextHeaderRowId = 0;
const headerRowId = () => ++nextHeaderRowId;

function draftFrom(provider: Provider | null, types: ProviderType[]): Draft {
  const type = types.find((candidate) => candidate.id === provider?.type) ?? types[0];
  return {
    name: provider?.name ?? "",
    type: provider?.type ?? type?.id ?? "openai-compatible",
    baseUrl: provider?.baseUrl ?? (provider ? "" : (type?.baseUrl ?? "")),
    apiKey: "",
    models: provider?.models ? [...provider.models] : [],
    headerRows: (provider?.headerNames ?? []).map((name) => ({
      id: headerRowId(),
      name,
      value: "",
    })),
  };
}

/** The non-blank rows as the wire map; a half-filled row is a mistake, not a header. */
function headerMap(rows: HeaderRow[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (name !== "" && value !== "") headers[name] = value;
  }
  return headers;
}

/**
 * Add or edit one provider: where it is, what it is called, and which of its
 * models to publish. What a model can do is not here — vision, reasoning and the
 * real context window belong to the model and are set on it with Edit, because a
 * provider is routinely a mix of models that answer differently.
 *
 * The name is read-only when editing: the prefix is the provider's identity, so a
 * rename would silently move every one of its model handles.
 *
 * A type with a `connection` (OpenRouter and the other routers naming models
 * `vendor/model`) is not a provider you name: Connect hands the endpoint and key
 * to the app-server's own connection, and `onConnected` opens the model picker.
 */
export function ProviderFormSheet({
  types,
  editing,
  onClose,
  onSaved,
  onConnected,
}: {
  types: ProviderType[];
  editing: Provider | null;
  onClose: () => void;
  onSaved: (mod: ModState) => void;
  onConnected: (target: ConnectionTarget) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(editing, types));
  const [picking, setPicking] = useState(false);
  const [listed, setListed] = useState<string[] | null>(null);
  /** What the last Test found that a provider you name cannot register. */
  const [skipped, setSkipped] = useState<string[]>([]);
  const [manual, setManual] = useState(false);
  const [manualText, setManualText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosenType = types.find((type) => type.id === draft.type);
  const connection = chosenType?.connection;
  // A connection left blank uses the catalog's endpoint, and nothing is stored for it.
  const endpoint = draft.baseUrl.trim() || (connection ? (chosenType?.baseUrl ?? "") : "");
  const endpointNote = chosenType ? customEndpointNote(chosenType, draft.baseUrl) : null;
  // The picker view replaces the form inside the same sheet: two sheets at once
  // would mean two Escape handlers and two backdrops for one decision.
  const pickedTypes = types.filter((type) => type.scope === chosenType?.scope);

  const modelChoices = (): string[] => {
    const seen = new Set(draft.models);
    return [...draft.models, ...(listed ?? []).filter((id) => !seen.has(id))];
  };

  const toggleModel = (id: string) => {
    setDraft({
      ...draft,
      models: draft.models.includes(id)
        ? draft.models.filter((model) => model !== id)
        : [...draft.models, id],
    });
  };

  // The one action that proves an endpoint: reach it, ask what it serves, and
  // fill the list from the answer. Nothing is asked of a model — a provider is
  // set up once its URL answers and names its models. The answer is a toast, not
  // a line in the form: the operator is about to act on it, not read it back.
  const checkEndpoint = async () => {
    setBusy(true);
    try {
      const found = await probeModels({
        api: chosenType?.api ?? "openai-completions",
        baseUrl: endpoint,
        apiKey: draft.apiKey,
        type: draft.type,
        ...(editing ? { prefix: editing.prefix } : {}),
        headers: headerMap(draft.headerRows),
      });
      // No latency: nobody acts on "412 ms", and the number made the line harder
      // to read than the fact it reported.
      toast(probeToast(found, Boolean(connection)));
      if (connection) return; // its catalog is the model list; nothing to pick
      setListed(found.models);
      setSkipped(found.skipped);
      // A first add picks everything it can register — ticking ten models is not
      // a decision worth forcing, and a model can be unticked.
      setDraft((current) =>
        current.models.length > 0 ? current : { ...current, models: [...found.models] },
      );
    } catch (cause) {
      toast(errorMessage(cause), "bad");
    } finally {
      setBusy(false);
    }
  };

  const manualModels = (): string[] =>
    manualText
      .split(/[\n,]+/)
      .map((line) => line.trim())
      .filter(Boolean);

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const models = manual ? manualModels() : draft.models;
      const typed = headerMap(draft.headerRows);
      // A save says nothing about headers (the stored set survives whole)
      // unless the rows actually differ from what is stored: some value
      // filled in, or the name set changed — removing a pre-filled row is how
      // you delete a stored header. Tracking the click instead would let
      // add-then-undo clear everything.
      const storedNames = (editing?.headerNames ?? []).join("\u0000");
      const rowNames = draft.headerRows.map((row) => row.name.trim()).join("\u0000");
      const result = await saveProvider({
        name: draft.name.trim(),
        type: draft.type,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
        models,
        ...(Object.keys(typed).length > 0 || rowNames !== storedNames ? { headers: typed } : {}),
      });
      if (connection && chosenType) {
        onConnected({
          type: chosenType,
          baseUrl: result.provider.baseUrl,
          apiKey: draft.apiKey.trim(),
          editing: false,
        });
        return;
      }
      // Stored, but the app-server refused to load it: the sheet stays open on why,
      // because closing it would read as "it worked".
      if (result.loadError) {
        setError(`Saved, but the app-server did not load it: ${result.loadError}`);
        return;
      }
      onSaved(result.mod);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (picking) {
    return (
      <Sheet title="Type" onClose={() => setPicking(false)}>
        {(["local", "cloud"] as const).map((scope) => (
          <div key={scope}>
            <h3 className="switcher-group">
              {scope === "local" ? "Local — your own machines" : "Cloud — hosted"}
            </h3>
            <ul className="menu-list">
              {types
                .filter((type) => type.scope === scope)
                .map((type) => (
                  <MenuRow
                    key={type.id}
                    title={type.label}
                    description={`${type.api}${type.baseUrl ? ` · ${type.baseUrl.replace(/^https?:\/\//, "")}` : ""}`}
                    selected={type.id === draft.type}
                    onClick={() => {
                      // The URL belongs to the type, so picking a type owns it —
                      // unless the operator already typed one for this provider.
                      const previous = types.find((candidate) => candidate.id === draft.type);
                      setPicking(false);
                      setDraft((current) => ({
                        ...current,
                        type: type.id,
                        // A connection type starts blank: its endpoint is the placeholder.
                        baseUrl:
                          !current.baseUrl || current.baseUrl === (previous?.baseUrl ?? "")
                            ? type.connection
                              ? ""
                              : type.baseUrl
                            : current.baseUrl,
                      }));
                    }}
                  />
                ))}
            </ul>
          </div>
        ))}
        <p className="muted small">
          Bedrock, Vertex, Azure OpenAI, GitHub Copilot and the ChatGPT / Claude subscription plans
          need vendor or OAuth sign-in, so they stay on the app-server host with{" "}
          <code>letta connect</code>.
        </p>
      </Sheet>
    );
  }

  const choices = modelChoices();
  const keyField = (
    <label className="field">
      API key
      <input
        type="password"
        value={draft.apiKey}
        autoComplete="off"
        placeholder={
          chosenType?.keyOptional
            ? "not needed for a local endpoint"
            : editing?.hasKey
              ? KEEP_STORED_HINT
              : ""
        }
        onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
      />
    </label>
  );
  return (
    <Sheet
      title={editing ? `Edit ${editing.name}` : "Add provider"}
      size="compact"
      status={error}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className="button ghost leading"
            disabled={busy || !endpoint}
            onClick={() => void checkEndpoint()}
          >
            Test
          </button>
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || !endpoint || (connection ? !draft.apiKey.trim() : !draft.name.trim())}
            onClick={() => void commit()}
          >
            {busy ? "Saving…" : connection ? "Connect" : editing ? "Save" : "Add provider"}
          </button>
        </>
      }
    >
      <div className="field">
        Type
        <button
          type="button"
          className="row static"
          style={{
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            padding: "0 10px",
            height: "var(--control-h)",
          }}
          onClick={() => setPicking(true)}
        >
          <span className="grow-text" style={{ fontWeight: 600 }}>
            {chosenType?.label ?? draft.type}
          </span>
          <Icon name="chevron-down" className="chevron" />
        </button>
        {chosenType ? (
          <span className="small">
            Speaks <code>{chosenType.api}</code>.
            {pickedTypes.length > 1 ? " Pick another to change it." : ""}
          </span>
        ) : null}
      </div>

      {connection ? (
        <>
          <p className="muted small">
            The app-server connects {chosenType?.label} itself, one connection per Lettuce, and
            serves it as <code>{connection}/&lt;vendor&gt;/&lt;model&gt;</code>. After Connect you
            choose which of its models to show.
          </p>
          <label className="field">
            Base URL
            <input
              value={draft.baseUrl}
              placeholder={chosenType?.baseUrl}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
            {endpointNote ? <span className="small">{endpointNote}</span> : null}
          </label>
          {keyField}
        </>
      ) : (
        <>
          <label className="field">
            Name
            <input
              value={draft.name}
              placeholder="llama 3b"
              disabled={Boolean(editing)}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <span className="small">
              {editing
                ? "Renaming would move every model handle this provider publishes."
                : `Models are handled as ${
                    draft.name
                      .trim()
                      .toLowerCase()
                      .replace(/[^a-z0-9._-]+/g, "-") || "name"
                  }/<model>.`}
            </span>
          </label>

          <label className="field">
            Base URL
            <input
              value={draft.baseUrl}
              placeholder="http://host.docker.internal:8080/v1"
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
          </label>

          {keyField}

          <p className="section-note" style={{ marginLeft: 0 }}>
            Custom headers
          </p>
          {editing && editing.headerNames.length > 0 ? (
            <div className="hdr-stored">
              {editing.headerNames.map((name) => (
                <span key={name} className="tag muted">
                  {name}
                </span>
              ))}
            </div>
          ) : null}
          {draft.headerRows.map((row) => (
            <div className="hdr-row" key={row.id}>
              <input
                className="hdr-name"
                value={row.name}
                placeholder="X-Header"
                spellCheck={false}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    headerRows: draft.headerRows.map((entry) =>
                      entry.id === row.id ? { ...entry, name: event.target.value } : entry,
                    ),
                  });
                }}
              />
              <input
                className="hdr-value"
                value={row.value}
                placeholder="value"
                spellCheck={false}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    headerRows: draft.headerRows.map((entry) =>
                      entry.id === row.id ? { ...entry, value: event.target.value } : entry,
                    ),
                  });
                }}
              />
              <button
                type="button"
                className="hdr-remove"
                aria-label="Remove header"
                onClick={() => {
                  setDraft({
                    ...draft,
                    headerRows: draft.headerRows.filter((entry) => entry.id !== row.id),
                  });
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
          <div className="field">
            <button
              type="button"
              className="link inline"
              style={{ padding: 0 }}
              onClick={() => {
                setDraft({
                  ...draft,
                  headerRows: [...draft.headerRows, { id: headerRowId(), name: "", value: "" }],
                });
              }}
            >
              + Add header
            </button>
            <span className="small">
              Sent with every request to this endpoint. Values are stored on the server and never shown
              again — a save with no filled row keeps the stored headers, one with any row replaces them
              all.
            </span>
          </div>

          <p className="section-note" style={{ marginLeft: 0 }}>
            Models
          </p>
          {manual ? (
            <label className="field">
              Model ids
              <textarea
                rows={5}
                className="memory-editor"
                value={manualText}
                placeholder={"qwen3-4b-instruct\ngemma3n-e4b"}
                onChange={(event) => setManualText(event.target.value)}
              />
              <span className="small">One per line, exactly as the endpoint names them.</span>
            </label>
          ) : choices.length > 0 ? (
            <ul className="menu-list">
              {choices.map((id) => (
                <MenuRow
                  key={id}
                  title={id}
                  mark="checkbox"
                  selected={draft.models.includes(id)}
                  onClick={() => toggleModel(id)}
                />
              ))}
            </ul>
          ) : (
            <p className="muted small pad">
              {listed === null
                ? "Nothing yet — Test the endpoint, or type the ids in."
                : "The endpoint reported nothing."}
            </p>
          )}
          {!manual && skipped.length > 0 ? (
            <p className="muted small">
              {skipped.length} more not listed:{" "}
              {skipped.slice(0, 3).map((id, index) => (
                <span key={id}>
                  {index > 0 ? ", " : null}
                  <code>{id}</code>
                </span>
              ))}
              {skipped.length > 3 ? `, and ${skipped.length - 3} more` : null}. A model id holding a{" "}
              <code>/</code> cannot be registered under a provider you name.
            </p>
          ) : null}

          <p className="muted small">
            {manual ? "Add models by name. " : "No endpoint in the list? "}
            <button
              type="button"
              className="link inline"
              onClick={() => setManual((value) => !value)}
            >
              {manual ? "pick them from the endpoint" : "type the model ids"}
            </button>
            . What each model can do — vision, reasoning, its real context window — is set on the
            model, with <strong>Edit</strong> beside its name.
          </p>
        </>
      )}
    </Sheet>
  );
}
