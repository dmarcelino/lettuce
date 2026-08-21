import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer noopener">
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

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
