import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { McpEditor } from "../components/McpEditor.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { errorMessage } from "../lib/errors.ts";
import { handleProvider, isLocalHandle, localProviderKeys } from "../lib/providers.ts";
import {
  getPushPreferences,
  isIOS,
  isPushSupported,
  isStandalone,
  isSubscribed,
  type PushPreferences,
  subscribeToPush,
  unsubscribeFromPush,
  updatePushPreferences,
} from "../lib/push.ts";
import type { SkillSummary } from "../state/use-conversation.ts";
import { useModels } from "../state/use-models.ts";
import type { SessionApi } from "../state/use-session.ts";

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

interface Props {
  session: SessionApi;
  agentId: string | null;
  /** Skills advertised on the latest device status snapshot. */
  skills: SkillSummary[];
  /** True once a skill was enabled or disabled but no turn has rebuilt the list. */
  skillsStale: boolean;
}

type Section = "connection" | "mcp" | "skills" | "notifications";

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

export function SettingsTab({ session, agentId, skills, skillsStale }: Props) {
  const [section, setSection] = useState<Section>("connection");

  return (
    <div className="pane">
      <div className="pane-bar">
        {(["connection", "mcp", "skills", "notifications"] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={`chip${section === name ? " on" : ""}`}
            onClick={() => setSection(name)}
          >
            {name === "mcp"
              ? "MCP"
              : name === "connection"
                ? "Connection"
                : name === "skills"
                  ? "Skills"
                  : "Notifications"}
          </button>
        ))}
      </div>

      {section === "connection" ? <ConnectionSection session={session} /> : null}
      {section === "mcp" ? <McpEditor session={session} agentId={agentId} /> : null}
      {section === "skills" ? (
        <SkillsSection session={session} skills={skills} stale={skillsStale} />
      ) : null}
      {section === "notifications" ? <NotificationsSection /> : null}
    </div>
  );
}

function ConnectionSection({ session }: { session: SessionApi }) {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<ProviderEntry | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [showCloud, setShowCloud] = useState(false);
  const [showCloudProviders, setShowCloudProviders] = useState(false);
  // Same hook the chat model picker uses, so the two can never disagree about
  // what is being served.
  const models = useModels(session);

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
    if (session.ready) void load();
  }, [session.ready, load]);

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

      {session.appServerInfo ? (
        <p className="muted small pad">
          letta-code v{session.appServerInfo.letta_code_version} · {session.appServerInfo.backend}{" "}
          backend
        </p>
      ) : null}

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
        {localModels.map((model) => (
          <li key={model.id} className="row-between pad">
            <span>{model.label}</span>
            <code className="muted small">{handleProvider(model.handle)}</code>
          </li>
        ))}
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

function SkillsSection({
  session,
  skills,
  stale,
}: {
  session: SessionApi;
  skills: SkillSummary[];
  stale: boolean;
}) {
  const [status, setStatus] = useState("");
  const [path, setPath] = useState("");

  /**
   * `skill_enable` does exactly one thing: symlink the directory it is given
   * into `/root/.letta/skills`, which is the GLOBAL scope — every agent, every
   * conversation. There is no protocol command for any narrower scope, so the
   * label says global rather than pretending otherwise.
   */
  const enable = async () => {
    const skillPath = path.trim();
    if (!skillPath) return;
    setStatus(`Enabling ${skillPath}…`);
    try {
      const response = await session.request<{ success?: boolean; error?: string }>(
        "skill_enable",
        {
          skill_path: skillPath,
        },
      );
      if (response?.success === false) {
        setStatus(response.error ?? "Failed");
        return;
      }
      setStatus("Enabled. It appears in the list after the agent's next turn.");
      setPath("");
    } catch (cause) {
      setStatus(errorMessage(cause));
    }
  };

  const disable = async (skill: SkillSummary) => {
    setStatus(`Disabling ${skill.name}…`);
    try {
      const response = await session.request<{ success?: boolean; error?: string }>(
        "skill_disable",
        { name: skill.name },
      );
      setStatus(response?.success === false ? (response.error ?? "Failed") : "");
    } catch (cause) {
      setStatus(errorMessage(cause));
    }
  };

  return (
    <>
      {status ? <p className="muted small pad">{status}</p> : null}

      <p className="section-note">
        {skills.length} skill{skills.length === 1 ? "" : "s"} loaded
      </p>

      {/* The app-server rebuilds this list in turn-setup.ts and nowhere else,
          and no command asks for a fresh one — so after an enable or disable
          the honest thing is to say the list is behind, not to fake a reload. */}
      {stale ? (
        <p className="muted small pad">
          Skills changed. This list is rebuilt at the start of the agent's next turn — send a
          message to refresh it.
        </p>
      ) : null}

      <ul className="list">
        {skills.map((skill) => (
          <li key={skill.id}>
            <div className="row static">
              <span className="grow-text">
                <strong>{skill.name}</strong>
                <div className="muted small">{skill.description}</div>
                <div className="muted small">
                  <code>{skill.source}</code> {skill.path}
                </div>
              </span>
              {/* Only a global skill can be disabled: skill_disable unlinks from
                  /root/.letta/skills and nothing else, so on a project- or
                  agent-scoped skill it answers "Skill not found". */}
              {skill.source === "global" ? (
                <button type="button" className="link danger" onClick={() => void disable(skill)}>
                  Disable
                </button>
              ) : null}
            </div>
          </li>
        ))}
        {skills.length === 0 ? (
          <li className="muted pad">
            No skills loaded. The list is empty until the agent has taken a turn in this
            conversation.
          </li>
        ) : null}
      </ul>

      <p className="section-note">Enable a skill globally</p>
      <p className="muted small pad">
        Symlinks a directory containing a <code>SKILL.md</code> into{" "}
        <code>/root/.letta/skills</code>, where every agent loads it. The path must be inside{" "}
        <code>/work</code>.
      </p>
      <div className="pad-x">
        <label className="field">
          Skill directory
          <input
            value={path}
            placeholder="/work/<agent-id>/.agents/skills/my-skill"
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button"
          disabled={!path.trim()}
          onClick={() => void enable()}
        >
          Enable globally
        </button>
      </div>

      <p className="section-note">Installing from git</p>
      <p className="muted small pad">
        The browser has no shell on the app-server host, so ask the agent in Chat. Its shell is
        confined to its own workspace, which means it can install for itself but not globally — have
        it clone into <code>.agents/skills/</code> under its working directory:
      </p>
      <pre className="tool-args pad-x">
        Clone https://github.com/me/my-skill into .agents/skills/my-skill in your working directory.
      </pre>
      <p className="muted small pad">
        That is per-agent: every conversation with this agent sees it, other agents do not. For a
        skill every agent should have, use the field above.
      </p>
    </>
  );
}

