/**
 * Per-turn structured (JSON-schema) output.
 *
 * letta-code 0.32.19 added `response_format` to the `create_message` payload
 * and advertises it as the `structured_outputs` capability. The listener
 * validates the shape itself (`websocket/listener/structured-output.ts`) and
 * rejects anything else, so we mirror that check here: a bad schema should be
 * an inline composer message before the turn is sent, not a failed send after.
 *
 * The last-used schema is remembered per conversation the same way the composer
 * remembers a draft — it is a convenience, so every storage path degrades to
 * "nothing remembered" rather than raising. See `./storage.ts`.
 */
import { defaultStorage, type MaybeStorage } from "./storage.ts";

const KEY = "letta-ui:structured-output";
const MAX_ENTRIES = 20;

/** The wire shape `response_format` must have for the listener to accept it. */
export interface ResponseFormat {
  type: "json_schema";
  json_schema: { schema: Record<string, unknown> };
}

/** Why this is not a valid `response_format`, or null when it is. */
export function validateResponseFormat(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "response_format must be a JSON object";
  }
  const format = value as Record<string, unknown>;
  if (format.type !== "json_schema") {
    return 'response_format.type must be "json_schema"';
  }
  const wrapper = format.json_schema;
  if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) {
    return "response_format.json_schema must be a JSON object";
  }
  const schema = (wrapper as Record<string, unknown>).schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return "response_format.json_schema.schema must be a JSON object";
  }
  return null;
}

/**
 * Parse the textarea contents into a `response_format`.
 *
 * Accepts either the full envelope or a bare JSON Schema, which is what people
 * actually have on hand; a bare schema is wrapped. Anything else comes back as
 * an error string so the sheet can show it instead of enabling the toggle.
 */
export function parseResponseFormat(text: string): {
  value: ResponseFormat | null;
  error: string | null;
} {
  const trimmed = text.trim();
  if (!trimmed) return { value: null, error: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    return {
      value: null,
      error: `Invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  // Keyed on `json_schema`, not `type`: a bare JSON Schema almost always has
  // a `type` of its own ("object", "array"), so testing for `type` would
  // mistake every bare schema for an already-wrapped envelope.
  const isEnvelope =
    !!parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "json_schema" in (parsed as Record<string, unknown>);

  const candidate = isEnvelope ? parsed : { type: "json_schema", json_schema: { schema: parsed } };

  const error = validateResponseFormat(candidate);
  if (error) return { value: null, error };
  return { value: candidate as ResponseFormat, error: null };
}

/** Render a stored format back into the textarea: the bare schema, not the envelope. */
export function schemaText(format: ResponseFormat | null): string {
  if (!format) return "";
  const schema = format.json_schema.schema;
  try {
    return JSON.stringify(schema, null, 2);
  } catch {
    return "";
  }
}

/** What the composer remembers about structured output for one conversation. */
export interface StructuredOutputPreference {
  /** The schema text as typed (bare schema, pretty-printed). "" when unset. */
  text: string;
  /** Whether the next turn should send it. */
  enabled: boolean;
}

const OFF: StructuredOutputPreference = { text: "", enabled: false };

interface FormatStore {
  order: string[];
  formats: Record<string, StructuredOutputPreference>;
}

const EMPTY_STORE: FormatStore = { order: [], formats: {} };

function readStore(storage: MaybeStorage): FormatStore {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return EMPTY_STORE;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY_STORE;
    const record = parsed as { order?: unknown; formats?: unknown };
    const formats: Record<string, StructuredOutputPreference> = {};
    if (record.formats && typeof record.formats === "object") {
      for (const [key, value] of Object.entries(record.formats as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const entry = value as { text?: unknown; enabled?: unknown };
        if (typeof entry.text !== "string") continue;
        formats[key] = { text: entry.text, enabled: entry.enabled === true };
      }
    }
    const order = Array.isArray(record.order)
      ? record.order.filter((k): k is string => typeof k === "string" && k in formats)
      : Object.keys(formats);
    return { order, formats };
  } catch {
    return EMPTY_STORE;
  }
}

function writeStore(storage: MaybeStorage, store: FormatStore): void {
  try {
    storage?.setItem(KEY, JSON.stringify(store));
  } catch {
    // Quota or disabled storage: the schema is a convenience, not state we need.
  }
}

/** The remembered structured-output preference for one conversation key. */
export function readStructuredOutput(
  conversationKey: string | null,
  storage = defaultStorage(),
): StructuredOutputPreference {
  if (!conversationKey) return OFF;
  return readStore(storage).formats[conversationKey] ?? OFF;
}

/** Remember it, bounded to the newest entries. */
export function writeStructuredOutput(
  conversationKey: string | null,
  preference: StructuredOutputPreference,
  storage = defaultStorage(),
): void {
  if (!conversationKey) return;
  const store = readStore(storage);
  const order = store.order.filter((key) => key !== conversationKey);
  order.push(conversationKey);
  while (order.length > MAX_ENTRIES) {
    const dropped = order.shift();
    if (dropped) delete store.formats[dropped];
  }
  writeStore(storage, { order, formats: { ...store.formats, [conversationKey]: preference } });
}
