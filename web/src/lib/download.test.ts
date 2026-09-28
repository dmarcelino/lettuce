import { describe, expect, test } from "bun:test";
import {
  downloadUrl,
  formatBytes,
  formatChars,
  isBinaryReadError,
  isImageFile,
  isMarkdownFile,
  mimeTypeFor,
} from "./download.ts";

describe("downloadUrl", () => {
  test("builds a URL the BFF's download route understands", () => {
    expect(downloadUrl("/work/agent-1/report.pdf")).toBe(
      "/api/files/download?path=%2Fwork%2Fagent-1%2Freport.pdf",
    );
  });

  test("encodes characters that would otherwise break the query string", () => {
    expect(downloadUrl("/work/agent-1/a b & c.txt")).toBe(
      "/api/files/download?path=%2Fwork%2Fagent-1%2Fa%20b%20%26%20c.txt",
    );
  });

  test("adds inline=1 when asked to open in place", () => {
    expect(downloadUrl("/work/agent-1/report.pdf", { inline: true })).toBe(
      "/api/files/download?path=%2Fwork%2Fagent-1%2Freport.pdf&inline=1",
    );
    expect(downloadUrl("/work/agent-1/report.pdf", { inline: false })).toBe(
      "/api/files/download?path=%2Fwork%2Fagent-1%2Freport.pdf",
    );
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

describe("isMarkdownFile", () => {
  test("recognises markdown extensions", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("notes.MARKDOWN")).toBe(true);
  });

  test("everything else previews as plain text", () => {
    expect(isMarkdownFile("resume.pdf")).toBe(false);
    expect(isMarkdownFile("notes.txt")).toBe(false);
    expect(isMarkdownFile("README")).toBe(false);
  });
});

describe("formatBytes", () => {
  test("bytes under a kilobyte are not divided", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(823)).toBe("823 B");
  });

  test("scales up through the units", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe("2.5 GB");
  });

  test("drops the decimal once the number reaches two digits", () => {
    // A resume-length PDF being "12.3 KB" is fine; "123.4 KB" is noise.
    expect(formatBytes(1024 * 12)).toBe("12 KB");
    expect(formatBytes(1024 * 123)).toBe("123 KB");
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

describe("formatChars", () => {
  test("counts characters with a k past a thousand", () => {
    expect(formatChars(343)).toBe("343 chars");
    expect(formatChars(1201)).toBe("1.2k chars");
    expect(formatChars(12_400)).toBe("12k chars");
  });
});