const NOTIFICATION_EVENT_TYPES: { key: keyof PushPreferences; label: string }[] = [
  { key: "completed", label: "Turn completed" },
  { key: "failed", label: "Turn failed" },
  { key: "approval", label: "Approval needed" },
];

function NotificationsSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [preferences, setPreferences] = useState<PushPreferences | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!isPushSupported()) {
      setEnabled(false);
      return;
    }
    // Without the catch a failed service worker left `enabled` null forever —
    // a disabled button with no reason given. Surface the browser's own error;
    // the button stays usable, and pressing it reports the same failure again.
    void isSubscribed()
      .then(async (subscribed) => {
        setEnabled(subscribed);
        if (subscribed) setPreferences(await getPushPreferences());
      })
      .catch((cause) => {
        setEnabled(false);
        setStatus(`Notifications are unavailable: ${errorMessage(cause)}`);
      });
  }, []);

  const toggle = async () => {
    setStatus(enabled ? "Disabling…" : "Enabling…");
    try {
      if (enabled) {
        await unsubscribeFromPush();
        setEnabled(false);
        setPreferences(null);
      } else {
        await subscribeToPush();
        setEnabled(true);
        setPreferences(await getPushPreferences());
      }
      setStatus("");
    } catch (cause) {
      setStatus(errorMessage(cause));
    }
  };

  const togglePreference = async (key: keyof PushPreferences, value: boolean) => {
    const previous = preferences;
    if (!previous) return;
    setPreferences({ ...previous, [key]: value });
    try {
      await updatePushPreferences({ [key]: value });
    } catch (cause) {
      setPreferences(previous);
      setStatus(errorMessage(cause));
    }
  };

  // Web Push only reaches an iOS PWA actually added to the Home Screen — a
  // Safari tab (or any browser other than Safari, which is the only one that
  // can install a PWA on iOS at all) never receives it, silently.
  if (isIOS() && !isStandalone()) {
    return (
      <p className="muted small pad">
        Add this app to your Home Screen (Safari's Share menu → Add to Home Screen) to enable
        notifications on iPhone or iPad — Web Push only reaches an installed app there, never a
        browser tab.
      </p>
    );
  }

  if (!isPushSupported()) {
    return <p className="muted small pad">Push notifications are not supported in this browser.</p>;
  }

  return (
    <>
      {status ? <p className="muted small pad">{status}</p> : null}
      <p className="section-note">Notifications</p>
      <p className="muted small pad">
        Sends a notification to this device when the agent finishes a turn, hits an error, or needs
        a tool approval — while you're not watching that conversation.
      </p>
      <div className="pad-x">
        <button
          type="button"
          className="button"
          disabled={enabled === null}
          onClick={() => void toggle()}
        >
          {enabled ? "Disable notifications" : "Enable notifications"}
        </button>
      </div>
      {enabled && preferences ? (
        <div className="pad-x">
          {NOTIFICATION_EVENT_TYPES.map(({ key, label }) => (
            <label className="checkbox" key={key}>
              <input
                type="checkbox"
                checked={preferences[key]}
                onChange={(event) => void togglePreference(key, event.target.checked)}
              />
              {label}
            </label>
          ))}
        </div>
      ) : null}
    </>
  );
}
