import { describe, expect, test } from "bun:test";
import { readBackgroundProcesses } from "./use-conversation.ts";

/**
 * The app-server's snapshot builder filters only `kind !== "monitor"` and maps
 * everything else to `kind: "bash"`, so a Workflow-tool run arrives labelled
 * as a shell job. We re-detect it from the process id, which upstream mints
 * as `workflow_N` via `getNextWorkflowId()`.
 */
describe("workflow detection in background processes", () => {
  test("a workflow_N id is relabelled as a workflow", () => {
    const [process] = readBackgroundProcesses([
      {
        process_id: "workflow_1",
        kind: "bash",
        command: "workflow nightly-digest",
        status: "running",
        exit_code: null,
      },
    ]);
    expect(process?.kind).toBe("workflow");
    expect(process?.label).toBe("workflow nightly-digest");
  });

  test("a real shell command that starts with 'workflow ' is NOT a workflow", () => {
    // This is why the match is on the id and not the command prefix.
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
  });

  test("a workflow is never stoppable", () => {
    // stopMonitor upstream refuses anything whose process.kind !== "monitor",
    // so offering Stop for a workflow would always fail.
    const [process] = readBackgroundProcesses([
      { process_id: "workflow_2", kind: "bash", command: "workflow x", status: "running" },
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
