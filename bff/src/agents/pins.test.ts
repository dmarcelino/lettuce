import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPinStore } from "./pins.ts";

const fileIn = () => join(mkdtempSync(join(tmpdir(), "pins-")), "pinned-agents.json");

describe("AgentPinStore", () => {
  test("keeps pin order, and survives a restart", async () => {
    const file = fileIn();
    const store = new AgentPinStore(file, () => {});
    store.set("agent-b", true);
    store.set("agent-a", true);
    expect(store.list()).toEqual(["agent-b", "agent-a"]);
    await store.drain();
    expect(new AgentPinStore(file, () => {}).list()).toEqual(["agent-b", "agent-a"]);
  });

  test("pinning twice moves nothing; unpinning removes", async () => {
    const file = fileIn();
    const store = new AgentPinStore(file, () => {});
    store.set("agent-a", true);
    store.set("agent-b", true);
    expect(store.set("agent-a", true)).toEqual(["agent-b", "agent-a"]);
    expect(store.set("agent-b", false)).toEqual(["agent-a"]);
    await store.drain();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["agent-a"]);
  });

  test("a corrupt file loads as nothing pinned", () => {
    const file = fileIn();
    writeFileSync(file, "{not json");
    expect(new AgentPinStore(file, () => {}).list()).toEqual([]);
  });

  test("refuses what is not an agent id", () => {
    const store = new AgentPinStore(fileIn(), () => {});
    expect(() => store.set("../etc", true)).toThrow();
    expect(() => store.set("", true)).toThrow();
  });

  test("a write that fails is reported, not thrown", async () => {
    const errors: unknown[] = [];
    const store = new AgentPinStore("/nonexistent-dir/pins.json", (error) => errors.push(error));
    expect(store.set("agent-a", true)).toEqual(["agent-a"]);
    await store.drain();
    expect(errors).toHaveLength(1);
  });
});
