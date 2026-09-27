import { describe, expect, test } from "bun:test";
import { readBackgroundProcesses } from "./use-conversation.ts";

/**
 * Since letta-code 0.33 the snapshot builder emits workflows natively as
 * `kind: "workflow"` (`WorkflowBackgroundProcessSummary`). Before that they
 * arrived as `kind: "bash"`, and an allowlist that forgot the new kind would
 * silently drop every running workflow from the Tasks tab.
 */
describe("background process parsing", () => {
  test("a native workflow keeps its kind and description", () => {
    const [process] = readBackgroundProcesses([
      {
        process_id: "workflow_1",
        kind: "workflow",
        description: "nightly-digest",
        started_at_ms: 1,
        status: "running",
      },
    ]);
    expect(process?.kind).toBe("workflow");
    expect(process?.label).toBe("nightly-digest");
  });

  test("a shell command that starts with 'workflow ' stays a shell job", () => {
    const [process] = readBackgroundProcesses([
      {
        process_id: "bash_7",
        kind: "bash",
        command: "workflow --help",
        status: "running",
        exit_code: null,
      },
    ]);
    expect(process?.kind).toBe("bash");
    expect(process?.label).toBe("workflow --help");
  });

  test("a workflow is never stoppable", () => {
    // stopMonitor upstream refuses anything whose process.kind !== "monitor",
    // so offering Stop for a workflow would always fail.
    const [process] = readBackgroundProcesses([
      { process_id: "workflow_2", kind: "workflow", description: "x", status: "running" },
    ]);
    expect(process?.stoppable).toBe(false);
  });

  test("a monitor is still stoppable while running", () => {
    const [process] = readBackgroundProcesses([
      {
        process_id: "monitor_1",
        kind: "monitor",
        description: "watch build",
        status: "running",
        persistent: true,
      },
    ]);
    expect(process?.kind).toBe("monitor");
    expect(process?.stoppable).toBe(true);
  });

  test("a finished monitor is not stoppable", () => {
    const [process] = readBackgroundProcesses([
      { process_id: "monitor_2", kind: "monitor", description: "done", status: "exited" },
    ]);
    expect(process?.stoppable).toBe(false);
  });

  test("an agent task keeps its description as the label", () => {
    const [process] = readBackgroundProcesses([
      {
        process_id: "task_1",
        kind: "agent_task",
        task_type: "general-purpose",
        description: "summarise the repo",
        status: "running",
      },
    ]);
    expect(process?.kind).toBe("agent_task");
    expect(process?.label).toBe("summarise the repo");
  });

  test("unknown kinds and malformed entries are dropped", () => {
    expect(readBackgroundProcesses([{ process_id: "x_1", kind: "mystery" }])).toEqual([]);
    expect(readBackgroundProcesses([{ kind: "bash", command: "ls" }])).toEqual([]);
    expect(readBackgroundProcesses("nope")).toEqual([]);
    expect(readBackgroundProcesses([])).toEqual([]);
  });
});
