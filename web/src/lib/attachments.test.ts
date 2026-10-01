import { describe, expect, test } from "bun:test";
import {
  AttachmentError,
  buildMessageContent,
  type ImageCodec,
  imageContentPart,
  isAcceptedImageType,
  outputTypeFor,
  type PreparedImage,
  prepareImage,
  prepareImages,
  scaledSize,
  textContentPart,
} from "./attachments.ts";

/** A real File of exactly `size` bytes claiming to be `type`. */
function fileOfSize(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type });
}

function bitmapOf(width: number, height: number): ImageBitmap {
  return { width, height } as unknown as ImageBitmap;
}

/**
 * Codec with fixed source dimensions and a scripted encode: `bytes(quality)`
 * decides each attempt's size, and `calls` records what each attempt used.
 */
function fakeCodec(
  source: { width: number; height: number },
  bytes: (quality: number) => number,
  calls?: { quality: number[]; width: number; height: number; mimeType: string },
): ImageCodec {
  return {
    decode: async () => bitmapOf(source.width, source.height),
    encode: async (_bitmap, width, height, mimeType, quality) => {
      calls?.quality.push(quality);
      if (calls) {
        calls.width = width;
        calls.height = height;
        calls.mimeType = mimeType;
      }
      return new Blob([new Uint8Array(bytes(quality))]);
    },
  };
}

describe("type gate", () => {
  test("accepts what the model side supports, plus HEIC", () => {
    for (const type of [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/heic",
      "image/heif",
    ]) {
      expect(isAcceptedImageType(type)).toBe(true);
    }
  });

  test("rejects everything else", () => {
    for (const type of ["application/pdf", "text/plain", "image/tiff", ""]) {
      expect(isAcceptedImageType(type)).toBe(false);
    }
  });

  test("matches the type case-insensitively", () => {
    expect(isAcceptedImageType("IMAGE/JPEG")).toBe(true);
  });
});

