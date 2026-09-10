import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { downloadUrl } from "../lib/download.ts";
import { remarkFilePaths } from "../lib/file-links.ts";
import { WORKSPACE_ROOT } from "../lib/workspace.ts";

/**
 * A link to a file the agent produced (always an absolute
 * /work/<agent-id>/... path — that's the only path form the file protocol
 * and cwd ever give it, and the one `remarkFilePaths` resolves bare paths to)
 * is rewritten to the BFF's download route: the SPA has no route at that path,
 * so left alone the click just landed on a blank tab. `inline` so a PDF or
 * image opens in the tab to be read rather than downloading. Every other href
 * passes through untouched.
 */
export function resolveMarkdownHref(href: string | undefined): string | undefined {
  if (typeof href === "string" && href.startsWith(`${WORKSPACE_ROOT}/`)) {
    return downloadUrl(href, { inline: true });
  }
  return href;
}

/**
 * Model output is markdown, so render it as such.
 *
 * Deliberately no `rehype-raw`: react-markdown builds React elements and
 * ignores raw HTML by default, so nothing the model (or a tool result quoted
 * back by it) emits can inject markup. No `dangerouslySetInnerHTML` anywhere,
 * so no sanitiser is needed.
 */
const COMPONENTS: Components = {
  // Links leave the app, so they open in a new tab and cannot leak the
  // referrer or hand the opened page a handle on this window.
  a: ({ children, href, ...props }) => (
    <a {...props} href={resolveMarkdownHref(href)} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  // Wide content scrolls inside the bubble instead of widening the page.
  pre: ({ children, ...props }) => (
    <pre {...props} className="md-pre">
      {children}
    </pre>
  ),
  table: ({ children, ...props }) => (
    <div className="md-table-wrap">
      <table {...props}>{children}</table>
    </div>
  ),
};

export function Markdown({ text, cwd }: { text: string; cwd?: string | null }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkFilePaths, { cwd: cwd ?? null }]]}
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
