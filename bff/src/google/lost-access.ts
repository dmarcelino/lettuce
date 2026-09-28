/**
 * When Google stops accepting the saved sign-in (revoked, expired, a password
 * change), every Google call fails with workspace-mcp's own text — which tells
 * the agent to run `start_google_auth`, a tool deliberately removed (any agent
 * could mint a consent link with it). A model then goes hunting for it and
 * gives up. This turns that failure into what is actually true: the user has
 * to reconnect, here is the link, and records the loss so Settings → Google
 * says so too.
 */
import type { ToolAnswer } from "../internal-tools/types.ts";

/** workspace-mcp's auth failures, and Google's own refresh refusal inside them. */
const AUTH_FAILURE = [
  /invalid_grant/i,
  /Token Expired\/Revoked/i,
  /Authentication Required/i,
  /start_google_auth/i,
  /No valid credentials/i,
];

export function isGoogleAuthFailure(text: string): boolean {
  return AUTH_FAILURE.some((pattern) => pattern.test(text));
}

/** One click to Google's consent screen, through the signed-in app. */
export function reconnectUrl(publicOrigin: string): string {
  return `${publicOrigin}/api/google/reconnect`;
}

/** The app with Settings → Google open. */
export function googleSettingsUrl(publicOrigin: string): string {
  return `${publicOrigin}/?settings=google`;
}

export function lostAccessMessage(email: string | null, publicOrigin: string): string {
  return [
    `Google access has stopped working${email ? ` for ${email}` : ""}: Google no longer accepts ` +
      "the saved sign-in (it expired or was revoked). Gmail, Calendar and Tasks will fail until " +
      "the user reconnects.",
    "You cannot fix this yourself: agents have no sign-in tool, by design. Do not look for " +
      "start_google_auth and do not retry.",
    "Tell the user, and give them this link — it opens Google's sign-in directly:",
    reconnectUrl(publicOrigin),
    `(or Settings → Google in the app: ${googleSettingsUrl(publicOrigin)})`,
  ].join("\n");
}

export interface LostAccessPort {
  publicOrigin: string;
  /** Record the loss; the account it was, or null when nothing is connected. */
  markLost(why: string): Promise<{ email: string } | null>;
}

/** The answer to give instead of `text`, or null when `text` is not an auth failure. */
export async function lostAccessAnswer(
  port: LostAccessPort,
  text: string,
): Promise<ToolAnswer | null> {
  if (!isGoogleAuthFailure(text)) return null;
  const firstLine = text.split("\n", 1)[0]?.slice(0, 200) ?? "";
  const account = await port.markLost(firstLine).catch(() => null);
  return { text: lostAccessMessage(account?.email ?? null, port.publicOrigin), isError: true };
}
