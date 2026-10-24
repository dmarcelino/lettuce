/**
 * The search half of `web_search`: SearXNG's JSON API (docker/searxng). A
 * private instance with JSON on and the limiter off — the BFF is its only
 * client — so a plain GET is all it takes.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Which engines returned it — more engines agreeing is a mild quality signal. */
  engines: string[];
  publishedDate: string | null;
}

export interface SearxngSearchResponse {
  results: SearchResult[];
  /** Engines that failed this query, with SearXNG's reason ("CAPTCHA", "timeout", …). */
  unresponsive: { engine: string; reason: string }[];
  /** No results because every engine failed, not because nothing matched. */
  blocked: boolean;
}

export const TIME_RANGES = ["day", "week", "month", "year"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

export interface SearxngQuery {
  query: string;
  count: number;
  timeRange?: TimeRange | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** SearXNG's raw JSON → our shape. Exported for tests; tolerant of missing fields. */
export function normalizeSearxng(raw: unknown, count: number): SearxngSearchResponse {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const item of Array.isArray(record.results) ? record.results : []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const url = text(entry.url);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: text(entry.title) || url,
      url,
      snippet: text(entry.content),
      engines: Array.isArray(entry.engines)
        ? entry.engines.filter((e): e is string => typeof e === "string")
        : [],
      publishedDate: text(entry.publishedDate) || null,
    });
    if (results.length >= count) break;
  }
  const unresponsive = (
    Array.isArray(record.unresponsive_engines) ? record.unresponsive_engines : []
  )
    .filter((pair): pair is unknown[] => Array.isArray(pair))
    .map((pair) => ({ engine: text(pair[0]), reason: text(pair[1]) }))
    .filter((pair) => pair.engine);
  return { results, unresponsive, blocked: results.length === 0 && unresponsive.length > 0 };
}

export async function searxngSearch(
  baseUrl: string,
  query: SearxngQuery,
  options: { fetch?: FetchLike; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SearxngSearchResponse> {
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");
  if (query.timeRange) url.searchParams.set("time_range", query.timeRange);
  const response = await (options.fetch ?? fetch)(url.toString(), {
    headers: { accept: "application/json" },
    signal: combineSignals(options.timeoutMs ?? 15_000, options.signal),
  });
  if (!response.ok) throw new Error(`SearXNG answered HTTP ${response.status}`);
  return normalizeSearxng(await response.json(), query.count);
}

/**
 * The call's own timeout, plus the caller's cancellation when it has one.
 * `AbortSignal.timeout` alone used to run a search to its full 15 s after the
 * turn that asked for it was already cancelled (0.34.19 aborts in-flight tool
 * executions upstream, and the mod forwards that signal).
 */
function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (signal.aborted) return signal;
  const anySignal = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  // No AbortSignal.any (older runtime): the timeout still bounds the call.
  return anySignal ? anySignal([timeout, signal]) : timeout;
}
