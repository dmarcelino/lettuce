import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { Sheet } from "../components/Sheet.tsx";
import {
  base64ToBytes,
  isBinaryReadError,
  isImageFile,
  mimeTypeFor,
  saveBytes,
} from "../lib/download.ts";
import { agentWorkspace, WORKSPACE_ROOT } from "../lib/workspace.ts";
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

/**
 * get_tree returns paths relative to its root; every other command wants
 * absolute. Normalising here matters: the previous version stripped a trailing
 * slash, which turned a root of "/" into "" and produced root-relative paths
 * like "/agent-local-…" that the workspace clamp then (correctly) refused.
 */
export function resolve(root: string, relative: string): string {
  if (relative.startsWith("/")) return relative;
  const base = root === "/" ? "" : root.replace(/\/+$/, "");
  return `${base}/${relative}`.replace(/\/{2,}/g, "/");
}

/**
 * The directory above `path`, or null at the workspace root.
 *
 * Clamped deliberately: without a floor this walked to "/", which the BFF
 * refuses — leaving the previous listing on screen with no way back down.
 */
export function parentDirectory(path: string): string | null {
  if (path === WORKSPACE_ROOT || !path.startsWith(`${WORKSPACE_ROOT}/`)) return null;
  const parent = path.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
  return parent.length >= WORKSPACE_ROOT.length ? parent : WORKSPACE_ROOT;
}

interface Props {
  session: SessionApi;
  /** Working directory of the active runtime; the tree is rooted here. */
  cwd: string | null;
  /** Fallback root before the first device status arrives. */
  agentId: string | null;
}

export function FilesTab({ session, cwd, agentId }: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  /** Data URL of an image preview, when the open file is one. */
  const [image, setImage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<GrepMatch[] | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (root) return;
    // Prefer the runtime's reported cwd, but fall back to the agent's own
    // directory so the tab is usable before the first device status frame.
    const initial = cwd ?? (agentId ? agentWorkspace(agentId) : null);
    if (initial) setRoot(initial);
  }, [cwd, agentId, root]);

  /**
   * Drop everything tied to the directory we failed to open. Entries are
   * RELATIVE names; leaving them on screen after a failure meant the next click
   * joined them onto a root they never belonged to.
   */
  const failed = useCallback((message: string) => {
    setStatus(message);
    setEntries([]);
    setMatches(null);
    setSelected(null);
    setContent(null);
    setImage(null);
  }, []);

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
          failed(response.error ?? "Failed to list directory");
          return;
        }
        setEntries(response?.entries ?? []);
        setStatus("");
      } catch (cause) {
        failed(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [session, failed],
  );

  useEffect(() => {
    if (root) void load(root);
  }, [root, load]);

  const basename = (path: string) => path.split("/").pop() || path;

  interface ReadResponse {
    content?: string | null;
    success?: boolean;
    error?: string;
  }

  /**
   * Pull a file down as bytes.
   *
   * Always base64 — that is the only encoding that survives a docx or a pdf
   * intact, and the app-server offers it precisely so a web client can do this.
   * A refusal (missing file, or the 25MB base64 cap upstream) arrives as
   * `success: false` and goes to the status line rather than being swallowed.
   */
  const downloadFile = async (path: string) => {
    const name = basename(path);
    setStatus(`Downloading ${name}…`);
    try {
      const response = await session.request<ReadResponse>("read_file", {
        path,
        encoding: "base64",
      });
      if (response?.success === false || typeof response?.content !== "string") {
        setStatus(response?.error ?? "Failed to read file");
        return;
      }
      saveBytes(name, base64ToBytes(response.content), mimeTypeFor(name));
      setStatus("");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /**
   * Open a file, guessing from its name what it is — because nothing else can
   * say. `get_tree` reports `{path, type}` and no protocol command reports a
   * size or a mime type, so an image is recognised by extension and everything
   * else is tried as text first.
   *
   * A text read that fails on strict UTF-8 means the file is binary, and the
   * thing the user wanted was the file: download it instead of leaving them on
   * an error, which is all this tab could do before.
   */
  const openFile = async (path: string) => {
    const name = basename(path);

    if (isImageFile(name)) {
      setSelected(path);
      setContent(null);
      setImage(null);
      setStatus("Loading image…");
      try {
        const response = await session.request<ReadResponse>("read_file", {
          path,
          encoding: "base64",
        });
        if (response?.success === false || typeof response?.content !== "string") {
          setStatus(response?.error ?? "Failed to read file");
          setSelected(null);
          return;
        }
        setImage(`data:${mimeTypeFor(name)};base64,${response.content}`);
        setStatus("");
      } catch (cause) {
        setStatus(cause instanceof Error ? cause.message : String(cause));
        setSelected(null);
      }
      return;
    }

    setSelected(path);
    setContent(null);
    setImage(null);
    setStatus("Loading file…");
    try {
      const response = await session.request<ReadResponse>("read_file", {
        path,
        encoding: "utf8",
      });
      if (response?.success === false) {
        const error = response.error ?? "Failed to read file";
        if (isBinaryReadError(error)) {
          setSelected(null);
          await downloadFile(path);
          return;
        }
        setStatus(error);
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

  const parent = root ? parentDirectory(root) : null;

  if (!root) {
    return (
      <div className="pane">
        <p className="muted">Start a conversation to browse its working directory.</p>
      </div>
    );
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
          <Icon name="up" /> Up
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
          {entries.map((entry) => {
            const absolute = resolve(root, entry.path);
            return (
              <li key={entry.path} className="file-row">
                {/* Name and download are siblings, not nested: a button cannot
                    contain a button, which is why the whole row used to be one. */}
                <button
                  type="button"
                  className="row grow-row"
                  onClick={() => {
                    if (entry.type === "dir") setRoot(absolute);
                    else void openFile(absolute);
                  }}
                >
                  <Icon name={entry.type === "dir" ? "folder" : "file"} />
                  {entry.path}
                </button>
                {/* Directories have nothing to hand over: there is no archive
                    command in the protocol, so ask the agent to tar one. */}
                {entry.type === "file" ? (
                  <button
                    type="button"
                    className="icon-button ghost"
                    title={`Download ${entry.path}`}
                    aria-label={`Download ${entry.path}`}
                    onClick={() => void downloadFile(absolute)}
                  >
                    <Icon name="download" />
                  </button>
                ) : null}
              </li>
            );
          })}
          {entries.length === 0 && !status ? <li className="muted pad">Empty</li> : null}
        </ul>
      )}

      {selected && (content !== null || image !== null) ? (
        <Sheet
          title={basename(selected)}
          onClose={() => setSelected(null)}
          actions={
            <>
              <button type="button" className="button" onClick={() => void downloadFile(selected)}>
                Download
              </button>
              <button type="button" className="button ghost" onClick={() => setSelected(null)}>
                Close
              </button>
            </>
          }
        >
          {image !== null ? (
            <img className="file-preview" src={image} alt={basename(selected)} />
          ) : (
            <pre className="tool-args">{content}</pre>
          )}
        </Sheet>
      ) : null}
    </div>
  );
}
