/**
 * Getting a file the agent produced out of the browser it is being viewed in.
 *
 * Previewing (image data URLs, text content in the Files tab) still goes
 * through `read_file` with `encoding: "base64"` over the multiplexed WS
 * session — that part needs the decoded bytes in JS to build a data URL or
 * show text. An actual download does not: `/api/files/download` (bff/src)
 * hands the browser a real URL with `Content-Disposition: attachment`, so the
 * browser's own download manager does the work — no base64 decode, no blob.
 *
 * A read failing over the size limit is still not this module's problem: the
 * app-server refuses a base64 read over 25MB with a readable message, and the
 * read_file call sites show it. Formatting an already-known size for display
 * (see `formatBytes`) is a different, much smaller thing.
 */

/** The BFF route that streams a workspace file as an attachment. */
export function downloadUrl(path: string): string {
  return `/api/files/download?path=${encodeURIComponent(path)}`;
}

/** Hand the browser a URL to download, without navigating the app away. */
export function triggerDownload(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  // Opened in its own tab so a broken/hallucinated path shows its error there
  // instead of navigating the SPA away.
  anchor.target = "_blank";
  anchor.rel = "noreferrer noopener";
  // Firefox only honours a click on an anchor that is in the document.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

const MIME_TYPES: Record<string, string> = {
  // Documents the agent actually produces.
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Text.
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  // Images.
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  // Archives.
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
};

function extension(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  // `dot < 1` covers both "no extension" and a leading-dot name like
  // ".gitignore", where the dot starts the name rather than an extension.
  return dot < 1 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * Best-guess content type for a filename, used to build the `data:` URL an
 * image preview renders from a base64 `read_file` response.
 */
export function mimeTypeFor(name: string): string {
  return MIME_TYPES[extension(name)] ?? "application/octet-stream";
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);

/**
 * Whether to preview this as an image rather than as text.
 *
 * Decided from the name because nothing else can decide it: `get_tree` carries
 * no mime type, and there is no way to know what a file holds until it has
 * already been read.
 *
 * SVG is deliberately absent. It is text, it previews fine in the normal
 * viewer, and rendering it as an image would mean handing the browser markup
 * the agent wrote — script and all.
 */
export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extension(name));
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

/** Whether to render this as formatted markdown rather than a raw text dump. */
export function isMarkdownFile(name: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extension(name));
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/**
 * Human-readable file size, e.g. "1.2 MB". `get_tree` carries no size field —
 * the BFF merges one in via a direct `stat()` (see `file-stat.ts`), only for
 * files, so callers only ever pass a defined byte count for something that
 * actually has one.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = value < 10 ? 1 : 0;
  return `${value.toFixed(precision)} ${BYTE_UNITS[unit]}`;
}

/**
 * Whether a failed `read_file` failed because the file is not text.
 *
 * The app-server reads utf8 strictly (`readUtf8TextStrict` →
 * `decodeUtf8TextStrict`) and throws this sentence for anything that is not
 * valid UTF-8. **That string is the contract.** If upstream rewords it this
 * returns false and the caller shows the raw error — which is exactly what the
 * Files tab did before downloads existed, so the failure mode is a return to
 * the old behaviour rather than something silently broken.
 */
export function isBinaryReadError(message: string): boolean {
  return message.includes("File is not valid UTF-8 text");
}
