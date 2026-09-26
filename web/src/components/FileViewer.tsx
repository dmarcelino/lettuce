/**
 * View a single workspace file in the app: a chat file link opens this, and so
 * does the Files tab. Markdown is rendered, other text shown verbatim, an image
 * previewed from a base64 read; a file that is not valid UTF-8 is not text, so
 * it downloads instead of showing an error (which is all this could do before).
 *
 * Lifted out of `FilesTab` so both entry points share one behaviour. Previewing
 * still goes through `read_file` over the multiplexed WS session — the bytes
 * have to reach JS to build a data URL or show text — while the Download button
 * hands off to the BFF's HTTP route.
 */
import { useEffect, useRef, useState } from "react";
import {
  downloadUrl,
  isBinaryReadError,
  isImageFile,
  isMarkdownFile,
  mimeTypeFor,
  triggerDownload,
} from "../lib/download.ts";
import { errorMessage } from "../lib/errors.ts";
import type { SessionApi } from "../state/use-session.ts";
import { Markdown } from "./Markdown.tsx";
import { Sheet } from "./Sheet.tsx";

interface ReadResponse {
  content?: string | null;
  success?: boolean;
  error?: string;
}

const basename = (path: string) => path.split("/").pop() || path;

export function FileViewer({
  session,
  path,
  onClose,
}: {
  session: SessionApi;
  path: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading…");

  // Inline handlers from the caller change identity every render; keep the
  // effect keyed on `path` alone so it does not re-read the file each time.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let cancelled = false;
    const name = basename(path);
    setContent(null);
    setImage(null);
    setStatus("Loading…");

    void (async () => {
      try {
        const response = await session.request<ReadResponse>("read_file", {
          path,
          encoding: isImageFile(name) ? "base64" : "utf8",
        });
        if (cancelled) return;
        if (response?.success === false || typeof response?.content !== "string") {
          const error = response?.error ?? "Failed to read file";
          if (!isImageFile(name) && isBinaryReadError(error)) {
            onCloseRef.current();
            triggerDownload(downloadUrl(path));
            return;
          }
          setStatus(error);
          return;
        }
        if (isImageFile(name)) {
          setImage(`data:${mimeTypeFor(name)};base64,${response.content}`);
        } else {
          setContent(response.content);
        }
        setStatus("");
      } catch (cause) {
        if (!cancelled) setStatus(errorMessage(cause));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session, path]);

  const name = basename(path);
  return (
    <Sheet
      title={name}
      fill
      size="spacious"
      status={status || null}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className="button"
            onClick={() => triggerDownload(downloadUrl(path))}
          >
            Download
          </button>
          <button type="button" className="button ghost" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {image !== null ? (
        <img className="file-preview" src={image} alt={name} />
      ) : content !== null && isMarkdownFile(name) ? (
        // Not `.tool-args`: that is the monospace box for tool output, with
        // `white-space: pre-wrap`, and react-markdown puts a newline text node
        // between every block — pre-wrap drew each one as a blank line, an
        // extra line after every paragraph and bullet.
        <div className="md-document">
          <Markdown text={content} />
        </div>
      ) : content !== null ? (
        <pre className="tool-args">{content}</pre>
      ) : null}
    </Sheet>
  );
}
