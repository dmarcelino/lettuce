import { useCallback, useEffect, useState } from "react";
import {
  describeWebToolsStatus,
  fetchWebToolsEnabled,
  fetchWebToolsStatus,
  saveWebToolsEnabled,
  testWebSearch,
  type WebToolsStatus,
  type WebToolsTestAnswer,
} from "../lib/web-tools.ts";
import { ToggleRow } from "./MenuRow.tsx";

/**
 * Settings → Web: every agent's native `web_search` and `fetch_webpage`
 * tools — a letta-code mod the BFF installs, backed by the SearXNG and
 * DuckDuckGo sidecars (bff/src/web-tools/). The switch applies from the next
 * turn; a test search proves the backends answer without starting one.
 */
export function WebToolsSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [status, setStatus] = useState<WebToolsStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<WebToolsTestAnswer | null>(null);

  const load = useCallback(async () => {
    try {
      const [on, current] = await Promise.all([fetchWebToolsEnabled(), fetchWebToolsStatus()]);
      setEnabled(on);
      setStatus(current);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const saved = await saveWebToolsEnabled(next);
      setEnabled(saved.enabled);
      setMessage(
        saved.pending
          ? "Saved. Takes effect once an agent exists."
          : saved.enabled
            ? "On. Agents have web_search and fetch_webpage from their next turn."
            : "Off. Agents lose web_search and fetch_webpage from their next turn.",
      );
      setStatus(await fetchWebToolsStatus());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setAnswer(null);
    try {
      setAnswer(await testWebSearch(query.trim()));
    } catch (error) {
      setAnswer({ text: error instanceof Error ? error.message : String(error), isError: true });
    } finally {
      setBusy(false);
    }
  };

  if (enabled === null) {
    return (
      <>
        {message ? (
          <p className="small bad pad">{message}</p>
        ) : (
          <p className="muted pad">Loading…</p>
        )}
        <div className="pad-x">
          <button type="button" className="button ghost" onClick={() => void load()}>
            Reload
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="muted small pad">
        Gives every agent two tools, <code>web_search</code> and <code>fetch_webpage</code>, in
        chats, crons and Telegram alike. Searches go to the SearXNG sidecar, falling back to
        DuckDuckGo; pages are read through DuckDuckGo&apos;s fetcher. Nothing leaves this server
        except the searches and page requests themselves. Subagents do not get these tools.
      </p>

      <div className="pad-x">
        <ToggleRow
          title="Native web search and page reading"
          description="Off removes both tools from every agent's next turn"
          checked={enabled}
          disabled={busy}
          onChange={(next) => void toggle(next)}
        />
      </div>

      {message ? <p className="muted small pad">{message}</p> : null}
      {status ? <p className="small pad">{describeWebToolsStatus(status)}</p> : null}
      {status && !status.modInstalled ? (
        <p className="warning small">
          The tools are not installed in the app-server yet — they are written on the BFF&apos;s
          next connection to it.
        </p>
      ) : null}
      {status && status.modErrors.length > 0 ? (
        <p className="warning small">Loading the tools failed: {status.modErrors.join("; ")}</p>
      ) : null}

      <p className="section-note">Try a search</p>
      <div className="pad-x">
        <label className="field">
          Query
          <input
            value={query}
            placeholder="weather in Redmond tomorrow"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runTest();
            }}
          />
          <span className="muted small">The same search an agent&apos;s web_search runs.</span>
        </label>
        <div className="button-row">
          <button
            type="button"
            className="button"
            disabled={busy || !query.trim()}
            onClick={() => void runTest()}
          >
            Search
          </button>
          <button
            type="button"
            className="button ghost"
            disabled={busy}
            onClick={() => void load()}
          >
            Refresh status
          </button>
        </div>
      </div>
      {answer ? (
        <pre className={`tool-args pad-x${answer.isError ? " bad" : ""}`}>{answer.text}</pre>
      ) : null}
    </>
  );
}
