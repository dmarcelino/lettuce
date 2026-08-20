import { useCallback, useEffect, useState } from "react";
import type { SessionApi } from "../state/use-session.ts";

interface TreeEntry {
  /** Relative to the requested root, not absolute. */
  path: string;
  type: "file" | "dir";
}

interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/** get_tree returns paths relative to its root; every other command wants absolute. */
function resolve(root: string, relative: string): string {
  return `${root.replace(/\/$/, "")}/${relative}`;
}

interface Props {
  session: SessionApi;
  /** Working directory of the active runtime; the tree is rooted here. */
  cwd: string | null;
}

export function FilesTab({ session, cwd }: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<GrepMatch[] | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (cwd && !root) setRoot(cwd);
  }, [cwd, root]);

  const load = useCallback(
    async (path: string) => {
      setStatus("Loading…");
      try {
        const response = await session.request<{
          entries?: TreeEntry[];
          success?: boolean;
          error?: string;
        }>("get_tree", { path, depth: 1 });
        if (response?.success === false) {
          setStatus(response.error ?? "Failed to list directory");
          return;
        }
        setEntries(response?.entries ?? []);
        setStatus("");
      } catch (cause) {
        setStatus(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [session],
  );

  useEffect(() => {
    if (root) void load(root);
  }, [root, load]);

  const openFile = async (path: string) => {
    setSelected(path);
    setContent(null);
    setStatus("Loading file…");
    try {
      const response = await session.request<{
        content?: string | null;
        success?: boolean;
        error?: string;
      }>("read_file", { path, encoding: "utf8" });
      if (response?.success === false) {
        setStatus(response.error ?? "Failed to read file");
        return;
      }
      setContent(response?.content ?? "");
      setStatus("");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const search = async () => {
    if (!root || !query.trim()) {
      setMatches(null);
      return;
    }
    setStatus("Searching…");
    try {
      // The parameter is `query`; sending `pattern` fails validation silently.
      const response = await session.request<{
        matches?: GrepMatch[];
        total_matches?: number;
        success?: boolean;
        error?: string;
      }>("grep_in_files", { query, cwd: root, max_results: 200 });
      if (response?.success === false) {
        setStatus(response.error ?? "Search failed");
        return;
      }
      setMatches(response?.matches ?? []);
      setStatus("");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const parent = root && root !== "/" ? root.replace(/\/[^/]+\/?$/, "") || "/" : null;

  if (!root) {
    return <div className="pane"><p className="muted">Start a conversation to browse its working directory.</p></div>;
  }

  return (
    <div className="pane">
      <div className="pane-bar">
        <button
          type="button"
          className="link"
          disabled={!parent}
          onClick={() => parent && setRoot(parent)}
        >
          ↑ Up
        </button>
        <code className="path">{root}</code>
      </div>

      <div className="pane-bar">
        <input
          value={query}
          placeholder="Search file contents…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void search();
          }}
        />
        <button type="button" className="link" onClick={() => void search()}>
          Find
        </button>
        {matches ? (
          <button type="button" className="link" onClick={() => setMatches(null)}>
            Clear
          </button>
        ) : null}
      </div>

      {status ? <p className="muted small pad">{status}</p> : null}

      {matches ? (
        <ul className="list">
          {matches.length === 0 ? <li className="muted pad">No matches</li> : null}
          {matches.map((match, index) => (
            <li key={`${match.path}:${match.line}:${index}`}>
              <button
                type="button"
                className="row"
                onClick={() => void openFile(resolve(root, match.path))}
              >
                <span className="grow-text">
                  <code className="small">
                    {match.path}:{match.line}
                  </code>
                  <div className="muted small match-text">{match.text.trim()}</div>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="list">
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className="row"
                onClick={() => {
                  const absolute = resolve(root, entry.path);
                  if (entry.type === "dir") setRoot(absolute);
                  else void openFile(absolute);
                }}
              >
                <span className="icon">{entry.type === "dir" ? "📁" : "📄"}</span>
                {entry.path}
              </button>
            </li>
          ))}
          {entries.length === 0 && !status ? <li className="muted pad">Empty</li> : null}
        </ul>
      )}

      {selected && content !== null ? (
        <div className="sheet" onClick={() => setSelected(null)}>
          <div className="sheet-body" onClick={(event) => event.stopPropagation()}>
            <h2>{selected.split("/").pop()}</h2>
            <pre className="tool-args">{content}</pre>
          </div>
          <div className="sheet-actions">
            <button type="button" className="button ghost" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
