/**
 * The ddg-mcp sidecar (docker/ddg-mcp), used directly by the BFF: its
 * `fetch_content` is the page reader behind `fetch_webpage`, and its `search`
 * is `web_search`'s fallback. It keeps its own rate limiter, page cache and
 * browser-TLS fallback, which is why pages are fetched there rather than here.
 *
 * One MCP session per call, like `letta mcp` itself: the calls are seconds
 * apart at most, and a long-lived session would have to survive sidecar
 * restarts. The URL's host must stay `ddg-mcp:8000` — the sidecar's
 * `--allowed-hosts` DNS-rebinding guard rejects any other Host header.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface DdgToolResult {
  text: string;
  isError: boolean;
}

/** The subset of the MCP client this module uses — injectable for tests. */
export type DdgCaller = (tool: string, args: Record<string, unknown>) => Promise<DdgToolResult>;

function textOf(result: unknown): DdgToolResult {
  const record = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const blocks = Array.isArray(record.content) ? record.content : [];
  const text = blocks
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
  return { text, isError: record.isError === true };
}

export function ddgCaller(mcpUrl: string, timeoutMs = 60_000): DdgCaller {
  return async (tool, args) => {
    const client = new Client({ name: "letta-ui-web-tools", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: timeoutMs,
      });
      return textOf(result);
    } finally {
      await client.close().catch(() => {});
    }
  };
}

/** ddg-mcp's plain-text "nothing found" answer, which also covers its bot-detection case. */
export function isDdgEmpty(text: string): boolean {
  return /^No results were found/i.test(text.trim());
}

/** Whether ddg-mcp answers an MCP handshake — for Settings → Web's status line. */
export async function ddgReachable(mcpUrl: string, timeoutMs = 5_000): Promise<boolean> {
  const client = new Client({ name: "letta-ui-web-tools-probe", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  try {
    await client.connect(transport, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}
