import { FILTER_LABELS, type FilterGroup } from "../lib/messages.ts";
import { parseResponseFormat } from "../lib/structured-output.ts";
import { PERMISSION_MODES, type PermissionMode, type SlashCommand } from "../lib/workspace.ts";
import { Sheet } from "./Sheet.tsx";

const FILTER_ORDER: FilterGroup[] = ["user", "agent", "tools", "tasks", "system"];

export function FilterSheet({
  active,
  onToggle,
  onClear,
  showTimestamps,
  onShowTimestamps,
  onClose,
}: {
  active: ReadonlySet<FilterGroup>;
  onToggle: (group: FilterGroup) => void;
  onClear: () => void;
  showTimestamps: boolean;
  onShowTimestamps: (show: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      title="Show in transcript"
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className="button ghost"
            disabled={active.size === 0}
            onClick={onClear}
          >
            Show all
          </button>
          <button type="button" className="button" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p className="muted small">
        With nothing selected every message is shown. Selecting groups narrows the transcript to
        those groups.
      </p>
      <ul className="picker">
        {FILTER_ORDER.map((group) => {
          const on = active.has(group);
          return (
            <li key={group}>
              <button
                type="button"
                className={on ? "active" : ""}
                aria-pressed={on}
                onClick={() => onToggle(group)}
              >
                <strong>
                  {FILTER_LABELS[group]}
                  {on ? <span className="tag">shown</span> : null}
                </strong>
              </button>
            </li>
          );
        })}
      </ul>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={showTimestamps}
          onChange={(event) => onShowTimestamps(event.target.checked)}
        />
        Show timestamps
      </label>
    </Sheet>
  );
}

export function PermissionSheet({
  current,
  onPick,
  onClose,
}: {
  current: PermissionMode | null;
  onPick: (mode: PermissionMode) => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      title="Permission mode"
      onClose={onClose}
      status={current === null ? "Waiting for the agent to report its current mode…" : null}
      actions={
        <button type="button" className="button ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <ul className="picker">
        {PERMISSION_MODES.map((mode) => {
          const active = mode.id === current;
          return (
            <li key={mode.id}>
              <button
                type="button"
                className={active ? "active" : ""}
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  onPick(mode.id);
                  onClose();
                }}
              >
                <strong>
                  {mode.label}
                  {active ? <span className="tag">current</span> : null}
                </strong>
                <code>{mode.description}</code>
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

export function CommandSheet({
  commands,
  onRun,
  onClose,
}: {
  commands: SlashCommand[];
  onRun: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      title="Commands"
      onClose={onClose}
      actions={
        <button type="button" className="button ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      {commands.length === 0 ? (
        <p className="muted small">
          The agent has not reported its command list yet. It arrives with the first device status
          after the runtime starts.
        </p>
      ) : null}
      <ul className="picker">
        {commands.map((command) => (
          <li key={command.id}>
            <button
              type="button"
              onClick={() => {
                onRun(command.id);
                onClose();
              }}
            >
              <strong>
                /{command.id}
                {command.args ? <span className="tag">{command.args}</span> : null}
              </strong>
              {command.description ? <code>{command.description}</code> : null}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

/**
 * Per-turn structured output.
 *
 * The schema is free text here and only parsed on demand, so a half-written
 * schema stays editable instead of being wiped: the toggle is disabled with the
 * parse error shown, and the text is kept either way.
 */
export function StructuredOutputSheet({
  text,
  enabled,
  onText,
  onEnabled,
  onClose,
}: {
  text: string;
  enabled: boolean;
  onText: (text: string) => void;
  onEnabled: (enabled: boolean) => void;
  onClose: () => void;
}) {
  const { value, error } = parseResponseFormat(text);
  const canEnable = value !== null;

  return (
    <Sheet
      title="JSON output"
      onClose={onClose}
      actions={
        <button type="button" className="button ghost" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="muted small">
        Constrain the agent&apos;s reply to a JSON Schema. Kept for this conversation, so it
        survives a tab switch or a reload; turn it off when you want plain prose back.
      </p>

      <label className="field">
        Schema
        <textarea
          value={text}
          rows={10}
          spellCheck={false}
          placeholder={
            '{\n  "type": "object",\n  "properties": {\n    "answer": { "type": "string" }\n  },\n  "required": ["answer"]\n}'
          }
          onChange={(event) => onText(event.target.value)}
        />
      </label>

      {error ? <p className="small bad">{error}</p> : null}

      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canEnable}
          onChange={(event) => onEnabled(event.target.checked)}
        />
        Require JSON for this conversation
      </label>

      {!canEnable && text.trim() ? (
        <p className="muted small">
          Fix the schema above to enable this. Turning it off sends messages normally.
        </p>
      ) : null}
    </Sheet>
  );
}
