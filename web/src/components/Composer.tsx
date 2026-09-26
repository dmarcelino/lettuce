import { useEffect, useRef, useState } from "react";
import { clearDraft, readDraft, writeDraft } from "../lib/draft.ts";
import {
  AT_DRAFT,
  caretAllowsHistory,
  type HistoryCursor,
  historyDown,
  historyUp,
} from "../lib/input-history.ts";
import { enterSends } from "../lib/input-mode.ts";
import type { FilterGroup } from "../lib/messages.ts";
import { parseResponseFormat, type ResponseFormat } from "../lib/structured-output.ts";
import { type TurnUsage, usageDescription, usageLabel } from "../lib/usage.ts";
import {
  matchSlashCommands,
  PERMISSION_MODES,
  type PermissionMode,
  parseSlashCommand,
  type SlashCommand,
} from "../lib/workspace.ts";
import {
  CommandSheet,
  FilterSheet,
  PermissionSheet,
  StructuredOutputSheet,
} from "./ComposerSheets.tsx";
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
  onSend: (text: string, responseFormat: ResponseFormat | null) => void;
  /**
   * Structured-output state, owned by the caller so it survives this component
   * unmounting on a tab switch. `structuredText` is the schema as typed;
   * `structuredEnabled` decides whether the next send carries it.
   * `structuredSupported` is the `structured_outputs` capability — the
   * control is hidden without it.
   */
  structuredText: string;
  structuredEnabled: boolean;
  structuredSupported: boolean;
  onStructuredChange: (text: string, enabled: boolean) => void;
  onAbort: () => void;
  /** A stop was accepted but the turn has not ended yet. */
  stopping: boolean;
  filters: ReadonlySet<FilterGroup>;
  onToggleFilter: (group: FilterGroup) => void;
  onClearFilters: () => void;
  /** Transcript timestamps; the toggle lives in the filter sheet. */
  showTimestamps: boolean;
  onShowTimestamps: (show: boolean) => void;
  permissionMode: PermissionMode | null;
  onPermissionMode: (mode: PermissionMode) => void;
  commands: SlashCommand[];
  onRunCommand: (id: string, args?: string) => void;
  onOpenModels: () => void;
  modelsDisabled: boolean;
  /** The model in force for this conversation; shown on the button on desktop. */
  modelLabel: string | null;
  /** Tokens spent by the last finished turn; hidden while one is running. */
  lastTurnUsage: TurnUsage | null;
  /** This conversation's past user messages, oldest first, for ↑/↓ recall. */
  history: readonly string[];
  /**
   * Text to put in the box — "Edit" on your last message. Applied once, then
   * `onPrefillApplied` clears it: the composer unmounts on a tab switch, and a
   * request still standing would overwrite the draft on every remount.
   */
  prefill: string | null;
  onPrefillApplied: () => void;
  /** Open the agents-and-conversations switcher (phone only; see styles). */
  onOpenSwitcher: () => void;
}

