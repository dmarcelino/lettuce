/**
 * Getting a file the agent produced out of the browser it is being viewed in.
 *
 * The transport is `read_file` with `encoding: "base64"` — an option the
 * app-server documents as existing for exactly this, "binary reads such as
 * image previews on web clients". It is already on the BFF's browser allowlist
 * and already clamped to `/work`, so nothing here needs a new server surface.
 *
 * Size is not this module's problem: the app-server refuses a base64 read over
 * 25MB with a readable message, and the caller shows it.
 */

/** Decode a base64 payload into the bytes it stands for. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
 * Best-guess content type for a filename.
 *
 * The `download` attribute means the browser saves the bytes either way, so
 * this is mostly cosmetic — except on iOS, where a correct type is the
 * difference between previewing a PDF and being handed an opaque blob.
 */
export function mimeTypeFor(name: string): string {
  return MIME_TYPES[extension(name)] ?? "application/octet-stream";
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);

/**
 * Whether to preview this as an image rather than as text.
 *
 * Decided from the name because nothing else can decide it: `get_tree` reports
 * only `{path, type}`, so the client has no size, no mime type, and no way to
 * know what a file holds until it has already read it.
 *
 * SVG is deliberately absent. It is text, it previews fine in the normal
 * viewer, and rendering it as an image would mean handing the browser markup
 * the agent wrote — script and all.
 */
export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extension(name));
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

/** Hand bytes to the browser's download manager under a given filename. */
export function saveBytes(name: string, bytes: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  // Firefox only honours a click on an anchor that is in the document.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
