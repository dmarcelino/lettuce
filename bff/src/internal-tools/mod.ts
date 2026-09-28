/**
 * Rendering a letta-code mod that registers native tools which call the BFF.
 *
 * A mod is upstream's supported way to add client tools: a file in the
 * app-server's global mods directory (`~/.letta/mods`, letta-code
 * `src/mods/mod-sources.ts`) whose default export calls
 * `letta.tools.register(...)`. Listener turns get those tools whatever the
 * toolset preference — chats, crons and channel turns alike
 * (`tools/manager.ts` `capturePreparedToolExecutionContext`). Subagents do not
 * (they run a providers-only capability profile).
 *
 * Every mod we render is the same thin shape: each tool POSTs its arguments to
 * `http://127.0.0.1:<port>/internal/tools/<name>` (loopback only, see
 * `http.ts`) and returns what the BFF answers. The work, and every change to
 * it, lives in the BFF; a mod needs a `reload` to change (`install.ts`), and
 * cannot import npm packages, so it holds as little as possible.
 */

import type { ToolSpec } from "./types.ts";

export const MODS_DIR = "/root/.letta/mods";

export function renderToolsMod(options: {
  /** First comment line — identifies the mod and its render version. */
  title: string;
  tools: readonly ToolSpec[];
  port: number;
}): string {
  const header = `// ${options.title} — rendered by the letta-code-ui BFF (bff/src/internal-tools/mod.ts).
// Edits here are overwritten on the BFF's next connect.`;
  if (options.tools.length === 0) {
    // The protocol cannot delete a file, so "no tools" is a mod that registers nothing.
    return `${header}
// No tools right now: registers nothing.
export default function activate() {}
`;
  }
  const endpoint = `http://127.0.0.1:${options.port}/internal/tools`;
  return `${header}
const ENDPOINT = ${JSON.stringify(endpoint)};
const TOOLS = ${JSON.stringify(options.tools, null, 2)};

async function callBff(tool, ctx) {
  let response;
  try {
    response = await fetch(ENDPOINT + "/" + tool, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ctx.args ?? {}),
      signal: ctx.signal,
    });
  } catch (error) {
    return { status: "error", content: "The " + tool + " tool is unreachable right now (" + (error?.message ?? error) + "). Try again shortly." };
  }
  const body = await response.json().catch(() => null);
  if (!body || typeof body.text !== "string") {
    return { status: "error", content: "The " + tool + " tool answered HTTP " + response.status + " with no result." };
  }
  return body.isError ? { status: "error", content: body.text } : body.text;
}

export default function activate(letta) {
  if (!letta.capabilities?.tools) return;
  const disposers = TOOLS.map((tool) =>
    letta.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // "ask" follows the permission mode; "auto" never prompts.
      requiresApproval: tool.approval === "ask",
      ...(tool.approval === "ask" ? { approvalPolicy: "ask" } : {}),
      parallelSafe: tool.approval !== "ask",
      run: (ctx) => callBff(tool.name, ctx),
    }),
  );
  return () => {
    for (const dispose of disposers) if (typeof dispose === "function") dispose();
  };
}
`;
}
