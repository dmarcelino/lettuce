import { describe, expect, test } from "bun:test";
import {
  clearsToNewConversation,
  matchSlashCommands,
  parseSlashCommand,
  readCommands,
  type SlashCommand,
} from "./workspace.ts";

const COMMANDS: SlashCommand[] = [
  { id: "compact", description: "Compact the conversation to free context" },
  { id: "remember", description: "Save something to long-term memory" },
  { id: "resume", description: "A mod command", args: "<role>" },
];

describe("readCommands", () => {
  test("drops the ids the app-server advertises but cannot dispatch", () => {
    const commands = readCommands(
      ["compact", "secret", "toolset", "channels", "upgrade-letta-code"],
      [],
    );
    expect(commands.map((command) => command.id)).toEqual(["compact"]);
  });

  test("mod commands keep their description and args hint", () => {
    const commands = readCommands(
      [],
      [{ id: "resume", description: "Build a CV", args: "<role>" }],
    );
    expect(commands).toEqual([{ id: "resume", description: "Build a CV", args: "<role>" }]);
  });
});

describe("parseSlashCommand", () => {
  test("a bare advertised command is recognised", () => {
    expect(parseSlashCommand("/compact", COMMANDS)).toEqual({ id: "compact" });
  });

  test("everything after the name becomes args", () => {
    expect(parseSlashCommand("/remember  dima prefers bun ", COMMANDS)).toEqual({
      id: "remember",
      args: "dima prefers bun",
    });
  });

  test("an unadvertised id is a message, not a command", () => {
    // The app-server would answer "Unknown command" rather than treat it as
    // text, so refusing to match here is what keeps the text a message.
    expect(parseSlashCommand("/nonesuch", COMMANDS)).toBeNull();
  });

  test("an absolute path is a message", () => {
    expect(parseSlashCommand("/work/agent-x/notes.md", COMMANDS)).toBeNull();
    expect(parseSlashCommand("/clear/subdir", COMMANDS)).toBeNull();
  });

  test("a prefix of a command is not a command", () => {
    expect(parseSlashCommand("/cl", COMMANDS)).toBeNull();
  });

  test("ordinary text is untouched", () => {
    expect(parseSlashCommand("what is 2/3 of 9?", COMMANDS)).toBeNull();
    expect(parseSlashCommand("", COMMANDS)).toBeNull();
  });
});

describe("matchSlashCommands", () => {
  test("a lone slash offers everything", () => {
    expect(matchSlashCommands("/", COMMANDS)).toHaveLength(COMMANDS.length);
  });

  test("filters on the id prefix, case-insensitively", () => {
    expect(matchSlashCommands("/R", COMMANDS).map((c) => c.id)).toEqual(["remember", "resume"]);
    expect(matchSlashCommands("/comp", COMMANDS).map((c) => c.id)).toEqual(["compact"]);
  });

  test("collapses once arguments are being typed", () => {
    expect(matchSlashCommands("/remember ", COMMANDS)).toEqual([]);
    expect(matchSlashCommands("/remember dima uses bun", COMMANDS)).toEqual([]);
  });

  test("text that is not a slash command offers nothing", () => {
    expect(matchSlashCommands("hello", COMMANDS)).toEqual([]);
  });
});

// The app-server removed the remote `clear` in 0.34.15, so these words are not commands here — the
// composer answers them with a new conversation instead of sending the word to the agent.
describe("clearsToNewConversation", () => {
  test("only the bare habit words", () => {
    expect(clearsToNewConversation("/clear")).toBe(true);
    expect(clearsToNewConversation("/clear-messages")).toBe(true);
  });

  test("anything else stays a message", () => {
    // A request about clearing, not the habit.
    expect(clearsToNewConversation("/clear the cache please")).toBe(false);
    // A pasted path, and the plain word.
    expect(clearsToNewConversation("/clear/subdir")).toBe(false);
    expect(clearsToNewConversation("clear")).toBe(false);
    expect(clearsToNewConversation("")).toBe(false);
  });
});
