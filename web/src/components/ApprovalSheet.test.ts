import { describe, expect, test } from "bun:test";
import { parseQuestions } from "./ApprovalSheet.tsx";

/**
 * `AskUserQuestion`'s wire input (fork: tools/impl/ask-user-question.ts)
 * arrives as `Record<string, unknown>` off the approval frame, so these
 * assert the defensive parsing degrades to `[]` — sending the caller back to
 * the generic JSON-dump approval UI — rather than throwing or rendering a
 * half-built form.
 */
describe("parseQuestions", () => {
  test("parses a well-formed single question", () => {
    const questions = parseQuestions({
      questions: [
        {
          question: "Which approach?",
          header: "Approach",
          options: [
            { label: "A", description: "Do it the A way" },
            { label: "B", description: "Do it the B way" },
          ],
        },
      ],
    });
    expect(questions).toEqual([
      {
        question: "Which approach?",
        header: "Approach",
        options: [
          { label: "A", description: "Do it the A way" },
          { label: "B", description: "Do it the B way" },
        ],
        multiSelect: false,
      },
    ]);
  });

  test("carries multiSelect through when true", () => {
    const [question] = parseQuestions({
      questions: [
        {
          question: "Pick any",
          header: "Pick",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
          multiSelect: true,
        },
      ],
    });
    expect(question?.multiSelect).toBe(true);
  });

  test("defaults a missing option description to an empty string", () => {
    const [question] = parseQuestions({
      questions: [
        {
          question: "Q",
          header: "H",
          options: [{ label: "A" }, { label: "B", description: "b" }],
        },
      ],
    });
    expect(question?.options[0]?.description).toBe("");
  });

  test("drops a question with fewer than two options", () => {
    expect(
      parseQuestions({
        questions: [{ question: "Q", header: "H", options: [{ label: "A", description: "a" }] }],
      }),
    ).toEqual([]);
  });

  test("drops a question missing its question or header text", () => {
    expect(
      parseQuestions({
        questions: [{ header: "H", options: [{ label: "A", description: "a" }, { label: "B" }] }],
      }),
    ).toEqual([]);
  });

  test("returns [] when questions is not an array", () => {
    expect(parseQuestions({ questions: "not an array" })).toEqual([]);
    expect(parseQuestions({})).toEqual([]);
  });

  test("returns [] for a non-object question or option", () => {
    expect(parseQuestions({ questions: [null, "nope", 42] })).toEqual([]);
  });

  test("keeps the well-formed questions in a mixed batch", () => {
    const questions = parseQuestions({
      questions: [
        { question: "Bad", header: "Bad" }, // no options at all
        {
          question: "Good",
          header: "Good",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
        },
      ],
    });
    expect(questions.map((q) => q.question)).toEqual(["Good"]);
  });
});
