import { useRef, useState } from "react";
import type { FilterGroup } from "../lib/messages.ts";
import { PERMISSION_MODES, type PermissionMode, type SlashCommand } from "../lib/workspace.ts";
import { CommandSheet, FilterSheet, PermissionSheet } from "./ComposerSheets.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  disabled: boolean;
  processing: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  filters: ReadonlySet<FilterGroup>;
  onToggleFilter: (group: FilterGroup) => void;
  onClearFilters: () => void;
  permissionMode: PermissionMode | null;
  onPermissionMode: (mode: PermissionMode) => void;
  commands: SlashCommand[];
  onRunCommand: (id: string) => void;
  onOpenModels: () => void;
  modelsDisabled: boolean;
}

type OpenSheet = "filters" | "permissions" | "commands" | null;

/**
 * The single control surface for a turn: the textarea plus one row of controls
 * beneath it. Everything that used to sit in a chip row above the transcript
 * lives here instead — on a phone that row cost a whole line of vertical space
 * and put the model picker as far from the input as it could be.
 */
export function Composer({
  disabled,
  processing,
  onSend,
  onAbort,
  filters,
  onToggleFilter,
  onClearFilters,
  permissionMode,
  onPermissionMode,
  commands,
  onRunCommand,
  onOpenModels,
  modelsDisabled,
}: Props) {
  const [value, setValue] = useState("");
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
    const textarea = textareaRef.current;
    if (textarea) textarea.style.height = "auto";
  };

  const modeLabel =
    PERMISSION_MODES.find((mode) => mode.id === permissionMode)?.label ?? "Permissions";

  return (
    <>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          placeholder={disabled ? "Select a conversation" : "Message the agent…"}
          disabled={disabled}
          onChange={(event) => {
            setValue(event.target.value);
            const textarea = event.target;
            textarea.style.height = "auto";
            textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
          }}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a newline. On touch keyboards Enter is
            // usually a newline key, so the send button carries the same action.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="composer-row">
          <button
            type="button"
            className={`icon-button flat${filters.size > 0 ? " on" : ""}`}
            onClick={() => setSheet("filters")}
            title={filters.size > 0 ? `Filters (${filters.size} active)` : "Filter the transcript"}
            aria-label={
              filters.size > 0 ? `Filters, ${filters.size} active` : "Filter the transcript"
            }
          >
            <Icon name="filter" />
            {filters.size > 0 ? <span className="badge">{filters.size}</span> : null}
          </button>

          {/* An icon alone cannot distinguish Unrestricted from Strict, so the
              mode name rides along and the icon carries the severity colour. */}
          <button
            type="button"
            className={`icon-button flat mode-${permissionMode ?? "unknown"}`}
            disabled={disabled}
            onClick={() => setSheet("permissions")}
            title={`Permission mode: ${modeLabel}`}
            aria-label={`Permission mode: ${modeLabel}`}
          >
            <Icon name="shield" />
            <span className="button-label">{modeLabel}</span>
          </button>

          <button
            type="button"
            className="icon-button flat"
            disabled={disabled}
            onClick={() => setSheet("commands")}
            title="Run a command"
            aria-label="Run a command"
          >
            <Icon name="slash" />
          </button>

          <button
            type="button"
            className="icon-button flat"
            disabled={modelsDisabled}
            onClick={onOpenModels}
            title="Model for this conversation"
            aria-label="Model for this conversation"
          >
            <Icon name="model" />
          </button>

          <span className="spacer" />

          {processing ? (
            <button
              type="button"
              className="icon-button stop"
              onClick={onAbort}
              title="Stop"
              aria-label="Stop generating"
            >
              <Icon name="stop" />
            </button>
          ) : (
            <button
              type="submit"
              className="icon-button send"
              disabled={disabled || !value.trim()}
              title="Send"
              aria-label="Send message"
            >
              <Icon name="send" />
            </button>
          )}
        </div>
      </form>

      {sheet === "filters" ? (
        <FilterSheet
          active={filters}
          onToggle={onToggleFilter}
          onClear={onClearFilters}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {sheet === "permissions" ? (
        <PermissionSheet
          current={permissionMode}
          onPick={onPermissionMode}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {sheet === "commands" ? (
        <CommandSheet commands={commands} onRun={onRunCommand} onClose={() => setSheet(null)} />
      ) : null}
    </>
  );
}
