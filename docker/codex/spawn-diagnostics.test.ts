import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only the pure helpers: installing the hooks is for node processes in the
// app-server container, not the test runner.
process.env.LETTA_UI_SPAWN_DIAG_OFF = "1";
const { countZombies, describeSpawnFailure } = await import("./spawn-diagnostics.cjs");

describe("describeSpawnFailure", () => {
  test("names the errno, what was spawned and how full the process table is", () => {
    const child = {
      spawnfile: "letta",
      spawnargs: ["letta", "-p", "--agent", "agent-1"],
      __lettaUiSpawnCwd: "/work/agent-1",
    };
    const error = Object.assign(new Error("spawn letta EAGAIN"), { code: "EAGAIN" });
    const line = describeSpawnFailure(error, child, {
      pidsCurrent: 11874,
      pidsMax: 11874,
      zombies: 11790,
    });
    expect(line).toContain("spawn failed: EAGAIN file=letta");
    expect(line).toContain('args="-p --agent agent-1"');
    expect(line).toContain("cwd=/work/agent-1");
    expect(line).toContain("pids=11874/11874 zombies=11790");
  });

  test("an unreadable cgroup or unlimited cap still yields a line", () => {
    const line = describeSpawnFailure(
      { code: "ENOENT" },
      { spawnfile: "x" },
      {
        pidsCurrent: null,
        pidsMax: null,
        zombies: null,
      },
    );
    expect(line).toContain("spawn failed: ENOENT file=x");
    expect(line).toContain("pids=? zombies=?");
  });
});

describe("countZombies", () => {
  test("counts state Z, including commands with spaces and parentheses", () => {
    const root = mkdtempSync(join(tmpdir(), "proc-"));
    const proc = (pid: string, stat: string) => {
      mkdirSync(join(root, pid));
      writeFileSync(join(root, pid, "stat"), stat);
    };
    proc("1", "1 (node) S 0 1 1");
    proc("20", "20 (bash) Z 1 20 20");
    proc("21", "21 (my (odd) cmd) Z 1 21 21");
    proc("22", "22 (sleep) R 1 22 22");
    mkdirSync(join(root, "self"));
    expect(countZombies(root)).toBe(2);
  });
});
