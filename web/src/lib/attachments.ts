/**
 * Image attachments for the composer.
 *
 * The app-server takes base64 image content parts inside an ordinary `input`
 * message — the same shape its own Telegram channel sends
 * (`letta-code/src/channels/xml.ts` `formatChannelNotification`) — and
 * normalizes every part before the model call
 * (`letta-code/src/utils/message-image-normalization.ts`): jpeg/png/gif/webp
 * only, downscaled to ≤2000×2000 and kept ≤5 MiB, HEIC converted. A part that
 * fails normalization throws and the whole turn fails.
 *
 * So we do the shrinking ourselves, before the frame is ever built. The hops
 * that would otherwise choke on a phone-camera original are the two WebSockets
 * (browser→BFF and BFF→app-server), each with Bun's 16 MiB default `maxPayloadLength`,
 * and the store, where the normalized base64 rides in every later
 * `conversation_messages_list` replay. The client-side caps here are the
 * mitigation for all three.
 */

/** Images per message. Enforced by the composer tray. */
export const MAX_IMAGES_PER_MESSAGE = 4;

/** Raw file size accepted before decoding anything. */
const MAX_RAW_BYTES = 8 * 1024 * 1024;
/** Decoded pixel budget — a 6000×5000 phone panorama is ~30M px. */
const MAX_PIXELS = 25_000_000;
/** Longest output edge. Upstream caps at 2000; we leave room for model cost. */
const MAX_EDGE = 1600;
/** Encode target. 4 images ≈ 6.4 MB of base64 — well inside every bound above. */
const TARGET_BYTES = 1.2 * 1024 * 1024;
/** Upstream's own per-part bound; anything past this never reaches the model. */
const HARD_MAX_BYTES = 5 * 1024 * 1024;
/** Quality ladder walked until the encode fits TARGET_BYTES. */
const QUALITY_STEPS = [0.82, 0.7, 0.55, 0.4];

/**
 * What a `File` may claim to be. HEIC/HEIF are accepted because iPhone cameras
 * produce them and Safari can decode them (we re-encode to jpeg; upstream
 * would convert them anyway, but only after the browser has resized them).
 * A browser that cannot decode a HEIC — most desktop Chrome — gets a clear
 * error, not a silent drop.
 */
const ACCEPTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/** One image, normalized and ready to ride in a message or preview in the DOM. */
export interface PreparedImage {
  name: string;
  /** Output media type, e.g. `image/jpeg`. */
  mediaType: string;
  base64: string;
  /** `data:` URL for `<img src>` — the same bytes, no object-URL lifecycle. */
  previewUrl: string;
}

/** An image the user offered but cannot be sent. Message is user-facing. */
export class AttachmentError extends Error {}

export function isAcceptedImageType(type: string): boolean {
  return ACCEPTED_TYPES.has(type.toLowerCase());
}

/**
 * Encode output type. webp keeps png/gif/webp alpha and compresses far better
 * than re-encoded png; jpeg for sources that never had alpha (and for HEIC,
 * which nothing here can encode natively).
 */
export function outputTypeFor(sourceType: string): string {
  const type = sourceType.toLowerCase();
  return type === "image/png" || type === "image/gif" || type === "image/webp"
    ? "image/webp"
    : "image/jpeg";
}

/** Downscale so the longest edge is ≤ MAX_EDGE; never enlarges. */
export function scaledSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE || longest <= 0) return { width, height };
  const scale = MAX_EDGE / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The content part the protocol wants for one prepared image. */
export function imageContentPart(image: PreparedImage): {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
} {
  return {
    type: "image",
    source: { type: "base64", media_type: image.mediaType, data: image.base64 },
  };
}

