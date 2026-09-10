import { describe, expect, test } from "bun:test";
import { inlineContentType } from "./content-type.ts";

describe("inlineContentType", () => {
  test("PDFs and raster images get their real type", () => {
    expect(inlineContentType("Dima_Marchevskyi_20260910.pdf")).toBe("application/pdf");
    expect(inlineContentType("headshot.PNG")).toBe("image/png");
    expect(inlineContentType("photo.jpeg")).toBe("image/jpeg");
    expect(inlineContentType("scan.webp")).toBe("image/webp");
  });

  test("scriptable and non-renderable types stay attachments", () => {
    expect(inlineContentType("report.html")).toBeNull();
    expect(inlineContentType("diagram.svg")).toBeNull();
    expect(inlineContentType("resume.docx")).toBeNull();
    expect(inlineContentType("notes.md")).toBeNull();
    expect(inlineContentType("archive.zip")).toBeNull();
  });

  test("no usable extension is null, not a crash", () => {
    expect(inlineContentType("README")).toBeNull();
    expect(inlineContentType(".gitignore")).toBeNull();
    expect(inlineContentType("download")).toBeNull();
  });
});
