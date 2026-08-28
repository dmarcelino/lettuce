import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { Sheet } from "../components/Sheet.tsx";
import type { SessionApi } from "../state/use-session.ts";

interface MemoryEntry {
  relative_path: string;
  is_system: boolean;
  description: string | null;
  content: string;
  size: number;
}

interface Commit {
  sha: string;
  message: string;
  timestamp: string;
  author_name: string | null;
}

interface Props {
  session: SessionApi;
  agentId: string | null;
}

export function MemoryTab({ session, agentId }: Props) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [open, setOpen] = useState<MemoryEntry | null>(null);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<Commit[] | null>(null);
  const [status, setStatus] = useState("");
  const [memfs, setMemfs] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    if (!agentId) return;
    setStatus("Loading memory…");
    try {
      const response = await session.request<{
        entries?: MemoryEntry[];
        success?: boolean;
        error?: string;
        memfs_enabled?: boolean;
      }>("list_memory", { agent_id: agentId });
      if (response?.success === false) {
        setStatus(response.error ?? "Failed to list memory");
        return;
      }
      setEntries(response?.entries ?? []);
      setMemfs(response?.memfs_enabled ?? null);
      setStatus("");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }, [agentId, session.request]);

  useEffect(() => {
    if (session.ready && agentId) void load();
  }, [session.ready, agentId, load]);

  // Memory changes as the agent works; refresh when it says so.
  useEffect(
    () =>
      session.onFrame((frame) => {
        if ((frame as { type?: unknown }).type === "memory_updated") void load();
      }),
    [session.onFrame, load],
  );

  const save = async () => {
    if (!agentId || !open) return;
    setStatus("Saving…");
    try {
      const response = await session.request<{ success?: boolean; error?: string }>(
        "write_memory_file",
        { agent_id: agentId, path: open.relative_path, content: draft },
      );
      if (response?.success === false) {
        setStatus(response.error ?? "Save failed");
        return;
      }
      setOpen(null);
      await load();
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const loadHistory = async (path: string) => {
    if (!agentId) return;
    setStatus("Loading history…");
    try {
      const response = await session.request<{ commits?: Commit[]; error?: string }>(
        "memory_history",
        { agent_id: agentId, file_path: path, limit: 30 },
      );
      setHistory(response?.commits ?? []);
      setStatus("");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (!agentId) {
    return (
      <div className="pane">
        <p className="muted pad">Select an agent.</p>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="pane-bar">
        <button type="button" className="link" onClick={() => void load()}>
          <Icon name="refresh" /> Refresh
        </button>
        {memfs === false ? <span className="tag">MemFS off</span> : null}
        <span className="spacer" />
        <span className="muted small">{entries.length} blocks</span>
      </div>

      {status ? <p className="muted small pad">{status}</p> : null}

      <ul className="list">
        {entries.map((entry) => (
          <li key={entry.relative_path}>
            <button
              type="button"
              className="row"
              onClick={() => {
                setOpen(entry);
                setDraft(entry.content);
                setHistory(null);
              }}
            >
              <Icon name={entry.is_system ? "settings" : "memory"} />
              <span className="grow-text">
                <strong>{entry.relative_path}</strong>
                {entry.description ? <em className="muted"> — {entry.description}</em> : null}
              </span>
              <span className="muted small">{entry.size}</span>
            </button>
          </li>
        ))}
        {entries.length === 0 && !status ? <li className="muted pad">No memory blocks</li> : null}
      </ul>

      {open ? (
        <Sheet
          title={open.relative_path}
          size="document"
          onClose={() => setOpen(null)}
          actions={
            <>
              <button type="button" className="button ghost" onClick={() => setOpen(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button"
                disabled={draft === open.content}
                onClick={() => void save()}
              >
                Save
              </button>
            </>
          }
        >
          {open.is_system ? <p className="muted small">System block — edit with care.</p> : null}

          <textarea
            className="memory-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />

          <button
            type="button"
            className="link"
            onClick={() => void loadHistory(open.relative_path)}
          >
            History
          </button>

          {history ? (
            <ul className="list compact">
              {history.map((commit) => (
                <li key={commit.sha}>
                  <span className="muted small">
                    {new Date(commit.timestamp).toLocaleString()} · {commit.sha.slice(0, 7)}
                  </span>
                  <div>{commit.message}</div>
                </li>
              ))}
              {history.length === 0 ? <li className="muted pad">No history</li> : null}
            </ul>
          ) : null}
        </Sheet>
      ) : null}
    </div>
  );
}
