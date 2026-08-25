import { FILTER_LABELS, type FilterGroup } from "../lib/messages.ts";
import { PERMISSION_MODES, type PermissionMode, type SlashCommand } from "../lib/workspace.ts";
import { Sheet } from "./Sheet.tsx";

const FILTER_ORDER: FilterGroup[] = ["user", "agent", "tools", "tasks", "system"];

export function FilterSheet({
  active,
  onToggle,
  onClear,
  onClose,
}: {
  active: ReadonlySet<FilterGroup>;
  onToggle: (group: FilterGroup) => void;
  onClear: () => void;
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
