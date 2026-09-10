import { describe, expect, test } from "bun:test";
import { fileLinkTarget, resolveMarkdownHref } from "./Markdown.tsx";

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

describe("fileLinkTarget", () => {
  test("a PDF opens in a browser tab (its own viewer, served inline)", () => {
    expect(fileLinkTarget("/work/agent-1/tailored/Dima.pdf")).toBe("browser");
    expect(fileLinkTarget("/work/agent-1/REPORT.PDF")).toBe("browser");
  });

  test("everything else opens in the app's file viewer", () => {
    for (const path of [
      "/work/agent-1/EVAL.md",
      "/work/agent-1/notes.txt",
      "/work/agent-1/data.csv",
      "/work/agent-1/chart.png",
      "/work/agent-1/scripts/run.py",
    ]) {
      expect(fileLinkTarget(path)).toBe("viewer");
    }
  });
});
