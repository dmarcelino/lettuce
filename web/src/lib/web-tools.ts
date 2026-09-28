/**
 * Settings → Web: the agents' native `web_search` / `fetch_webpage` tools
 * (bff/src/web-tools/). The switch applies at once: the BFF rewrites the mod
 * and reloads the app-server's mods, so the next turn has (or lacks) them.
 */

export interface WebToolsStatus {
  searxng: "up" | "down" | "off";
  ddg: "up" | "down" | "off";
  modErrors: string[];
  modInstalled: boolean;
}

export interface WebToolsTestAnswer {
  text: string;
  isError: boolean;
}

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response;
}

export async function fetchWebToolsEnabled(): Promise<boolean> {
  const body = (await (await ok(await fetch("/api/web-tools/settings"))).json()) as {
    settings: { enabled: boolean };
  };
  return body.settings.enabled;
}

/** Returns whether the change is live, or waits for an agent to exist before it can reload. */
export async function saveWebToolsEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean; pending: boolean }> {
  const response = await ok(
    await fetch("/api/web-tools/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  );
  const body = (await response.json()) as { settings: { enabled: boolean }; mod: string };
  return { enabled: body.settings.enabled, pending: body.mod === "reload-pending" };
}

export async function fetchWebToolsStatus(): Promise<WebToolsStatus> {
  return (await ok(await fetch("/api/web-tools/status"))).json();
}

export async function testWebSearch(query: string): Promise<WebToolsTestAnswer> {
  const response = await ok(
    await fetch("/api/web-tools/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  );
  return response.json();
}

/** One line for the status: which backends answer, in the user's words. */
export function describeWebToolsStatus(status: WebToolsStatus): string {
  const word = (state: WebToolsStatus["searxng"]) =>
    state === "up" ? "answering" : state === "down" ? "not answering" : "switched off";
  return `Search (SearXNG): ${word(status.searxng)} · Pages and search fallback (DuckDuckGo): ${word(status.ddg)}`;
}
