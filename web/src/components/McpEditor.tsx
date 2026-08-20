import { useCallback, useEffect, useState } from "react";
import type { SessionApi } from "../state/use-session.ts";

/**
 * MCP servers are absent from the app-server protocol. They live in
 * ~/.letta/settings.json under the agent's own entry, so this edits that file
 * through the file commands and then asks the runtime to reload.
 */
const SETTINGS_PATH = "/root/.letta/settings.json";

type Transport = "stdio" | "http" | "sse";

interface McpServer {
  name: string;
  transport?: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface AgentSettings {
  agentId?: string;
  mcpServers?: McpServer[];
  [key: string]: unknown;
}

interface Settings {
  agents?: AgentSettings[];
  [key: string]: unknown;
}

const BLANK: McpServer = { name: "", transport: "stdio", command: "", args: [] };

export function McpEditor({
  session,
  agentId,
}: {
  session: SessionApi;
  agentId: string | null;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState<McpServer | null>(null);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [argsText, setArgsText] = useState("");

  const load = useCallback(async () => {
    if (!agentId) return;
    setStatus("Loading settings…");
    try {
      const response = await session.request<{
        content?: string | null;
        success?: boolean;
        error?: string;
      }>("read_file", { path: SETTINGS_PATH, encoding: "utf8" });

      if (response?.success === false || typeof response?.content !== "string") {
        setStatus(response?.error ?? "Could not read settings.json");
        return;
      }

      const parsed = JSON.parse(response.content) as Settings;
      setSettings(parsed);
      const agent = parsed.agents?.find((entry) => entry.agentId === agentId);
      setServers(agent?.mcpServers ?? []);
      setStatus("");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }, [agentId, session]);

  useEffect(() => {
    if (session.ready && agentId) void load();
  }, [session.ready, agentId, load]);

  const persist = async (next: McpServer[]) => {
    if (!settings || !agentId) return;
    setStatus("Saving…");

    // Merge into the agent's entry, leaving every other setting untouched.
    const agents = [...(settings.agents ?? [])];
    const index = agents.findIndex((entry) => entry.agentId === agentId);
    const entry: AgentSettings =
      index >= 0 ? { ...agents[index] } : { agentId, mcpServers: [] };

    if (next.length > 0) entry.mcpServers = next;
    else delete entry.mcpServers;

    if (index >= 0) agents[index] = entry;
    else agents.push(entry);

    const updated: Settings = { ...settings, agents };

    try {
      const response = await session.request<{ success?: boolean; error?: string }>(
        "write_file",
        { path: SETTINGS_PATH, content: `${JSON.stringify(updated, null, 2)}\n` },
      );
      if (response?.success === false) {
        setStatus(response.error ?? "Save failed");
        return;
      }
      setSettings(updated);
      setServers(next);
      setStatus("Saved. Reloading the runtime…");

      // Settings are read at load time, so the runtime must re-read them.
      session.send({
        type: "execute_command",
        command_id: "reload",
        request_id: `reload-${Date.now()}`,
        runtime: { agent_id: agentId, conversation_id: "default" },
      });
      setStatus("Saved. The agent is reloading its tools.");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openEditor = (server: McpServer | null, index: number | null) => {
    const value = server ?? { ...BLANK };
    setDraft(value);
    setDraftIndex(index);
    setArgsText((value.args ?? []).join(" "));
  };

  const commit = async () => {
    if (!draft || !draft.name.trim()) return;
    const value: McpServer = {
      name: draft.name.trim(),
      transport: draft.transport ?? "stdio",
    };
    if (value.transport === "stdio") {
      value.command = draft.command?.trim() ?? "";
      const args = argsText.trim();
      if (args) value.args = args.split(/\s+/);
    } else {
      value.url = draft.url?.trim() ?? "";
    }

    const next = [...servers];
    if (draftIndex === null) next.push(value);
    else next[draftIndex] = value;

    setDraft(null);
    setDraftIndex(null);
    await persist(next);
  };

  const remove = async (index: number) => {
    const server = servers[index];
    if (!server || !confirm(`Remove MCP server "${server.name}"?`)) return;
    await persist(servers.filter((_, i) => i !== index));
  };

  if (!agentId) {
    return <p className="muted pad">Select an agent.</p>;
  }

  return (
    <>
      <div className="pane-bar">
        <button type="button" className="link" onClick={() => openEditor(null, null)}>
          + Add server
        </button>
        <button type="button" className="link" onClick={() => void load()}>
          ↻
        </button>
        <span className="spacer" />
        <span className="muted small">{servers.length} configured</span>
      </div>

      {status ? <p className="muted small pad">{status}</p> : null}

      <ul className="list">
        {servers.map((server, index) => (
          <li key={server.name}>
            <div className="row static">
              <span className="grow-text">
                <strong>{server.name}</strong>
                <div className="muted small">
                  <code>
                    {server.transport ?? "stdio"}
                    {server.transport === "http" || server.transport === "sse"
                      ? ` · ${server.url ?? ""}`
                      : ` · ${server.command ?? ""} ${(server.args ?? []).join(" ")}`}
                  </code>
                </div>
              </span>
              <button type="button" className="link" onClick={() => openEditor(server, index)}>
                Edit
              </button>
              <button type="button" className="link danger" onClick={() => void remove(index)}>
                Remove
              </button>
            </div>
          </li>
        ))}
        {servers.length === 0 ? <li className="muted pad">No MCP servers configured</li> : null}
      </ul>

      <p className="section-note">Example — SearXNG web search</p>
      <pre className="tool-args pad-x">{`name: searxng
transport: stdio
command: uvx
args: mcp-searxng
env: SEARXNG_URL=http://host.docker.internal:8080`}</pre>

      {draft ? (
        <div className="sheet">
          <div className="sheet-body">
            <h2>{draftIndex === null ? "Add MCP server" : `Edit ${draft.name}`}</h2>

            <label className="field">
              Name
              <input
                value={draft.name}
                placeholder="searxng"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>

            <label className="field">
              Transport
              <select
                value={draft.transport ?? "stdio"}
                onChange={(event) =>
                  setDraft({ ...draft, transport: event.target.value as Transport })
                }
              >
                <option value="stdio">stdio (local process)</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
            </label>

            {(draft.transport ?? "stdio") === "stdio" ? (
              <>
                <label className="field">
                  Command
                  <input
                    value={draft.command ?? ""}
                    placeholder="uvx"
                    onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                  />
                </label>
                <label className="field">
                  Arguments
                  <input
                    value={argsText}
                    placeholder="mcp-searxng"
                    onChange={(event) => setArgsText(event.target.value)}
                  />
                  <span className="muted small">Space separated</span>
                </label>
              </>
            ) : (
              <label className="field">
                URL
                <input
                  value={draft.url ?? ""}
                  placeholder="https://example.com/mcp"
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                />
              </label>
            )}
          </div>

          <div className="sheet-actions">
            <button type="button" className="button ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="button"
              disabled={!draft.name.trim()}
              onClick={() => void commit()}
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
