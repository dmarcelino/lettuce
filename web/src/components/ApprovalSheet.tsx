import { useState } from "react";
import { useBackToClose } from "../state/use-back-to-close.ts";
import type { PendingApproval } from "../state/use-conversation.ts";

interface Props {
  approval: PendingApproval;
  onRespond: (requestId: string, approve: boolean, reason?: string) => void;
  onAnswerQuestions: (
    requestId: string,
    input: Record<string, unknown>,
    answers: Record<string, string>,
  ) => void;
}

interface DiffHunkLine {
  type: "context" | "add" | "remove";
  content: string;
}

function DiffView({ diffs }: { diffs: unknown[] }) {
  return (
    <>
      {diffs.map((raw, index) => {
        const diff = raw as {
          mode?: string;
          fileName?: string;
          hunks?: { lines?: DiffHunkLine[] }[];
          reason?: string;
        };
        return (
          <div className="diff" key={`${diff.fileName ?? "diff"}-${index}`}>
            <div className="diff-file">{diff.fileName ?? "(file)"}</div>
            {diff.mode === "advanced" && Array.isArray(diff.hunks) ? (
              <pre>
                {diff.hunks.flatMap((hunk, hunkIndex) =>
                  (hunk.lines ?? []).map((line, lineIndex) => (
                    <span className={`dl ${line.type}`} key={`${hunkIndex}-${lineIndex}`}>
                      {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                      {line.content}
                      {"\n"}
                    </span>
                  )),
                )}
              </pre>
            ) : (
              <p className="muted">{diff.reason ?? "No preview available"}</p>
            )}
          </div>
        );
      })}
    </>
  );
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/**
 * `AskUserQuestion`'s `input.questions` (see the fork's
 * `tools/impl/ask-user-question.ts`) — validated defensively since it comes
 * off the wire as `Record<string, unknown>`. A malformed shape returns `[]`,
 * which sends the caller back to the generic JSON-dump rendering below rather
 * than showing a broken form.
 */
export function parseQuestions(input: Record<string, unknown>): Question[] {
  if (!Array.isArray(input.questions)) return [];
  return input.questions.flatMap((raw): Question[] => {
    if (!raw || typeof raw !== "object") return [];
    const q = raw as Record<string, unknown>;
    if (typeof q.question !== "string" || typeof q.header !== "string") return [];
    if (!Array.isArray(q.options)) return [];
    const options = q.options.flatMap((raw): QuestionOption[] => {
      if (!raw || typeof raw !== "object") return [];
      const opt = raw as Record<string, unknown>;
      if (typeof opt.label !== "string") return [];
      return [
        {
          label: opt.label,
          description: typeof opt.description === "string" ? opt.description : "",
        },
      ];
    });
    if (options.length < 2) return [];
    return [
      { question: q.question, header: q.header, options, multiSelect: q.multiSelect === true },
    ];
  });
}

/** Sentinel for the always-available "Other" option — never a real option label. */
const OTHER = "__other__";

/**
 * The agent's own multi-question, multi-select-capable form — the same
 * contract the CLI's `InlineQuestionApproval` and the Telegram gateway's
 * `channels/interactive.ts` both answer, just laid out as one page instead of
 * a one-question-at-a-time wizard (there's room for it, and nothing forces
 * sequential answering in a mouse/touch UI).
 */
function AskUserQuestionForm({
  questions,
  selections,
  onToggle,
  customText,
  onCustomText,
}: {
  questions: Question[];
  selections: ReadonlySet<string>[];
  onToggle: (questionIndex: number, label: string) => void;
  customText: string[];
  onCustomText: (questionIndex: number, text: string) => void;
}) {
  return (
    <>
      {questions.map((q, qIndex) => (
        // Order is stable — `questions` comes from one wire payload, never reordered.
        // biome-ignore lint/suspicious/noArrayIndexKey: stable within one approval
        <div className="question-block" key={qIndex}>
          <span className="tag">{q.header}</span>
          <p className="question-text">{q.question}</p>
          <ul className="picker">
            {q.options.map((option) => {
              const active = selections[qIndex]?.has(option.label) ?? false;
              return (
                <li key={option.label}>
                  <button
                    type="button"
                    className={active ? "active" : ""}
                    aria-pressed={active}
                    onClick={() => onToggle(qIndex, option.label)}
                  >
                    <strong>{option.label}</strong>
                    {option.description ? <code>{option.description}</code> : null}
                  </button>
                </li>
              );
            })}
            <li>
              <button
                type="button"
                className={selections[qIndex]?.has(OTHER) ? "active" : ""}
                aria-pressed={selections[qIndex]?.has(OTHER) ?? false}
                onClick={() => onToggle(qIndex, OTHER)}
              >
                <strong>Other</strong>
              </button>
              {selections[qIndex]?.has(OTHER) ? (
                <div className="field">
                  <input
                    placeholder="Type your answer…"
                    value={customText[qIndex] ?? ""}
                    onChange={(event) => onCustomText(qIndex, event.target.value)}
                  />
                </div>
              ) : null}
            </li>
          </ul>
        </div>
      ))}
    </>
  );
}

export function ApprovalSheet({ approval, onRespond, onAnswerQuestions }: Props) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [selections, setSelections] = useState<Set<string>[]>([]);
  const [customText, setCustomText] = useState<string[]>([]);
  // Undismissable by design — an approval has to be answered. Back is
  // swallowed so it neither hides the prompt nor exits the app beneath it.
  useBackToClose(() => false);

  const questions = approval.toolName === "AskUserQuestion" ? parseQuestions(approval.input) : [];

  if (questions.length > 0) {
    const toggle = (questionIndex: number, label: string) => {
      setSelections((current) => {
        const next = [...current];
        const existing = new Set(next[questionIndex]);
        if (questions[questionIndex]?.multiSelect) {
          if (existing.has(label)) existing.delete(label);
          else existing.add(label);
        } else {
          existing.clear();
          existing.add(label);
        }
        next[questionIndex] = existing;
        return next;
      });
    };

    const setCustom = (questionIndex: number, text: string) => {
      setCustomText((current) => {
        const next = [...current];
        next[questionIndex] = text;
        return next;
      });
    };

    // A question is answered once it has a selection, and — if "Other" is
    // among the selections — once that free-text box is non-empty too.
    const ready = questions.every((_q, index) => {
      const chosen = selections[index];
      if (!chosen || chosen.size === 0) return false;
      if (chosen.has(OTHER) && !(customText[index] ?? "").trim()) return false;
      return true;
    });

    const submit = () => {
      const answers: Record<string, string> = {};
      questions.forEach((q, index) => {
        const chosen = Array.from(selections[index] ?? []);
        const labels = chosen
          .map((label) => (label === OTHER ? (customText[index] ?? "").trim() : label))
          .filter(Boolean);
        answers[q.question] = labels.join(", ");
      });
      onAnswerQuestions(approval.requestId, approval.input, answers);
    };

    return (
      <div className="sheet">
        <div className="sheet-panel sheet-spacious" role="dialog" aria-modal="true">
          <div className="sheet-body">
            <h2>
              {questions.length > 1 ? "The agent has some questions" : "The agent has a question"}
            </h2>
            <AskUserQuestionForm
              questions={questions}
              selections={selections}
              onToggle={toggle}
              customText={customText}
              onCustomText={setCustom}
            />
          </div>
          <div className="sheet-actions">
            <button
              type="button"
              className="button ghost"
              onClick={() => onRespond(approval.requestId, false, "Skipped by user")}
            >
              Skip
            </button>
            <button type="button" className="button" disabled={!ready} onClick={submit}>
              Submit
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sheet">
      <div className="sheet-panel sheet-spacious" role="dialog" aria-modal="true">
        <div className="sheet-body">
          <h2>Approve {approval.toolName}?</h2>

          {approval.blockedPath ? (
            <p className="warning">
              Blocked path: <code>{approval.blockedPath}</code>
            </p>
          ) : null}

          {approval.diffs.length > 0 ? (
            <DiffView diffs={approval.diffs} />
          ) : (
            <pre className="tool-args">{JSON.stringify(approval.input, null, 2)}</pre>
          )}

          {approval.suggestions.length > 0 ? (
            <ul className="suggestions">
              {approval.suggestions.map((suggestion) => (
                <li key={suggestion.id}>{suggestion.text}</li>
              ))}
            </ul>
          ) : null}

          {denying ? (
            <textarea
              className="deny-reason"
              placeholder="Why? (optional — the agent sees this)"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          ) : null}
        </div>

        <div className="sheet-actions">
          {denying ? (
            <>
              <button type="button" className="button ghost" onClick={() => setDenying(false)}>
                Back
              </button>
              <button
                type="button"
                className="button danger"
                onClick={() => onRespond(approval.requestId, false, reason.trim() || undefined)}
              >
                Deny
              </button>
            </>
          ) : (
            <>
              <button type="button" className="button ghost" onClick={() => setDenying(true)}>
                Deny
              </button>
              <button
                type="button"
                className="button"
                onClick={() => onRespond(approval.requestId, true)}
              >
                Approve
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
