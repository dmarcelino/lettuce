/**
 * Whether `/api/files/download?inline=1` may serve a file with its real
 * content-type and `Content-Disposition: inline`, so a chat-message link opens
 * it in the browser tab to be read.
 *
 * The allowlist is deliberately just PDFs and raster images. Serving
 * agent-authored HTML or SVG inline from the BFF's own origin would run its
 * scripts against this app; office documents and archives don't render in a
 * tab anyway. Anything not listed here stays an `application/octet-stream`
 * attachment even when inline was requested.
 */
const INLINE_SAFE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/** The real content-type for a name safe to render inline, or `null`. */
export function inlineContentType(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 1) return null;
  return INLINE_SAFE_TYPES[filename.slice(dot + 1).toLowerCase()] ?? null;
}
