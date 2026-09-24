/**
 * Response hardening for everything the BFF serves.
 *
 * The app renders agent-authored markdown and serves files the agent wrote, so
 * the origin is one XSS away from holding a session cookie with write access to
 * the agent's whole world. React's renderer already stops injected markup
 * (no `dangerouslySetInnerHTML`, no `rehype-raw`); these headers are the
 * backstop for whatever that misses — a dependency regression, a future
 * `dangerouslySetInnerHTML`, a mis-served file.
 *
 * The policy is derived from `PUBLIC_ORIGIN` rather than written by hand so the
 * WebSocket source is pinned to the host the operator declared. `'self'` does
 * cover same-origin `ws:` under CSP3, but a policy that silently fails to
 * match the socket would break the app completely, and that is not a risk worth
 * taking on a spec subtlety. Deriving it also means a host rename cannot leave
 * a stale origin behind.
 */

export interface SecurityHeaderOptions {
  /** The declared public origin, e.g. `https://letta.example.com`. */
  publicOrigin: string;
}

/** The `ws`/`wss` URL that matches `publicOrigin`. */
function websocketOrigin(publicOrigin: string): string {
  return publicOrigin.replace(/^http/, "ws");
}

/**
 * The Content-Security-Policy value.
 *
 * - `script-src 'self'` with no `unsafe-inline` and no `unsafe-eval`. The
 *   production bundle is a single hashed file and `index.html` carries no
 *   inline script, so nothing legitimate needs either.
 * - `style-src 'self' 'unsafe-inline'`. The build emits a separate stylesheet
 *   and no component in this repo sets an inline `style` attribute, so
 *   `'self'` alone would work today. The allowance is deliberate: an inline
 *   style cannot execute script, so the cost is UI defacement at worst, while
 *   a dependency that starts setting one would visibly break the layout.
 *   `script-src` is the header that matters for XSS and that one stays locked.
 * - `img-src 'self' data: blob:`. The favicon is an inline `data:` SVG and the
 *   file viewer builds `data:` URLs for images, so `data:` is load-bearing.
 * - `connect-src 'self' <ws origin>`. Covers `fetch` to the BFF plus the
 *   multiplexed socket.
 * - `worker-src 'self'`. The service worker is same-origin and registered
 *   classic.
 * - `frame-ancestors 'none'` stops clickjacking; `object-src 'none'` and
 *   `base-uri 'self'` close the two remaining injection sinks.
 */
export function contentSecurityPolicy({ publicOrigin }: SecurityHeaderOptions): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${websocketOrigin(publicOrigin)}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Headers applied to every response.
 *
 * `nosniff` matters most on the file download route: without it a browser may
 * reinterpret an `application/octet-stream` body as something executable.
 * `X-Frame-Options` is redundant next to `frame-ancestors` but costs nothing
 * and covers clients that only honour the legacy header.
 */
export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  return {
    "content-security-policy": contentSecurityPolicy(options),
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
  };
}
