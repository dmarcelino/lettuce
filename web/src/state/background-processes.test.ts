import { describe, expect, test } from "bun:test";
import { readBackgroundProcesses, readSubagentAgents } from "./use-conversation.ts";

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

  // A subagent row is stoppable only while the snapshot list still names its child agent —
  // `subagent_stop` takes that id, not the process id (letta-code 0.34.16).
  const runningTask = {
    process_id: "task_1",
    subagent_id: "sub_1",
    kind: "agent_task",
    description: "summarise the repo",
    status: "running",
  };

  test("a subagent with a live child agent is stoppable", () => {
    const [process] = readBackgroundProcesses([runningTask], { sub_1: "agent_9" });
    expect(process?.subagentId).toBe("sub_1");
    expect(process?.stoppable).toBe(true);
  });

  test("a subagent the app-server no longer owns has no Stop", () => {
    // No snapshot (never had one, or an app-server restart dropped it) …
    expect(readBackgroundProcesses([runningTask])[0]?.stoppable).toBe(false);
    // … or a snapshot whose child carries no agent id.
    expect(readBackgroundProcesses([runningTask], {})[0]?.stoppable).toBe(false);
  });

  test("a finished subagent is not stoppable", () => {
    // Leaving a finished snapshot out of the live map is what takes the Stop away.
    const snapshots = [{ subagent_id: "sub_1", agent_id: "agent_9", status: "completed" }];
    const live = readSubagentAgents(snapshots);
    const [process] = readBackgroundProcesses([{ ...runningTask, status: "completed" }], live);
    expect(live).toEqual({});
    expect(process?.stoppable).toBe(false);
  });

  test("readSubagentAgents keeps live snapshots with an agent id", () => {
    expect(
      readSubagentAgents([
        { subagent_id: "sub_1", agent_id: "agent_9", status: "running" },
        { subagent_id: "sub_2", agent_id: "agent_10", status: "pending" },
        { subagent_id: "sub_3", agent_id: "agent_11", status: "error" },
        { subagent_id: "sub_4", status: "running" }, // a child id is not known yet
        { agent_id: "agent_12", status: "running" },
        null,
      ]),
    ).toEqual({ sub_1: "agent_9", sub_2: "agent_10" });
    expect(readSubagentAgents(undefined)).toEqual({});
  });
});
