import { useCallback, useEffect, useState } from "react";
import type { SessionApi } from "../state/use-session.ts";
import { McpEditor } from "../components/McpEditor.tsx";

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
  connected?: { is_connected?: boolean } | boolean;
  connected_providers?: unknown[];
}

interface SkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
}

interface Props {
  session: SessionApi;
  agentId: string | null;
  /** Skills advertised on the latest device status snapshot. */
  skills: SkillSummary[];
}

type Section = "connection" | "mcp" | "skills";

function isConnected(provider: ProviderEntry): boolean {
  if (typeof provider.connected === "boolean") return provider.connected;
  if (provider.connected && typeof provider.connected === "object") {
    return provider.connected.is_connected === true;
  }
  return (provider.connected_providers?.length ?? 0) > 0;
}

export function SettingsTab({ session, agentId, skills }: Props) {
  const [section, setSection] = useState<Section>("connection");

  return (
    <div className="pane">
      <div className="pane-bar">
        {(["connection", "mcp", "skills"] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={`chip${section === name ? " on" : ""}`}
            onClick={() => setSection(name)}
          >
            {name === "mcp" ? "MCP" : name === "connection" ? "Connection" : "Skills"}
          </button>
        ))}
      </div>

      {section === "connection" ? <ConnectionSection session={session} /> : null}
      {section === "mcp" ? <McpEditor session={session} agentId={agentId} /> : null}
      {section === "skills" ? <SkillsSection session={session} skills={skills} /> : null}
    </div>
  );
}

function ConnectionSection({ session }: { session: SessionApi }) {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<ProviderEntry | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

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
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }, [session]);

  useEffect(() => {
    if (session.ready) void load();
  }, [session.ready, load]);

  const connect = async () => {
    if (!editing) return;
    setStatus(`Connecting ${editing.display_name}…`);
    try {
      const response = await session.request<{
        success?: boolean;
        error?: string;
        providers?: ProviderEntry[];
      }>("connect_provider", {
        target: "local",
        provider_id: editing.id,
        fields: values,
      });
      if (response?.success === false) {
        setStatus(response.error ?? "Connection failed");
        return;
      }
      setProviders(response?.providers ?? providers);
      setEditing(null);
      setValues({});
      setStatus("Connected. Pick a model from the Chat tab.");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
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
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // Local endpoints first: this deployment is meant to run without cloud providers.
  const local = providers.filter((p) => !p.requires_api_key && !p.is_oauth);
  const rest = providers.filter((p) => p.requires_api_key || p.is_oauth);

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
            onConnect={() => {
              setEditing(provider);
              setValues({});
            }}
            onDisconnect={() => void disconnect(provider)}
          />
        ))}
      </ul>

      <p className="section-note">Cloud providers</p>
      <ul className="list">
        {rest.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            onConnect={() => {
              setEditing(provider);
              setValues({});
            }}
            onDisconnect={() => void disconnect(provider)}
          />
        ))}
      </ul>

      {editing ? (
        <div className="sheet">
          <div className="sheet-body">
            <h2>{editing.display_name}</h2>
            <p className="muted small">{editing.description}</p>

            {(editing.fields ?? []).map((field) => (
              <label className="field" key={field.key}>
                {field.label}
                <input
                  type={field.secret ? "password" : "text"}
                  placeholder={field.placeholder ?? ""}
                  value={values[field.key] ?? ""}
                  onChange={(event) =>
                    setValues({ ...values, [field.key]: event.target.value })
                  }
                />
              </label>
            ))}

            {editing.is_oauth ? (
              <p className="warning small">
                This provider uses OAuth, which needs an interactive browser flow on the
                app-server host. Connect it with <code>letta connect</code> there instead.
              </p>
            ) : null}
          </div>

          <div className="sheet-actions">
            <button type="button" className="button ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="button"
              disabled={editing.is_oauth}
              onClick={() => void connect()}
            >
              Connect
            </button>
          </div>
        </div>
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

function SkillsSection({
  session,
  skills,
}: {
  session: SessionApi;
  skills: SkillSummary[];
}) {
  const [status, setStatus] = useState("");

  const disable = async (skill: SkillSummary) => {
    setStatus(`Disabling ${skill.name}…`);
    try {
      const response = await session.request<{ success?: boolean; error?: string }>(
        "skill_disable",
        { name: skill.name },
      );
      setStatus(response?.success === false ? (response.error ?? "Failed") : "");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <>
      {status ? <p className="muted small pad">{status}</p> : null}

      <p className="section-note">
        {skills.length} skill{skills.length === 1 ? "" : "s"} loaded
      </p>

      <ul className="list">
        {skills.map((skill) => (
          <li key={skill.id}>
            <div className="row static">
              <span className="grow-text">
                <strong>{skill.name}</strong>
                <div className="muted small">{skill.description}</div>
                <div className="muted small">
                  <code>{skill.source}</code>
                </div>
              </span>
              {skill.source !== "bundled" ? (
                <button type="button" className="link danger" onClick={() => void disable(skill)}>
                  Disable
                </button>
              ) : null}
            </div>
          </li>
        ))}
        {skills.length === 0 ? <li className="muted pad">No skills loaded</li> : null}
      </ul>

      <p className="section-note">Installing from git</p>
      <p className="muted small pad">
        Skill installation runs on the app-server host, which the browser has no shell access
        to by design. Ask the agent in Chat — it has git and can install into its own memory:
      </p>
      <pre className="tool-args pad-x">
        Install the skill from https://github.com/me/my-private-skills and enable it.
      </pre>
    </>
  );
}
