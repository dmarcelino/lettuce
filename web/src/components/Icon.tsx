/**
 * The app's icons, as inline SVG.
 *
 * Replaces a mix of emoji (🗄 🧠 📁 📄) and dingbats (☰ ■ ↑ ✎ ▾ ⚠ ⚙ ✕ ↻ ↩ ↓)
 * that rendered at different weights and colours depending on the platform's
 * emoji font, and where one glyph could mean two things — `↑` was both "send"
 * and "go to parent directory".
 *
 * One 24×24 grid, one stroke weight, `currentColor`, sized by CSS (`1em`), so
 * an icon always matches the text or button colour around it. Every icon is
 * `aria-hidden`: the accessible name belongs on the button, not the glyph.
 */

export type IconName =
  | "menu"
  | "send"
  | "stop"
  | "filter"
  | "shield"
  | "slash"
  | "model"
  | "up"
  | "folder"
  | "file"
  | "refresh"
  | "edit"
  | "archive"
  | "unarchive"
  | "close"
  | "chevron-right"
  | "chevron-down"
  | "arrow-down"
  | "download"
  | "warning"
  | "memory"
  | "settings"
  | "plus"
  | "task"
  | "braces"
  | "branch"
  | "copy"
  | "check";

/** Path data on a 24×24 grid; stroked, never filled. */
const PATHS: Record<IconName, string> = {
  menu: "M4 7h16M4 12h16M4 17h16",
  send: "M12 19V5M6 11l6-6 6 6",
  stop: "M7 7h10v10H7z",
  filter: "M4 6h16M7 12h10M10 18h4",
  shield: "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z",
  slash: "M9 19l6-14",
  model: "M4 8l8-4 8 4-8 4zM4 12l8 4 8-4M4 16l8 4 8-4",
  up: "M12 19V5M5 12l7-7 7 7",
  folder: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z",
  file: "M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5",
  refresh: "M20 12a8 8 0 11-2.3-5.7M20 4v4h-4",
  edit: "M4 20h4L19 9a2 2 0 00-3-3L5 17zM15 6l3 3",
  archive: "M3 7h18v3H3zM5 10v9h14v-9M10 14h4",
  unarchive: "M20 12a8 8 0 11-2.3-5.7M20 4v4h-4",
  close: "M6 6l12 12M18 6L6 18",
  "chevron-right": "M9 5l7 7-7 7",
  "chevron-down": "M5 9l7 7 7-7",
  "arrow-down": "M12 5v14M5 12l7 7 7-7",
  // An arrow onto a line, not the bare "arrow-down" above: that one already
  // means "scroll to latest", and one glyph meaning two things is the problem
  // this icon set exists to solve.
  download: "M12 4v10M8 10l4 4 4-4M5 19h14",
  warning: "M12 4l9 16H3zM12 10v4M12 17h.01",
  memory:
    "M9 4a3 3 0 00-3 3 3 3 0 00-1 5 3 3 0 001 5 3 3 0 003 3 3 3 0 003-3V7a3 3 0 00-3-3zM15 7a3 3 0 013-3 3 3 0 013 3",
  settings:
    "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 1a7 7 0 00-2-1V5h-4v2a7 7 0 00-2 1L7 7 5 11l2 1a7 7 0 000 2l-2 1 2 4 2-1a7 7 0 002 1v2h4v-2a7 7 0 002-1l2 1 2-4-2-1a7 7 0 000-2z",
  plus: "M12 5v14M5 12h14",
  // Clipboard with a tick: background work that reported back.
  task: "M9 4h6v3H9zM8 5H6a1 1 0 00-1 1v13a1 1 0 001 1h12a1 1 0 001-1V6a1 1 0 00-1-1h-2M9 13l2 2 4-4",
  // Curly braces: a JSON-schema-constrained reply.
  braces:
    "M8 4c-2 0-2 2-2 4s0 4-2 4c2 0 2 2 2 4s0 4 2 4M16 4c2 0 2 2 2 4s0 4 2 4c-2 0-2 2-2 4s0 4-2 4",
  // Git branch: two nodes on a line with a diverging one.
  branch:
    "M7 5v10M7 19a2 2 0 100-4 2 2 0 000 4zM7 7a2 2 0 100-4 2 2 0 000 4zM17 9a2 2 0 100-4 2 2 0 000 4zM17 9c0 4-4 4-4 8",
  // Two overlapping sheets: copy to the clipboard.
  copy: "M9 9h10v10H9zM15 9V5H5v10h4",
  check: "M5 12l5 5 9-10",
};

interface Props {
  name: IconName;
  /** Extra classes; `icon` is always applied. */
  className?: string;
}

export function Icon({ name, className }: Props) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
