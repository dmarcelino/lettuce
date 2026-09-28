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

/**
 * Google refusing the sign-in itself. Only these: workspace-mcp appends "You
 * might need to re-authenticate. LLM: Try 'start_google_auth'" to *every* 403,
 * so that hint says nothing — matching it marked access lost on prod when the
 * real error was a Cloud project with the Calendar and Tasks APIs switched off.
 */
const AUTH_FAILURE = [/invalid_grant/i, /Token Expired\/Revoked/i, /No valid credentials/i];

export function isGoogleAuthFailure(text: string): boolean {
  return AUTH_FAILURE.some((pattern) => pattern.test(text));
}

/** workspace-mcp's advice to run a tool agents do not have, whatever the error. */
const START_AUTH_HINT =
  /\s*You might need to re-authenticate\.?\s*(LLM:\s*)?Try 'start_google_auth'[^\n]*/gi;

/** The consent screen's API library ids, for a link straight to the switch. */
const API_IDS: Record<string, string> = {
  "Gmail API": "gmail.googleapis.com",
  "Google Calendar API": "calendar-json.googleapis.com",
  "Google Tasks API": "tasks.googleapis.com",
};

export interface DisabledApi {
  name: string;
  project: string | null;
  enableUrl: string;
}

/**
 * Google's 403 `accessNotConfigured`: the API is switched off in the Cloud
 * project that owns the OAuth client. The sign-in is fine; reconnecting does
 * nothing. Two phrasings seen on prod: workspace-mcp's own ("Google Calendar
 * API is not enabled for your project (N)") and Google's ("Google Tasks API has
 * not been used in project N before or it is disabled").
 */
export function disabledApi(text: string): DisabledApi | null {
  const match =
    /((?:Google )?[A-Z][A-Za-z]+ API) is not enabled for your project(?: \((\d+)\))?/.exec(text) ??
    /((?:Google )?[A-Z][A-Za-z]+ API) has not been used in project (\d+) before or it is disabled/.exec(
      text,
    );
  if (!match && !/accessNotConfigured/.test(text)) return null;
  const name = match?.[1] ?? "Google API";
  const project = match?.[2] ?? /project[= ](\d+)/.exec(text)?.[1] ?? null;
  const id = API_IDS[name];
  const query = project ? `?project=${project}` : "";
  const enableUrl = id
    ? `https://console.cloud.google.com/apis/library/${id}${query}`
    : `https://console.cloud.google.com/apis/library${query}`;
  return { name, project, enableUrl };
}

export function disabledApiMessage(api: DisabledApi): string {
  return [
    `Google refused this because the ${api.name} is switched off in the Google Cloud project that ` +
      `owns this app's OAuth client${api.project ? ` (project ${api.project})` : ""}. The sign-in ` +
      "is fine: do not ask the user to reconnect, do not look for start_google_auth, do not retry.",
    `Tell the user to enable it here, wait a few minutes, then ask again: ${api.enableUrl}`,
  ].join("\n");
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

/**
 * The answer to give instead of a Google error `text`, or null to pass it on
 * as it is: a lost sign-in (recorded, and the user sent to reconnect), an API
 * switched off in the Cloud project, or anything else with workspace-mcp's
 * misleading `start_google_auth` advice cut out.
 */
export async function googleErrorAnswer(
  port: LostAccessPort,
  text: string,
): Promise<ToolAnswer | null> {
  const api = disabledApi(text);
  if (api) return { text: disabledApiMessage(api), isError: true };
  if (isGoogleAuthFailure(text)) {
    const firstLine = text.split("\n", 1)[0]?.slice(0, 200) ?? "";
    const account = await port.markLost(firstLine).catch(() => null);
    return { text: lostAccessMessage(account?.email ?? null, port.publicOrigin), isError: true };
  }
  const stripped = text.replace(START_AUTH_HINT, "");
  return stripped === text ? null : { text: stripped, isError: true };
}
