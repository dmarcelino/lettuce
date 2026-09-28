/**
 * `POST /internal/web-tools/{search,fetch}` — what the web-tools mod calls.
 *
 * Served only to loopback clients. The BFF shares the app-server's network
 * namespace, so loopback means exactly: the app-server process (where the mod
 * runs), agent shells, and the channel gateway — all of which can reach the
 * internet directly anyway, so this adds no capability. Browsers never arrive
 * on loopback: the published port and the cloudflared tunnel both connect from
 * another address, and they get a 404 as if the route did not exist.
 *
 * Handled before Hono (see index.ts), outside the session middleware and the
 * per-user throttle: the mod has no session, and its own cap is below.
 */

import { fetchWebpage, type ToolAnswer, type WebToolsBackends, webSearch } from "./service.ts";

export const INTERNAL_PREFIX = "/internal/web-tools/";
/** Parallel tool calls from several agents at once are fine; a runaway loop is not. */
const MAX_IN_FLIGHT = 8;

export function isLoopback(address: string | null | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function json(answer: ToolAnswer, status = 200): Response {
  return new Response(JSON.stringify(answer), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let inFlight = 0;

/**
 * The response for an internal web-tools request, or null when `request` is
 * not one (the caller then routes it normally).
 */
export async function handleInternalWebTools(
  request: Request,
  clientAddress: string | null | undefined,
  backends: () => WebToolsBackends,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(INTERNAL_PREFIX)) return null;
  if (!isLoopback(clientAddress)) return new Response("Not found", { status: 404 });
  const tool = pathname.slice(INTERNAL_PREFIX.length);
  if (request.method !== "POST" || (tool !== "search" && tool !== "fetch")) {
    return new Response("Not found", { status: 404 });
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    return json(
      { text: "Too many web requests at once — try again in a moment.", isError: true },
      429,
    );
  }
  let args: Record<string, unknown>;
  try {
    const body: unknown = await request.json();
    args = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return json({ text: "The tool arguments were not valid JSON.", isError: true }, 400);
  }
  inFlight += 1;
  try {
    const answer =
      tool === "search" ? await webSearch(args, backends()) : await fetchWebpage(args, backends());
    return json(answer);
  } finally {
    inFlight -= 1;
  }
}