/** The content part carrying the typed text. */
export function textContentPart(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/**
 * The `messages[0].content` for a send: text part first (dropped when empty,
 * so an image-only message sends a bare image array), then one part per image.
 */
export function buildMessageContent(text: string, images: readonly PreparedImage[]): unknown[] {
  const trimmed = text.trim();
  return [...(trimmed ? [textContentPart(trimmed)] : []), ...images.map(imageContentPart)];
}

/**
 * The canvas seam. `decode` turns a File into a bitmap; `encode` rasterizes it
 * at the given size and quality. Injected so the rules in `prepareImage` are
 * unit-testable without a real canvas or a real image file.
 */
export interface ImageCodec {
  decode: (file: File) => Promise<ImageBitmap>;
  encode: (
    bitmap: ImageBitmap,
    width: number,
    height: number,
    mimeType: string,
    quality: number,
  ) => Promise<Blob>;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked so the argument spread cannot blow the call stack on a 5 MB image.
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const browserCodec: ImageCodec = {
  decode: (file) => createImageBitmap(file),
  encode: async (bitmap, width, height, mimeType, quality) => {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d canvas context");
      ctx.drawImage(bitmap, 0, 0, width, height);
      return canvas.convertToBlob({ type: mimeType, quality });
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas context");
    ctx.drawImage(bitmap, 0, 0, width, height);
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob failed"))),
        mimeType,
        quality,
      );
    });
  },
};

function prepared(name: string, mediaType: string, base64: string): PreparedImage {
  return { name, mediaType, base64, previewUrl: `data:${mediaType};base64,${base64}` };
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Decode, downscale and re-encode one file into a message-safe image.
 *
 * Pass-through rule (deliberate): a supported image already under TARGET_BYTES
 * and MAX_EDGE is sent byte-for-byte unchanged. That is what keeps an animated
 * GIF animated — anything re-encoded here flattens to its first frame, and a
 * small gif is already inside every budget, so we accept the still-frame
 * trade-off only when a re-encode was needed anyway.
 */
export async function prepareImage(
  file: File,
  codec: ImageCodec = browserCodec,
): Promise<PreparedImage> {
  const type = (file.type || "").toLowerCase();
  if (!isAcceptedImageType(type)) {
    throw new AttachmentError(
      `"${file.name}" is not an image — send JPEG, PNG, GIF, WebP or HEIC.`,
    );
  }
  if (file.size > MAX_RAW_BYTES) {
    throw new AttachmentError(
      `"${file.name}" is ${megabytes(file.size)} — the limit is ${megabytes(MAX_RAW_BYTES)}.`,
    );
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await codec.decode(file);
  } catch {
    if (type === "image/heic" || type === "image/heif") {
      throw new AttachmentError(
        `This browser cannot read "${file.name}" as HEIC — export it as JPEG first.`,
      );
    }
    throw new AttachmentError(`Could not read "${file.name}" as an image.`);
  }

  try {
    const sourcePixels = bitmap.width * bitmap.height;
    if (sourcePixels > MAX_PIXELS) {
      throw new AttachmentError(
        `"${file.name}" is ${bitmap.width}×${bitmap.height} pixels — too large to read.`,
      );
    }

    const alreadySupported =
      type === "image/jpeg" ||
      type === "image/png" ||
      type === "image/gif" ||
      type === "image/webp";
    if (
      alreadySupported &&
      file.size <= TARGET_BYTES &&
      Math.max(bitmap.width, bitmap.height) <= MAX_EDGE
    ) {
      return prepared(file.name, type, bytesToBase64(new Uint8Array(await file.arrayBuffer())));
    }

    const { width, height } = scaledSize(bitmap.width, bitmap.height);
    const outType = outputTypeFor(type);
    let blob: Blob | null = null;
    for (const quality of QUALITY_STEPS) {
      blob = await codec.encode(bitmap, width, height, outType, quality);
      if (blob.size <= TARGET_BYTES) break;
    }
    if (!blob) throw new AttachmentError(`Could not encode "${file.name}".`);
    // The ladder bottomed out above target but upstream can still take it.
    if (blob.size > HARD_MAX_BYTES) {
      throw new AttachmentError(
        `"${file.name}" cannot be shrunk below ${megabytes(HARD_MAX_BYTES)} — too large to send.`,
      );
    }
    return prepared(file.name, outType, bytesToBase64(new Uint8Array(await blob.arrayBuffer())));
  } finally {
    bitmap.close?.();
  }
}

export interface PreparedBatch {
  images: PreparedImage[];
  /** One user-facing line per rejected file, in input order. */
  errors: string[];
}

/**
 * Prepare every file, collecting rejections instead of failing the batch —
 * picking six photos and having the third be a PDF must not lose the other
 * five. The per-message count cap is the tray's job, not this function's.
 */
export async function prepareImages(
  files: readonly File[],
  codec: ImageCodec = browserCodec,
): Promise<PreparedBatch> {
  const images: PreparedImage[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      images.push(await prepareImage(file, codec));
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return { images, errors };
}
