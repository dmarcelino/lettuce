import { useEffect, useRef, useState } from "react";
import { clearDraft, readDraft, writeDraft } from "../lib/draft.ts";
import type { FilterGroup } from "../lib/messages.ts";
import {
  matchSlashCommands,
  PERMISSION_MODES,
  type PermissionMode,
  parseSlashCommand,
  type SlashCommand,
} from "../lib/workspace.ts";
import { CommandSheet, FilterSheet, PermissionSheet } from "./ComposerSheets.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  disabled: boolean;
  processing: boolean;
  /**
   * `<agentId>::<conversationId>`, or `null` with no conversation selected.
   * The composer unmounts on every tab switch, so what was typed is kept
   * under this key and restored on the way back. See `lib/draft.ts`.
   */
  draftKey: string | null;
  onSend: (text: string) => void;
  onAbort: () => void;
  /** A stop was accepted but the turn has not ended yet. */
  stopping: boolean;
  filters: ReadonlySet<FilterGroup>;
  onToggleFilter: (group: FilterGroup) => void;
  onClearFilters: () => void;
  permissionMode: PermissionMode | null;
  onPermissionMode: (mode: PermissionMode) => void;
  commands: SlashCommand[];
  onRunCommand: (id: string, args?: string) => void;
  onOpenModels: () => void;
  modelsDisabled: boolean;
  /** The model in force for this conversation; shown on the button on desktop. */
  modelLabel: string | null;
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
  draftKey,
  onSend,
  onAbort,
  stopping,
  filters,
  onToggleFilter,
  onClearFilters,
  permissionMode,
  onPermissionMode,
  commands,
  onRunCommand,
  onOpenModels,
  modelsDisabled,
  modelLabel,
}: Props) {
  const [value, setValue] = useState(() => (draftKey ? readDraft(draftKey) : ""));
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [highlight, setHighlight] = useState(0);
  /** Escape closes the popover without clearing what was typed. */
  const [dismissed, setDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** Persist every edit so a tab switch (which unmounts this) does not lose it. */
  const remember = (next: string) => {
    if (draftKey) writeDraft(draftKey, next);
  };

  // Switching conversation without leaving the Chat tab keeps this mounted, so
  // the lazy initialiser above never re-runs — reload the draft for the new
  // conversation here. (Also runs on mount, harmlessly setting the same value.)
  useEffect(() => {
    setValue(draftKey ? readDraft(draftKey) : "");
    setHighlight(0);
    setDismissed(false);
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    // The restored value has not hit the DOM yet; grow to fit it after paint,
    // the same clamp `onChange` uses, so a multi-line draft is not squashed.
    const frame = requestAnimationFrame(() => {
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    });
    return () => cancelAnimationFrame(frame);
  }, [draftKey]);

  const suggestions = disabled || dismissed ? [] : matchSlashCommands(value, commands);
  const highlighted = suggestions.length > 0 ? Math.min(highlight, suggestions.length - 1) : -1;
  const active = highlighted >= 0 ? suggestions[highlighted] : undefined;

  const reset = () => {
    setValue("");
    if (draftKey) clearDraft(draftKey);
    setHighlight(0);
    setDismissed(false);
    const textarea = textareaRef.current;
    if (textarea) textarea.style.height = "auto";
  };

  /** Fill the box with a command name and leave the caret ready for its args. */
  const complete = (id: string) => {
    setValue(`/${id} `);
    remember(`/${id} `);
    setHighlight(0);
    textareaRef.current?.focus();
  };

  /**
   * Take a suggestion. One that declares arguments is completed rather than
   * fired: running it bare would hand the mod an empty `args` to work with.
   */
  const choose = (command: SlashCommand) => {
    if (command.args) {
      complete(command.id);
      return;
    }
    onRunCommand(command.id);
    reset();
  };

  /**
   * Send what is in the box — or run it, when it names a command.
   *
   * The app-server's message path never inspects a leading slash: that parsing
   * lives only in the CLI, and running a command over the protocol takes an
   * explicit `execute_command` frame. So without this branch a typed "/clear"
   * reaches the agent as a literal question. `parseSlashCommand` matches only
   * advertised ids, which is what keeps a pasted path a message.
   */
  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;

    const command = parseSlashCommand(text, commands);
    if (command) {
      onRunCommand(command.id, command.args);
      reset();
      return;
    }

    // Send is the primary action on a phone, where Enter is a newline key. With
    // the popover open it therefore has to do what Enter does on a hardware
    // keyboard — take the highlighted command — rather than hand the agent a
    // half-typed "/cl".
    if (active) {
      choose(active);
      return;
    }

    onSend(text);
    reset();
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
        {/* Above the textarea, not below: on a phone the on-screen keyboard
            owns the bottom half of the viewport, so a list rendered under the
            composer would open behind it. */}
        {active ? (
          <ul className="composer-suggestions picker" id="composer-suggestions">
            {suggestions.map((command, index) => (
              <li key={command.id}>
                <button
                  type="button"
                  id={`composer-suggestion-${command.id}`}
                  className={index === highlighted ? "active" : undefined}
                  // Mouse-down, not click: click lands after the textarea has
                  // lost focus and the popover has already unmounted.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(command);
                  }}
                  onMouseEnter={() => setHighlight(index)}
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
        ) : null}

        <div className="composer-box">
          <textarea
            ref={textareaRef}
            value={value}
            rows={1}
            placeholder={disabled ? "Select a conversation" : "Message the agent…"}
            disabled={disabled}
            onChange={(event) => {
              setValue(event.target.value);
              remember(event.target.value);
              setHighlight(0);
              setDismissed(false);
              const textarea = event.target;
              textarea.style.height = "auto";
              textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
            }}
            onKeyDown={(event) => {
              // An IME mid-composition owns every key; the send button is still
              // there for anyone who needs it.
              if (event.nativeEvent.isComposing) return;

              if (active) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setHighlight((highlighted + step + suggestions.length) % suggestions.length);
                  return;
                }
                if (event.key === "Tab") {
                  event.preventDefault();
                  complete(active.id);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissed(true);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  // The popover is open, so Enter takes the highlighted command
                  // rather than sending a half-typed name to the agent.
                  event.preventDefault();
                  choose(active);
                  return;
                }
              }

              // Enter sends; Shift+Enter is a newline. On touch keyboards Enter is
              // usually a newline key, so the send button carries the same action.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            aria-controls={active ? "composer-suggestions" : undefined}
            aria-activedescendant={active ? `composer-suggestion-${active.id}` : undefined}
          />

          <div className="composer-row">
            {/* Command on the left; everything else clusters by the send button. */}
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

            <span className="spacer" />

            <button
              type="button"
              className={`icon-button flat${filters.size > 0 ? " on" : ""}`}
              onClick={() => setSheet("filters")}
              title={
                filters.size > 0 ? `Filters (${filters.size} active)` : "Filter the transcript"
              }
              aria-label={
                filters.size > 0 ? `Filters, ${filters.size} active` : "Filter the transcript"
              }
            >
              <Icon name="filter" />
              {filters.size > 0 ? <span className="badge">{filters.size}</span> : null}
            </button>

            {/* Icon only: the shield's colour carries the mode, ordered by how
              much the agent may do without asking. Colour is never the sole
              channel — the accessible name spells the mode out, and the sheet
              marks the current one. */}
            <button
              type="button"
              className={`icon-button flat mode-${permissionMode ?? "unknown"}`}
              disabled={disabled}
              onClick={() => setSheet("permissions")}
              title={`Permission mode: ${modeLabel}`}
              aria-label={`Permission mode: ${modeLabel}`}
            >
              <Icon name="shield" />
            </button>

            <button
              type="button"
              className="icon-button flat model-btn"
              disabled={modelsDisabled}
              onClick={onOpenModels}
              title={modelLabel ? `Model: ${modelLabel}` : "Model for this conversation"}
              aria-label={modelLabel ? `Model: ${modelLabel}` : "Model for this conversation"}
            >
              <Icon name="model" />
              {modelLabel ? <span className="model-name">{modelLabel}</span> : null}
            </button>

            {processing ? (
              // A second abort while the first is still unwinding is a guaranteed
              // no-op upstream (`handleAbortMessageInput` returns early once the
              // turn lifecycle is `cancelling`), so the button stops offering it.
              <button
                type="button"
                className={`icon-button stop${stopping ? " pending" : ""}`}
                onClick={onAbort}
                disabled={stopping}
                title={stopping ? "Stopping…" : "Stop"}
                aria-label={stopping ? "Stopping" : "Stop generating"}
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