type OpenSheet = "filters" | "permissions" | "commands" | "structured" | null;

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
  showTimestamps,
  onShowTimestamps,
  permissionMode,
  onPermissionMode,
  commands,
  onRunCommand,
  onOpenModels,
  modelsDisabled,
  modelLabel,
  lastTurnUsage,
  history,
  prefill,
  onPrefillApplied,
  onOpenSwitcher,
  structuredText,
  structuredEnabled,
  structuredSupported,
  onStructuredChange,
}: Props) {
  const [value, setValue] = useState(() => (draftKey ? readDraft(draftKey) : ""));
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [highlight, setHighlight] = useState(0);
  /** Escape closes the popover without clearing what was typed. */
  const [dismissed, setDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /**
   * Position in `history`. A ref: moving through history re-renders through
   * `value` anyway. The saved draft lives here, not in draft storage, so the
   * stored draft is always what was typed — never a recalled message.
   */
  const cursorRef = useRef<HistoryCursor>(AT_DRAFT);

  /** Persist every edit so a tab switch (which unmounts this) does not lose it. */
  const remember = (next: string) => {
    if (draftKey) writeDraft(draftKey, next);
  };

  // Switching conversation without leaving the Chat tab keeps this mounted, so
  // the lazy initialiser above never re-runs — reload the draft for the new
  // conversation here. (Also runs on mount, harmlessly setting the same value.)
  useEffect(() => {
    setValue(draftKey ? readDraft(draftKey) : "");
    cursorRef.current = AT_DRAFT;
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

  // "Edit" on your last message: the text replaces what is in the box, ready to
  // change and send as a new message (a sent message cannot be rewritten).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per request, not per render.
  useEffect(() => {
    if (prefill === null) return;
    setValue(prefill);
    remember(prefill);
    cursorRef.current = AT_DRAFT;
    setDismissed(true);
    onPrefillApplied();
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    requestAnimationFrame(() => {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
      textarea.setSelectionRange(prefill.length, prefill.length);
    });
  }, [prefill]);

  const suggestions = disabled || dismissed ? [] : matchSlashCommands(value, commands);
  const highlighted = suggestions.length > 0 ? Math.min(highlight, suggestions.length - 1) : -1;
  const active = highlighted >= 0 ? suggestions[highlighted] : undefined;

  const reset = () => {
    setValue("");
    cursorRef.current = AT_DRAFT;
    if (draftKey) clearDraft(draftKey);
    setHighlight(0);
    setDismissed(false);
    const textarea = textareaRef.current;
    if (textarea) textarea.style.height = "auto";
  };

  /**
   * Put a recalled message (or the restored draft) in the box, sized to fit,
   * with the caret at the end — so a further ↓ continues at once and a further
   * ↑ first walks up through a multi-line message, as in a shell.
   */
  const recall = (next: string) => {
    setValue(next);
    // A recalled "/command" must not reopen the popover and steal the arrows.
    setDismissed(true);
    const textarea = textareaRef.current;
    if (!textarea) return;
    requestAnimationFrame(() => {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
      textarea.setSelectionRange(next.length, next.length);
    });
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

    // A schema that stopped parsing between toggling and sending must not
    // silently ride along; drop it and let the turn go unstructured.
    const parsed = structuredEnabled ? parseResponseFormat(structuredText) : null;
    onSend(text, parsed?.value ?? null);
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
              // Editing a recalled message makes it the draft.
              cursorRef.current = AT_DRAFT;
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
                if (event.key === "Enter" && !event.shiftKey && enterSends()) {
                  // The popover is open, so Enter takes the highlighted command
                  // rather than sending a half-typed name to the agent.
                  event.preventDefault();
                  choose(active);
                  return;
                }
              }

              if (
                (event.key === "ArrowUp" || event.key === "ArrowDown") &&
                !event.shiftKey &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey
              ) {
                const target = event.currentTarget;
                if (
                  caretAllowsHistory(
                    event.key,
                    target.value,
                    target.selectionStart,
                    target.selectionEnd,
                  )
                ) {
                  const step =
                    event.key === "ArrowUp"
                      ? historyUp(history, cursorRef.current, value)
                      : historyDown(history, cursorRef.current);
                  if (step) {
                    event.preventDefault();
                    cursorRef.current = step.cursor;
                    recall(step.value);
                    return;
                  }
                }
              }

              // Enter sends; Shift+Enter is a newline. On a phone Enter is always a
              // newline and only the send button sends (see `enterSends`).
              if (event.key === "Enter" && !event.shiftKey && enterSends()) {
                event.preventDefault();
                submit();
              }
            }}
            aria-controls={active ? "composer-suggestions" : undefined}
            aria-activedescendant={active ? `composer-suggestion-${active.id}` : undefined}
          />

          <div className="composer-row">
            {/* Only the switcher on the left; every other control clusters by the
                send button, under the thumb. The switcher button is phone-only —
                the desktop has the pinned sidebar. */}
            <button
              type="button"
              className="icon-button flat switcher-button"
              onClick={onOpenSwitcher}
              title="Agents and conversations"
              aria-label="Agents and conversations"
            >
              <Icon name="chats" />
            </button>

            <span className="spacer" />

            {lastTurnUsage && !processing ? (
              <span
                className="turn-usage"
                role="note"
                title={usageDescription(lastTurnUsage)}
                aria-label={usageDescription(lastTurnUsage)}
              >
                {usageLabel(lastTurnUsage)}
              </span>
            ) : null}

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

            {structuredSupported ? (
              <button
                type="button"
                className={`icon-button flat${structuredEnabled ? " on" : ""}`}
                onClick={() => setSheet("structured")}
                title={
                  structuredEnabled
                    ? "JSON output is required for the next message"
                    : "Require JSON output"
                }
                aria-label={
                  structuredEnabled
                    ? "JSON output required for the next message"
                    : "Require JSON output"
                }
              >
                <Icon name="braces" />
              </button>
            ) : null}

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
          showTimestamps={showTimestamps}
          onShowTimestamps={onShowTimestamps}
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

      {sheet === "structured" ? (
        <StructuredOutputSheet
          text={structuredText}
          enabled={structuredEnabled}
          onText={(next) => onStructuredChange(next, structuredEnabled)}
          onEnabled={(next) => onStructuredChange(structuredText, next)}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}
