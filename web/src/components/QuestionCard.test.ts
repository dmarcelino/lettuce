import { describe, expect, test } from "bun:test";
import type { AskUserQuestion } from "@letta-ai/letta-code/ask-user-question";
import { buildAnswers, OTHER, questionReady } from "./QuestionCard.tsx";

/**
 * The answer-state logic `QuestionCard` keeps out of the component so it can
 * be tested without a DOM. Wire-shape validation is upstream's job — the
 * receipt only exists if `parseAskUserQuestionReceipt` accepted these
 * questions — so the form never re-parses.
 */
const ONE: AskUserQuestion[] = [
  {
    question: "Which approach?",
    header: "Approach",
    options: [
      { label: "A", description: "a" },
      { label: "B", description: "b" },
    ],
  },
];
const TWO: AskUserQuestion[] = [
  ...ONE,
  {
    question: "Pick any",
    header: "Pick",
    options: [
      { label: "X", description: "x" },
      { label: "Y", description: "y" },
    ],
    multiSelect: true,
  },
];

const sel = (...sets: string[][]): Set<string>[] => sets.map((s) => new Set(s));

describe("questionReady", () => {
  test("nothing is ready until every question has a selection", () => {
    expect(questionReady(TWO, [], [])).toBe(false);
    expect(questionReady(TWO, sel(["A"]), [])).toBe(false);
    expect(questionReady(TWO, sel(["A"], ["X"]), [])).toBe(true);
  });

  test("an empty selection set is not an answer", () => {
    expect(questionReady(ONE, sel([]), [])).toBe(false);
  });

  test("Other is not ready until its free text is non-blank", () => {
    expect(questionReady(ONE, sel([OTHER]), [""])).toBe(false);
    expect(questionReady(ONE, sel([OTHER]), ["  "])).toBe(false);
    expect(questionReady(ONE, sel([OTHER]), ["the C way"])).toBe(true);
  });
});

describe("buildAnswers", () => {
  test("one non-empty string per question, keyed by the question text", () => {
    expect(buildAnswers(TWO, sel(["A"], ["X"]), [])).toEqual({
      "Which approach?": "A",
      "Pick any": "X",
    });
  });

  test("multi-select picks join with a comma", () => {
    const answers = buildAnswers(TWO, sel(["A"], ["X", "Y"]), []);
    expect(answers["Pick any"]).toBe("X, Y");
  });

  test("Other is replaced by its typed text", () => {
    expect(buildAnswers(ONE, sel([OTHER]), ["the C way"])).toEqual({
      "Which approach?": "the C way",
    });
  });

  test("single-select keeps only the last pick", () => {
    // The toggle clears the previous choice, so the set holds one label.
    expect(buildAnswers(ONE, sel(["B"]), [])).toEqual({ "Which approach?": "B" });
  });
});

describe("OTHER sentinel", () => {
  test("cannot collide with a real option label", () => {
    expect(ONE[0]!.options.some((o) => o.label === OTHER)).toBe(false);
  });
});
