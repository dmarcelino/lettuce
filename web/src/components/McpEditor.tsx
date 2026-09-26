import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { useBackToClose } from "../state/use-back-to-close.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Icon } from "./Icon.tsx";

/**
 * MCP servers are absent from the app-server protocol: they live in
 * ~/.letta/settings.json under the agent's own entry. The browser may READ
 * that file but cannot WRITE it — an mcpServers entry is an arbitrary command
 * line the app-server execs as root — so reads and writes go through the BFF's
 * /api/mcp routes, which merge the agent's entry server-side and issue the
 * `reload` that makes the change take effect.
 */
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

const BLANK: McpServer = { name: "", transport: "stdio", command: "", args: [] };

export function McpEditor({ session, agentId }: { session: SessionApi; agentId: string | null }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState<McpServer | null>(null);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [argsText, setArgsText] = useState("");
  // Back cancels the add/edit dialog rather than leaving the app.
  useBackToClose(() => {
    setDraft(null);
    setDraftIndex(null);
  }, draft !== null);

  const load = useCallback(async () => {
    if (!agentId) return;
    setStatus("Loading settings…");
    try {
      const response = await fetch(`/api/mcp?agent_id=${encodeURIComponent(agentId)}`);
      if (!response.ok) {
        setStatus((await response.text()) || "Could not read MCP settings");
        return;
      }
      const body = (await response.json()) as { servers?: McpServer[] };
      setServers(Array.isArray(body.servers) ? body.servers : []);
      setStatus("");
    } catch (cause) {
      setStatus(errorMessage(cause));
    }
  }, [agentId]);

  useEffect(() => {
    if (session.ready && agentId) void load();
  }, [session.ready, agentId, load]);

  const persist = async (next: McpServer[]) => {
    if (!agentId) return;
    setStatus("Saving…");
    try {
      const response = await fetch("/api/mcp", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, servers: next }),
      });
      if (!response.ok) {
        setStatus((await response.text()) || "Save failed");
        return;
      }
      const body = (await response.json()) as { servers?: McpServer[] };
      setServers(Array.isArray(body.servers) ? body.servers : next);
      setStatus("Saved. The agent is reloading its tools.");
    } catch (cause) {
      setStatus(errorMessage(cause));
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
          <Icon name="plus" /> Add server
        </button>
        <button
          type="button"
          className="link"
          onClick={() => void load()}
          title="Reload MCP servers"
          aria-label="Reload MCP servers"
        >
          <Icon name="refresh" />
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
          <div className="sheet-panel sheet-compact" role="dialog" aria-modal="true">
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
        </div>
      ) : null}
    </>
  );
}
