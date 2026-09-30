import { useCallback, useEffect, useState } from "react";
import {
  type ClaudeSettings,
  type ClaudeSettingsUpdate,
  fetchClaudeSettings,
  saveClaudeSettings,
} from "../lib/claude.ts";
import { ToggleRow } from "./MenuRow.tsx";

interface Draft {
  enabled: boolean;
  baseUrl: string;
  model: string;
  /** Typed only; the stored token is never sent back. */
  authToken: string;
  clearAuthToken: boolean;
}

function draftOf(settings: ClaudeSettings): Draft {
  return {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl,
    model: settings.model,
    authToken: "",
    clearAuthToken: false,
  };
}

/**
 * Settings → Claude Code: the Anthropic-compatible endpoint and model Claude
 * Code subagent workers run against, and the switch that allows them at all.
 * Saved server-side into the file the `claude` shim reads
 * (see bff/src/claude/settings.ts); applies to the next worker started, no
 * restart needed.
 */
export function ClaudeSection() {
  const [settings, setSettings] = useState<ClaudeSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await fetchClaudeSettings();
      setSettings(loaded.settings);
      setDraft(draftOf(loaded.settings));
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    const update: ClaudeSettingsUpdate = {
      enabled: draft.enabled,
      baseUrl: draft.baseUrl,
      model: draft.model,
    };
    if (draft.clearAuthToken) update.authToken = "";
    else if (draft.authToken.trim()) update.authToken = draft.authToken.trim();
    setSaving(true);
    try {
      const saved = await saveClaudeSettings(update);
      setSettings(saved);
      setDraft(draftOf(saved));
      setStatus("Saved. Applies to the next Claude Code worker started.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (!draft || !settings) {
    return (
      <>
        {status ? <p className="small bad pad">{status}</p> : <p className="muted pad">Loading…</p>}
        <div className="pad-x">
          <button type="button" className="button ghost" onClick={() => void load()}>
            Reload
          </button>
        </div>
      </>
    );
  }

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  return (
    <>
      <p className="muted small pad">
        Agents can hand coding work to a Claude Code worker (subagent type <code>claude-code</code>
        ). It runs in the agent&apos;s workspace inside the app-server container, with the same
        access as the agent&apos;s own shell. Claude Code speaks only the Anthropic Messages API, so
        the endpoint must serve it — a proxy in front of your model works.
      </p>
      {status ? <p className="muted small pad">{status}</p> : null}

      <div className="pad-x">
        <ToggleRow
          title="Allow Claude Code workers"
          description="Agents may hand coding work to a Claude Code subagent"
          checked={draft.enabled}
          onChange={(enabled) => set({ enabled })}
        />

        <label className="field">
          Endpoint URL
          <input
            value={draft.baseUrl}
            placeholder="http://host:4000"
            autoComplete="off"
            onChange={(event) => set({ baseUrl: event.target.value })}
          />
          <span className="muted small">
            An Anthropic-compatible API (a LiteLLM-style proxy or any Anthropic-API gateway).
          </span>
        </label>

        <label className="field">
          Model
          <input
            value={draft.model}
            placeholder="Model id as the endpoint names it"
            autoComplete="off"
            onChange={(event) => set({ model: event.target.value })}
          />
        </label>

        <label className="field">
          Auth token
          <input
            type="password"
            value={draft.authToken}
            disabled={draft.clearAuthToken}
            placeholder={settings.hasAuthToken ? "Saved — type to replace" : "None (optional)"}
            autoComplete="off"
            onChange={(event) => set({ authToken: event.target.value })}
          />
          <span className="muted small">
            Sent to the endpoint as a bearer token. Optional when the endpoint does not check it.
          </span>
        </label>
        {settings.hasAuthToken ? (
          <ToggleRow
            title="Remove the saved token"
            checked={draft.clearAuthToken}
            onChange={(clearAuthToken) => set({ clearAuthToken, authToken: "" })}
          />
        ) : null}

        <button type="button" className="button" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}
