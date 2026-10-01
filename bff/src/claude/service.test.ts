import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type ClaudeFileIo,
  getClaudeRun,
  listClaudeRuns,
  reapplyClaudeSettings,
  saveClaudeSettings,
} from "./service.ts";
import { CLAUDE_PROJECTS_DIR, CLAUDE_SETTINGS_PATH } from "./settings.ts";

function memoryIo(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const directChildren = (dir: string) =>
    [...files.keys()]
      .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/"))
      .map((path) => path.slice(dir.length + 1));
  const io: ClaudeFileIo = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => {
      writes.push(path);
      files.set(path, content);
    },
    listFiles: async (dir) => {
      const names = directChildren(dir);
      return names.length ? names : null;
    },
    listDirs: async (dir) => {
      const names = [
        ...new Set(
          [...files.keys()]
            .filter((path) => path.startsWith(`${dir}/`))
            .map((path) => path.slice(dir.length + 1).split("/")[0] ?? ""),
        ),
      ].filter((name) => name && [...files.keys()].some((p) => p.startsWith(`${dir}/${name}/`)));
      return names.length ? names : null;
    },
  };
  return { io, files, writes };
}

const READY = { baseUrl: "http://proxy:4000", model: "m", enabled: true };
const S1 = "3218941e-1e45-471c-af5f-37f91e709f7a";
const S2 = "11111111-2222-4333-8444-555555555555";
const FIXTURE = readFileSync(new URL("fixtures/claude-run.jsonl", import.meta.url), "utf8");

function transcript(prompt: string, at: string): string {
  return FIXTURE.replace("Fix the failing test in math.test.js.", prompt).replace(
    /2026-09-30T17:21:2/g,
    at,
  );
}

describe("saving settings", () => {
  test("the switch file is the only file, and holds the settings", async () => {
    const { io, files, writes } = memoryIo();
    await saveClaudeSettings(io, { ...READY, authToken: "sk-secret" });
    expect(writes).toEqual([CLAUDE_SETTINGS_PATH]);
    expect(JSON.parse(files.get(CLAUDE_SETTINGS_PATH) ?? "{}")).toMatchObject({
      enabled: true,
      authToken: "sk-secret",
    });
  });

  test("an invalid update writes nothing", async () => {
    const { io, writes } = memoryIo();
    await expect(saveClaudeSettings(io, { enabled: true })).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  test("reapply does nothing until settings were saved once", async () => {
    const { io, writes } = memoryIo();
    expect(await reapplyClaudeSettings(io)).toBe(false);
    expect(writes).toEqual([]);
    await saveClaudeSettings(io, READY);
    expect(await reapplyClaudeSettings(io)).toBe(true);
  });

  test("with the profile token dropped, reapply forces the switch off but keeps the endpoint", async () => {
    const { io, files } = memoryIo();
    await saveClaudeSettings(io, { ...READY, authToken: "sk-secret" });
    expect(await reapplyClaudeSettings(io, { profileEnabled: false })).toBe(true);
    const stored = JSON.parse(files.get(CLAUDE_SETTINGS_PATH) ?? "{}") as Record<string, unknown>;
    expect(stored.enabled).toBe(false);
    // The rest survives: re-adding the token needs one flip of the switch.
    expect(stored.baseUrl).toBe("http://proxy:4000");
    expect(stored.model).toBe("m");
  });
});

describe("runs", () => {
  test("a run is found by session id across project dirs", async () => {
    const { io } = memoryIo({
      [`${CLAUDE_PROJECTS_DIR}/-work-agent-1/${S1}.jsonl`]: transcript(
        "first",
        "2026-09-30T17:21:2",
      ),
    });
    expect((await getClaudeRun(io, S1))?.prompt).toBe("first");
    expect(await getClaudeRun(io, S2)).toBeNull();
  });

  test("recent runs are newest first and capped", async () => {
    const { io } = memoryIo({
      [`${CLAUDE_PROJECTS_DIR}/-work/${S1}.jsonl`]: transcript("older", "2026-09-30T10:00:0"),
      [`${CLAUDE_PROJECTS_DIR}/-work-agent-2/${S2}.jsonl`]: transcript(
        "newer",
        "2026-09-30T12:00:0",
      ),
      [`${CLAUDE_PROJECTS_DIR}/-work/notes.txt`]: "ignored",
    });
    const now = Date.parse("2026-09-30T13:00:00Z");
    expect((await listClaudeRuns(io, 10, now)).map((r) => r.prompt)).toEqual(["newer", "older"]);
    expect(await listClaudeRuns(io, 1, now)).toHaveLength(1);
  });
});
