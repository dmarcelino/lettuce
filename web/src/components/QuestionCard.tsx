import type {
  AskUserQuestion,
  AskUserQuestionReceipt,
  AskUserQuestionResponse,
} from "@letta-ai/letta-code/ask-user-question";
import { useState } from "react";
import { Icon } from "./Icon.tsx";

/** Sentinel for the always-available "Other" option — never a real option label. */
export const OTHER = "__other__";

/**
 * A question is answered once it has a selection, and — if "Other" is among
 * the selections — once that free-text box is non-empty too.
 */
export function questionReady(
  questions: AskUserQuestion[],
  selections: ReadonlySet<string>[],
  customText: ReadonlyArray<string>,
): boolean {
  return questions.every((_q, index) => {
    const chosen = selections[index];
    if (!chosen || chosen.size === 0) return false;
    if (chosen.has(OTHER) && !(customText[index] ?? "").trim()) return false;
    return true;
  });
}

/** `answers` for the response: one non-empty string per question, joined picks. */
export function buildAnswers(
  questions: AskUserQuestion[],
  selections: ReadonlySet<string>[],
  customText: ReadonlyArray<string>,
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((q, index) => {
    const chosen = Array.from(selections[index] ?? []);
    const labels = chosen
      .map((label) => (label === OTHER ? (customText[index] ?? "").trim() : label))
      .filter(Boolean);
    answers[q.question] = labels.join(", ");
  });
  return answers;
}

interface Props {
  receipt: AskUserQuestionReceipt;
  /**
   * The answer already sitting in the transcript — lifted out of the
   * `<task-notification>` the user message carried. Present means read-only.
   */
  response: AskUserQuestionResponse | null;
  onSubmit: (response: AskUserQuestionResponse) => void;
}

/**
 * An async AskUserQuestion the agent posted mid-conversation (letta-code
 * 0.34.1+). The tool did not block — this receipt is its finished return —
 * so answering goes back as an ordinary user message through the normal send
 * path, not an approval response, and can happen whenever the user gets to it.
 *
 * Same form language the blocking approval used to borrow from the CLI: one
 * page of question blocks, each a picker with an always-available "Other".
 * Skip answers nothing: `status: "dismissed"` with no answers, which is what
 * upstream's `parseResponse` requires for a dismissal.
 */
export function QuestionCard({ receipt, response, onSubmit }: Props) {
  const [selections, setSelections] = useState<Set<string>[]>([]);
  const [customText, setCustomText] = useState<string[]>([]);
  const questions = receipt.questions;

  if (response) {
    return (
      <div className="entry question answered">
        <div className="question-head">
          <Icon name="check" />
          <span className="tag">{response.status === "dismissed" ? "Dismissed" : "Answered"}</span>
          <span className="question-title">
            {questions.length > 1 ? "The agent asked some questions" : "The agent asked a question"}
          </span>
        </div>
        {response.status === "answered" && response.answers ? (
          <ul className="question-answers">
            {questions.map((q, index) => (
              // Receipt order is fixed by the wire payload.
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed by the receipt
              <li key={index}>
                <span className="tag">{q.header}</span>
                <span className="question-answer-text">
                  {response.answers?.[q.question] ?? "(no answer)"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

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

  const ready = questionReady(questions, selections, customText);

  const submit = () => {
    onSubmit({
      type: "ask_user_question_response",
      version: 2,
      toolCallId: receipt.toolCallId,
      questions,
      status: "answered",
      answers: buildAnswers(questions, selections, customText),
    });
  };

  const dismiss = () => {
    onSubmit({
      type: "ask_user_question_response",
      version: 2,
      toolCallId: receipt.toolCallId,
      questions,
      status: "dismissed",
    });
  };

  return (
    <div className="entry question">
      <div className="question-head">
        <span className="tag ask">Question</span>
        <span className="question-title">
          {questions.length > 1 ? "The agent has some questions" : "The agent has a question"}
        </span>
      </div>
      {questions.map((q, qIndex) => (
        // Order is stable — the receipt is never reordered.
        // biome-ignore lint/suspicious/noArrayIndexKey: stable within one receipt
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
                    onClick={() => toggle(qIndex, option.label)}
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
                onClick={() => toggle(qIndex, OTHER)}
              >
                <strong>Other</strong>
              </button>
              {selections[qIndex]?.has(OTHER) ? (
                <div className="field">
                  <input
                    placeholder="Type your answer…"
                    value={customText[qIndex] ?? ""}
                    onChange={(event) => setCustom(qIndex, event.target.value)}
                  />
                </div>
              ) : null}
            </li>
          </ul>
        </div>
      ))}
      <div className="question-actions">
        <button type="button" className="button ghost" onClick={dismiss}>
          Skip
        </button>
        <button type="button" className="button" disabled={!ready} onClick={submit}>
          Submit
        </button>
      </div>
    </div>
  );
}
