/**
 * Turn a workspace file path the agent mentions in prose into a link.
 *
 * The agent routinely writes things like "waiting on your review of
 * tailored/Dima_2026-0910.pdf" — a real file under its workspace, but plain
 * text in the transcript. This remark plugin runs after `remark-gfm` and
 * rewrites path-shaped tokens (ending in a known extension) into `link` nodes
 * pointing at the absolute `/work/...` path, which `Markdown.tsx`'s `a`
 * component then sends to the BFF download route.
 *
 * Deliberately narrow to avoid false positives:
 *  - only tokens ending in a known file extension (see `LINKABLE_EXTENSIONS`);
 *  - relative tokens need `cwd` to resolve, and both relative and absolute
 *    tokens must land inside `/work/` after normalising `.`/`..` — anything
 *    that escapes the workspace, or is `/work` itself, is left as text;
 *  - never descends into `link` / `linkReference` (no nested links) or code
 *    (`code` and `inlineCode` are leaf nodes holding their own `value`, so a
 *    path inside a fenced block or backticks is untouched);
 *  - a token butting up against a word char, `@`, `.` or `-` is mid-word /
 *    mid-email and skipped; bare URLs (`http://…`, `www.…`) are already `link`
 *    nodes by the time this runs — gfm autolinked them — so they are skipped
 *    too, and any that slip through fail the `/work/` clamp anyway.
 *
 * No lookbehind in the regex on purpose: older Safari throws a SyntaxError
 * parsing one, which would take out the whole module. The leading-boundary
 * check is done in code instead.
 */
import { WORKSPACE_ROOT } from "./workspace.ts";

/** Extensions worth linking — the doc/text/image/archive types agents produce. */
export const LINKABLE_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "rtf",
  "md",
  "markdown",
  "txt",
  "text",
  "log",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "yml",
  "html",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "svg",
  "tif",
  "tiff",
  "heic",
  "zip",
  "gz",
  "tgz",
  "tar",
]);

/** The mdast shape this plugin touches — structural, to avoid an mdast dep. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

export interface FilePathOptions {
  /** The conversation's cwd (`/work/<agent-id>`), or `null` when unknown. */
  cwd: string | null;
}

/**
 * A path token: optional leading `/`, then any number of `./` or `../`, then
 * `dir/`-segments, then `name.ext`. `(?![\w/])` keeps a trailing `.` or `)`
 * out of the token. Group 1 is the token, group 2 the extension.
 */
const PATH_RE = /(\/?(?:\.\.?\/)*[\w.-]+(?:\/[\w.-]+)*\.([A-Za-z0-9]+))(?![\w/])/g;

/** A char that means the match started mid-word / mid-email, not at a boundary. */
const NOT_A_BOUNDARY = /[\w@.-]/;

/** Resolve a token to an absolute path inside `/work/`, or `null` to leave as text. */
export function resolveWorkspacePath(token: string, cwd: string | null): string | null {
  let raw: string;
  if (token.startsWith("/")) {
    raw = token;
  } else {
    if (!cwd) return null;
    raw = `${cwd}/${token}`;
  }

  const parts: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  const normalized = `/${parts.join("/")}`;
  const prefix = `${WORKSPACE_ROOT}/`;
  if (!normalized.startsWith(prefix) || normalized.length <= prefix.length) return null;
  return normalized;
}

/** Split one text value into text/link nodes, or `null` if nothing matched. */
function splitText(value: string, cwd: string | null): MdNode[] | null {
  PATH_RE.lastIndex = 0;
  const nodes: MdNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null = PATH_RE.exec(value);
  while (match !== null) {
    const token = match[1] ?? "";
    const ext = (match[2] ?? "").toLowerCase();
    const before = match.index === 0 ? "" : value.charAt(match.index - 1);
    const url =
      !NOT_A_BOUNDARY.test(before) && LINKABLE_EXTENSIONS.has(ext)
        ? resolveWorkspacePath(token, cwd)
        : null;
    if (url) {
      if (match.index > last) {
        nodes.push({ type: "text", value: value.slice(last, match.index) });
      }
      nodes.push({ type: "link", url, children: [{ type: "text", value: token }] });
      last = match.index + token.length;
    }
    match = PATH_RE.exec(value);
  }

  if (nodes.length === 0) return null;
  if (last < value.length) nodes.push({ type: "text", value: value.slice(last) });
  return nodes;
}

function transform(node: MdNode, cwd: string | null): void {
  if (!node.children || node.type === "link" || node.type === "linkReference") return;

  const next: MdNode[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const pieces = splitText(child.value, cwd);
      if (pieces) {
        next.push(...pieces);
        changed = true;
        continue;
      }
      next.push(child);
    } else {
      transform(child, cwd);
      next.push(child);
    }
  }
  if (changed) node.children = next;
}

/** remark plugin: `[remarkFilePaths, { cwd }]`. */
export function remarkFilePaths(options: FilePathOptions): (tree: unknown) => void {
  const cwd = options?.cwd ?? null;
  return (tree: unknown) => {
    transform(tree as MdNode, cwd);
  };
}
