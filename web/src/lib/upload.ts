/**
 * Putting one real file (a photo, a PDF) into an agent's workspace.
 *
 * The mirror of `download.ts`, and the same split: file bytes belong on HTTP,
 * not on the multiplexed session — `/api/files/upload` (bff/src) validates the
 * destination and issues the `write_file {encoding:"base64"}` itself.
 *
 * `XMLHttpRequest` rather than `fetch` on purpose: fetch reports no upload
 * progress, and a several-megabyte photo on a phone network takes long enough
 * that silence reads as broken. Aborting is an `abort()`, and it is safe: the
 * BFF builds the write frame only after the whole body has arrived, so a
 * cancelled upload leaves no partial file on disk.
 */

/** Must agree with `MAX_UPLOAD_BYTES` in `bff/src/files/upload.ts`. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface UploadResult {
  path: string;
  bytes: number;
}

export function uploadWorkspaceFile(
  path: string,
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/files/upload?path=${encodeURIComponent(path)}`);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        // Bytes handed to the browser, not bytes on disk: stop at 99 so the
        // number only reaches 100 when the write has actually been answered.
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch {
          reject(new Error("Upload failed: the server answered with something unreadable"));
        }
        return;
      }
      // The BFF says why in the body (outside the workspace, too large, too many
      // at once, a short write). Pass it through — it is the useful half.
      reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed: the connection dropped"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });

    xhr.send(file);
  });
}
