/**
 * What agents currently get as native tools from the MCP side
 * (bff `/api/native-tools`): the curated Google tools the grant allows, and
 * the servers the generic MCP bridge (`mcp_search` / `mcp_call`) reaches.
 */

export interface NativeTools {
  google: string[];
  bridge: { servers: string[]; tools: number; failures: Record<string, string> };
}

export async function fetchNativeTools(): Promise<NativeTools> {
  const response = await fetch("/api/native-tools");
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response.json();
}

/** Settings → Google's line: which Google tools agents have right now. */
export function describeGoogleTools(google: readonly string[]): string {
  return google.length > 0
    ? `Agents' Google tools: ${google.join(", ")}. Writes ask for approval in Standard and Strict mode.`
    : "Agents have no Google tools right now.";
}
