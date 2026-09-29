import { describe, expect, test } from "bun:test";
import { contentDisposition } from "./content-disposition.ts";

describe("contentDisposition", () => {
  test("a plain ASCII name is one short parameter", () => {
    expect(contentDisposition("report.pdf", "attachment")).toBe(
      'attachment; filename="report.pdf"',
    );
  });

  test("honours the disposition it is given", () => {
    expect(contentDisposition("scan.png", "inline")).toBe('inline; filename="scan.png"');
  });

  test("strips CR and LF so a filename cannot inject a header", () => {
    const value = contentDisposition("evil\r\nX-Injected: yes.pdf", "attachment");
    expect(value).not.toContain("\r");
    expect(value).not.toContain("\n");
    // The whole value stays one header: nothing after the CR/LF can become a
    // header of its own, it merely merges into the filename.
    expect(value).toBe('attachment; filename="evilX-Injected: yes.pdf"');
  });

  test("removes quotes and backslashes that would break the quoted string", () => {
    const value = contentDisposition('a"b\\c.pdf', "attachment");
    const quoted = value.match(/filename="([^"]*)"/);
    expect(quoted).not.toBeNull();
    expect(quoted![1]).not.toContain("\\");
    // Exactly one closing quote for the filename parameter.
    expect(value.split('"').length).toBe(3);
  });

  test("falls back to a safe name when nothing printable survives", () => {
    expect(contentDisposition('"""', "attachment")).toBe('attachment; filename="download"');
  });

  test("carries non-ASCII names through RFC 5987 filename*", () => {
    const value = contentDisposition("отчёт.pdf", "attachment");
    expect(value).toContain("filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf");
    // An ASCII-only fallback goes out alongside it for older clients: each
    // non-ASCII code unit becomes an underscore.
    expect(value).toMatch(/filename="_{5}\.pdf"/);
  });

  test("percent-encodes the characters RFC 5987 does not leave literal", () => {
    const value = contentDisposition("café (x'y).pdf", "attachment");
    expect(value).toContain("filename*=UTF-8''caf%C3%A9%20%28x%27y%29.pdf");
  });

  test("omits filename* when the name is already ASCII", () => {
    expect(contentDisposition("notes.md", "attachment")).not.toContain("filename*");
  });
});
