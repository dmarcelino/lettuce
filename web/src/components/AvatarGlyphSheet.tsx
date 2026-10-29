import { useState } from "react";
import { graphemeCount } from "../lib/agent-tint.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { Sheet } from "./Sheet.tsx";

/**
 * The glyphs offered before anyone is asked to type one: common enough to render
 * in every phone's emoji font, and broad enough that most agents find a face.
 * A free-text box sits under the grid, so this list is a starting point and not
 * the whole alphabet.
 */
const GLYPHS = [
  "🤖",
  "🦊",
  "🦉",
  "🐙",
  "🐝",
  "🐢",
  "🌿",
  "🔥",
  "⚡",
  "❄️",
  "🌙",
  "⭐",
  "🧠",
  "👁️",
  "📚",
  "📝",
  "📅",
  "✉️",
  "🛠️",
  "⚙️",
  "🧩",
  "🔒",
  "🚀",
  "🛰️",
];

interface Props {
  agentId: string;
  name: string;
  /** The tint staged in the form, so the preview is the face the agent will get. */
  tint?: string;
  /** The glyph staged so far. */
  glyph?: string;
  /** Stages the choice into the form; Save still commits it. */
  onPick: (glyph: string | null) => void;
  onClose: () => void;
}

/**
 * Picking an agent's glyph, in a sheet because twenty-four tiles do not belong
 * inline on a phone. It stages a pick into Agent → General and closes, exactly
 * as the model sheet does in that same form — nothing is written until Save.
 */
export function AvatarGlyphSheet({ agentId, name, tint, glyph, onPick, onClose }: Props) {
  const [pick, setPick] = useState(glyph ?? "");
  // The BFF applies the real rule; this one exists so the box says so while
  // typing instead of failing on Save.
  const tooLong = pick.trim() !== "" && graphemeCount(pick) > 2;

  return (
    <Sheet
      title="Avatar glyph"
      onClose={onClose}
      status={tooLong ? "One emoji, or two at most." : null}
      actions={
        <>
          <button
            type="button"
            className="button ghost leading"
            onClick={() => {
              onPick(null);
              onClose();
            }}
          >
            Clear glyph
          </button>
          <button
            type="button"
            className="button"
            disabled={tooLong}
            onClick={() => {
              onPick(pick.trim() || null);
              onClose();
            }}
          >
            Done
          </button>
        </>
      }
    >
      <div className="avatar-preview-row">
        <AgentAvatar
          agentId={agentId}
          name={name}
          pref={{ tint, glyph: pick || undefined }}
          className="agent-avatar avatar-preview"
        />
        <span className="small">on the tint picked in the form</span>
      </div>
      <div className="avatar-grid">
        {GLYPHS.map((option) => (
          <button
            key={option}
            type="button"
            className={`avatar-glyph${pick === option ? " sel" : ""}`}
            aria-pressed={pick === option}
            onClick={() => setPick(option)}
          >
            {option}
          </button>
        ))}
      </div>
      <label className="avatar-custom">
        <input
          value={pick}
          placeholder="🦊"
          aria-label="Or type any emoji"
          onChange={(event) => setPick(event.target.value)}
        />
        <span className="small">or type any emoji — one, or two at most</span>
      </label>
    </Sheet>
  );
}
