import { describe, expect, test } from "bun:test";
import { LINKABLE_EXTENSIONS, remarkFilePaths, resolveWorkspacePath } from "./file-links.ts";

const CWD = "/work/agent-abc";

/** Minimal mdast node, matching what the plugin walks. */
interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

const text = (value: string): Node => ({ type: "text", value });
const para = (...children: Node[]): Node => ({
  type: "root",
  children: [{ type: "paragraph", children }],
});

/** Run the plugin and flatten the paragraph back to `[type:value|url, …]`. */
function run(tree: Node, cwd: string | null = CWD): string[] {
  remarkFilePaths({ cwd })(tree);
  const paragraph = tree.children?.[0];
  return (paragraph?.children ?? []).map((node) => {
    if (node.type === "link") return `link:${node.url}:${node.children?.[0]?.value ?? ""}`;
    return `text:${node.value ?? ""}`;
  });
}

describe("resolveWorkspacePath", () => {
  test("a relative path joins onto cwd", () => {
    expect(resolveWorkspacePath("tailored/x.pdf", CWD)).toBe("/work/agent-abc/tailored/x.pdf");
    expect(resolveWorkspacePath("./notes.md", CWD)).toBe("/work/agent-abc/notes.md");
  });

  test("an absolute /work path passes through, normalised", () => {
    expect(resolveWorkspacePath("/work/agent-abc/a//b.pdf", CWD)).toBe("/work/agent-abc/a/b.pdf");
  });

  test("no cwd means a relative path cannot resolve", () => {
    expect(resolveWorkspacePath("tailored/x.pdf", null)).toBeNull();
  });

  test("nothing outside /work resolves", () => {
    expect(resolveWorkspacePath("/etc/passwd", CWD)).toBeNull();
    expect(resolveWorkspacePath("/work", CWD)).toBeNull();
    expect(resolveWorkspacePath("/workshop/notes.md", CWD)).toBeNull();
  });

  test("a path that climbs out of /work is rejected", () => {
    expect(resolveWorkspacePath("../../etc/passwd.txt", CWD)).toBeNull();
    expect(resolveWorkspacePath("../../../root.md", CWD)).toBeNull();
  });
});

describe("remarkFilePaths", () => {
  test("links a bare workspace-relative path in prose", () => {
    expect(
      run(para(text("waiting on your review of tailored/Dima_20260910-0454.pdf (lululemon)"))),
    ).toEqual([
      "text:waiting on your review of ",
      "link:/work/agent-abc/tailored/Dima_20260910-0454.pdf:tailored/Dima_20260910-0454.pdf",
      "text: (lululemon)",
    ]);
  });

  test("links a bare filename with a known extension", () => {
    expect(run(para(text("see report.pdf for details")))).toEqual([
      "text:see ",
      "link:/work/agent-abc/report.pdf:report.pdf",
      "text: for details",
    ]);
  });

  test("trailing sentence punctuation stays out of the link", () => {
    expect(run(para(text("it is in output/summary.md.")))).toEqual([
      "text:it is in ",
      "link:/work/agent-abc/output/summary.md:output/summary.md",
      "text:.",
    ]);
  });

  test("leaves non-path slashes and unknown extensions alone", () => {
    for (const prose of [
      "choose one and/or the other",
      "run node.ts then app.js",
      "e.g. this or that",
    ]) {
      expect(run(para(text(prose)))).toEqual([`text:${prose}`]);
    }
  });

  test("does not fire inside an email address", () => {
    expect(run(para(text("mail dima@host.com/report.pdf nobody")))).toEqual([
      "text:mail dima@host.com/report.pdf nobody",
    ]);
  });

  test("does not touch an already-parsed link node", () => {
    const tree: Node = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "link", url: "https://x.test/a.pdf", children: [text("a.pdf")] }],
        },
      ],
    };
    remarkFilePaths({ cwd: CWD })(tree);
    const link = tree.children?.[0]?.children?.[0];
    expect(link?.url).toBe("https://x.test/a.pdf");
    expect(link?.children?.[0]?.value).toBe("a.pdf");
  });

  test("does not touch inline code or fenced code", () => {
    const inline = para({ type: "inlineCode", value: "tailored/x.pdf" });
    remarkFilePaths({ cwd: CWD })(inline);
    expect(inline.children?.[0]?.children?.[0]).toEqual({
      type: "inlineCode",
      value: "tailored/x.pdf",
    });

    const fenced: Node = {
      type: "root",
      children: [{ type: "code", value: "cat tailored/x.pdf" }],
    };
    remarkFilePaths({ cwd: CWD })(fenced);
    expect(fenced.children?.[0]).toEqual({ type: "code", value: "cat tailored/x.pdf" });
  });

  test("a relative path is left as text when cwd is unknown", () => {
    expect(run(para(text("see tailored/x.pdf")), null)).toEqual(["text:see tailored/x.pdf"]);
  });

  test("an absolute /work path in prose still links without cwd", () => {
    expect(run(para(text("at /work/agent-abc/out/final.pdf now")), null)).toEqual([
      "text:at ",
      "link:/work/agent-abc/out/final.pdf:/work/agent-abc/out/final.pdf",
      "text: now",
    ]);
  });

  test("a coincidental /work-prefixed path outside the workspace stays text", () => {
    expect(run(para(text("not /workshop/plan.md really")))).toEqual([
      "text:not /workshop/plan.md really",
    ]);
  });

  test("two paths in one line both link", () => {
    expect(run(para(text("compare a/one.md and b/two.md")))).toEqual([
      "text:compare ",
      "link:/work/agent-abc/a/one.md:a/one.md",
      "text: and ",
      "link:/work/agent-abc/b/two.md:b/two.md",
    ]);
  });

  test("the extension allowlist is non-empty and lower-case", () => {
    expect(LINKABLE_EXTENSIONS.has("pdf")).toBe(true);
    expect(LINKABLE_EXTENSIONS.has("docx")).toBe(true);
    for (const ext of LINKABLE_EXTENSIONS) expect(ext).toBe(ext.toLowerCase());
  });
});
