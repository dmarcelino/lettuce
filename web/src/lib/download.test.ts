import { describe, expect, test } from "bun:test";
import { base64ToBytes, isBinaryReadError, isImageFile, mimeTypeFor } from "./download.ts";

describe("base64ToBytes", () => {
  test("round-trips text", () => {
    const bytes = base64ToBytes(btoa("hello"));
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  test("round-trips bytes above 127, which is the whole point", () => {
    // A docx is a zip; these are its first four bytes plus a high byte. Getting
    // this wrong is the classic "downloaded file is corrupt" bug.
    const original = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80, 0xfe]);
    const base64 = btoa(String.fromCharCode(...original));
    expect([...base64ToBytes(base64)]).toEqual([...original]);
  });

  test("an empty payload is an empty file, not an error", () => {
    expect(base64ToBytes("")).toHaveLength(0);
  });
});

describe("mimeTypeFor", () => {
  test("names the types the agent actually produces", () => {
    expect(mimeTypeFor("AWS-resume.pdf")).toBe("application/pdf");
    expect(mimeTypeFor("tailored/AWS-resume.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(mimeTypeFor("MASTER.md")).toBe("text/markdown");
  });

  test("extension matching is case-insensitive", () => {
    expect(mimeTypeFor("SCAN.PDF")).toBe("application/pdf");
  });

  test("anything unrecognised is opaque bytes", () => {
    expect(mimeTypeFor("archive.qqq")).toBe("application/octet-stream");
    expect(mimeTypeFor("LICENSE")).toBe("application/octet-stream");
    // A dotfile's name is not an extension.
    expect(mimeTypeFor(".gitignore")).toBe("application/octet-stream");
  });
});

describe("isImageFile", () => {
  test("previewable raster formats", () => {
    expect(isImageFile("shot.png")).toBe(true);
    expect(isImageFile("photo.JPEG")).toBe(true);
  });

  test("svg is not treated as an image", () => {
    // It is markup the agent wrote; it previews fine as text, and rendering it
    // would hand the browser script to run.
    expect(isImageFile("diagram.svg")).toBe(false);
  });

  test("documents and text are not images", () => {
    expect(isImageFile("resume.pdf")).toBe(false);
    expect(isImageFile("MASTER.md")).toBe(false);
    expect(isImageFile("README")).toBe(false);
  });
});

describe("isBinaryReadError", () => {
  test("recognises the app-server's strict-utf8 refusal", () => {
    expect(
      isBinaryReadError(
        "File is not valid UTF-8 text: /work/a/x.docx. The file contains bytes that cannot be decoded as UTF-8.",
      ),
    ).toBe(true);
    expect(
      isBinaryReadError(
        "File is not valid UTF-8 text: /work/a/x.txt. Detected UTF-16LE BOM; convert the file to UTF-8 and retry.",
      ),
    ).toBe(true);
  });

  test("other failures are not mistaken for binary", () => {
    // These must keep showing their own message rather than silently becoming
    // a download attempt.
    expect(isBinaryReadError("ENOENT: no such file or directory")).toBe(false);
    expect(isBinaryReadError("File too large for base64 read (max 25MB)")).toBe(false);
    expect(isBinaryReadError("")).toBe(false);
  });
});
