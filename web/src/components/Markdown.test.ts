import { describe, expect, test } from "bun:test";
import { resolveMarkdownHref } from "./Markdown.tsx";

describe("resolveMarkdownHref", () => {
  test("rewrites a workspace file link to the download route, opened inline", () => {
    expect(resolveMarkdownHref("/work/agent-1/report.pdf")).toBe(
      "/api/files/download?path=%2Fwork%2Fagent-1%2Freport.pdf&inline=1",
    );
  });

  test("leaves an ordinary external link untouched", () => {
    expect(resolveMarkdownHref("https://example.com/docs")).toBe("https://example.com/docs");
  });

  test("leaves a path outside the workspace untouched", () => {
    // Not something the file protocol or an agent's cwd would ever produce,
    // but the rewrite must not fire on a coincidental /work prefix elsewhere.
    expect(resolveMarkdownHref("/workshop/notes.md")).toBe("/workshop/notes.md");
  });

  test("passes through an absent href", () => {
    expect(resolveMarkdownHref(undefined)).toBeUndefined();
  });
});