describe("size math", () => {
  test("scales the longest edge to 1600 and preserves ratio", () => {
    expect(scaledSize(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(scaledSize(3000, 4000)).toEqual({ width: 1200, height: 1600 });
  });

  test("never upscales a small image", () => {
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(scaledSize(1600, 1600)).toEqual({ width: 1600, height: 1600 });
  });

  test("output type keeps alpha as webp, flattens the rest to jpeg", () => {
    expect(outputTypeFor("image/png")).toBe("image/webp");
    expect(outputTypeFor("image/gif")).toBe("image/webp");
    expect(outputTypeFor("image/webp")).toBe("image/webp");
    expect(outputTypeFor("image/jpeg")).toBe("image/jpeg");
    expect(outputTypeFor("image/heic")).toBe("image/jpeg");
  });
});

describe("prepareImage", () => {
  test("rejects a non-image file with a clear message", async () => {
    const codec = fakeCodec({ width: 10, height: 10 }, () => 1);
    const error = await prepareImage(fileOfSize("notes.pdf", "application/pdf", 10), codec).catch(
      (cause) => cause,
    );
    expect(error).toBeInstanceOf(AttachmentError);
    expect((error as Error).message).toContain("notes.pdf");
    expect((error as Error).message).toContain("not an image");
  });

  test("rejects a raw file over 8 MB before decoding", async () => {
    let decoded = false;
    const codec: ImageCodec = {
      decode: async () => {
        decoded = true;
        return bitmapOf(10, 10);
      },
      encode: async () => new Blob([new Uint8Array(1)]),
    };
    const error = await prepareImage(
      fileOfSize("big.png", "image/png", 9 * 1024 * 1024),
      codec,
    ).catch((cause) => cause);
    expect((error as Error).message).toContain("big.png");
    expect(decoded).toBe(false);
  });

  test("rejects a decoded bitmap over 25M pixels", async () => {
    const codec = fakeCodec({ width: 6000, height: 5000 }, () => 10);
    const error = await prepareImage(fileOfSize("pano.png", "image/png", 1000), codec).catch(
      (cause) => cause,
    );
    expect((error as Error).message).toContain("6000×5000");
  });

  test("surfaces a decode failure with HEIC-specific advice for HEIC", async () => {
    const codec: ImageCodec = {
      decode: () => Promise.reject(new Error("no decoder")),
      encode: async () => new Blob([new Uint8Array(1)]),
    };
    const heic = await prepareImage(fileOfSize("IMG_0001.heic", "image/heic", 1000), codec).catch(
      (cause) => cause,
    );
    expect((heic as Error).message).toContain("HEIC");
    const gif = await prepareImage(fileOfSize("x.gif", "image/gif", 1000), codec).catch(
      (cause) => cause,
    );
    expect((gif as Error).message).toContain("Could not read");
  });

  test("passes a small supported image through unchanged", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const source = new File([bytes], "small.gif", { type: "image/gif" });
    let encoded = false;
    const codec: ImageCodec = {
      decode: async () => bitmapOf(64, 64),
      encode: async () => {
        encoded = true;
        return new Blob([new Uint8Array(1)]);
      },
    };
    const image = await prepareImage(source, codec);
    // Unchanged bytes mean an animated GIF stays animated.
    expect(encoded).toBe(false);
    expect(image.mediaType).toBe("image/gif");
    expect(image.base64).toBe(btoa("\x01\x02\x03\x04\x05\x06\x07\x08"));
    expect(image.previewUrl).toBe(`data:image/gif;base64,${image.base64}`);
    expect(image.name).toBe("small.gif");
  });

  test("re-encodes an oversized png to webp at the scaled size", async () => {
    const calls = { quality: [] as number[], width: 0, height: 0, mimeType: "" };
    const codec = fakeCodec({ width: 4000, height: 3000 }, () => 1000, calls);
    const image = await prepareImage(fileOfSize("huge.png", "image/png", 5 * 1024 * 1024), codec);
    expect(calls.mimeType).toBe("image/webp");
    expect({ width: calls.width, height: calls.height }).toEqual({ width: 1600, height: 1200 });
    expect(calls.quality).toEqual([0.82]);
    expect(image.mediaType).toBe("image/webp");
    expect(image.previewUrl.startsWith("data:image/webp;base64,")).toBe(true);
  });

  test("walks the quality ladder until the encode fits", async () => {
    const calls = { quality: [] as number[], width: 0, height: 0, mimeType: "" };
    const codec = fakeCodec(
      { width: 2000, height: 1000 },
      (quality) => (quality > 0.7 ? 2 * 1024 * 1024 : 500),
      calls,
    );
    const image = await prepareImage(fileOfSize("busy.jpg", "image/jpeg", 3 * 1024 * 1024), codec);
    expect(calls.quality).toEqual([0.82, 0.7]);
    expect(image.mediaType).toBe("image/jpeg");
  });

  test("sends a best-effort encode under 5 MB even above target", async () => {
    const codec = fakeCodec({ width: 1600, height: 1600 }, () => 2 * 1024 * 1024);
    const image = await prepareImage(fileOfSize("dense.png", "image/png", 4 * 1024 * 1024), codec);
    expect(image.base64.length).toBeGreaterThan(0);
  });

  test("errors when it cannot get under 5 MB", async () => {
    const codec = fakeCodec({ width: 1600, height: 1600 }, () => 6 * 1024 * 1024);
    const error = await prepareImage(
      fileOfSize("huge.jpg", "image/jpeg", 7 * 1024 * 1024),
      codec,
    ).catch((cause) => cause);
    expect((error as Error).message).toContain("5 MB");
  });
});

describe("prepareImages batch", () => {
  test("keeps the good files and lists one error line per rejected one", async () => {
    const codec = fakeCodec({ width: 10, height: 10 }, () => 10);
    const batch = await prepareImages(
      [
        fileOfSize("a.png", "image/png", 10),
        fileOfSize("b.pdf", "application/pdf", 10),
        fileOfSize("c.jpg", "image/jpeg", 10),
      ],
      codec,
    );
    expect(batch.images.map((image: PreparedImage) => image.name)).toEqual(["a.png", "c.jpg"]);
    expect(batch.errors).toHaveLength(1);
    expect(batch.errors[0]).toContain("b.pdf");
  });
});

describe("content parts", () => {
  test("image part matches the shape the app-server normalizes", () => {
    const image: PreparedImage = {
      name: "x.jpg",
      mediaType: "image/jpeg",
      base64: "aGk=",
      previewUrl: "data:image/jpeg;base64,aGk=",
    };
    expect(imageContentPart(image)).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "aGk=" },
    });
  });

  test("buildMessageContent puts text first and drops empty text", () => {
    const image: PreparedImage = {
      name: "x.jpg",
      mediaType: "image/jpeg",
      base64: "aGk=",
      previewUrl: "data:image/jpeg;base64,aGk=",
    };
    expect(buildMessageContent("  look  ", [image])).toEqual([
      textContentPart("look"),
      imageContentPart(image),
    ]);
    expect(buildMessageContent("   ", [image])).toEqual([imageContentPart(image)]);
    expect(buildMessageContent("hi", [])).toEqual([textContentPart("hi")]);
  });
});
