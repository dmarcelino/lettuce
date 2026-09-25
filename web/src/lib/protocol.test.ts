import { describe, expect, test } from "bun:test";
import { readAppServerInfo } from "./protocol.ts";

/** A wire payload this server actually sends, minus the optional capabilities. */
function payload(capabilities: Record<string, unknown> = {}) {
  return {
    type: "app_server_info_response",
    request_id: "req-1",
    success: true,
    backend: "local",
    letta_code_version: "0.32.19",
    protocol_version: 1,
    capabilities: {
      agent_management: true,
      conversation_management: true,
      memory_management: true,
      runtime_start: true,
      split_channels: true,
      ...capabilities,
    },
  };
}

/**
 * The capability handshake is what feature-gates the UI. Before this test the
 * parser silently dropped `launch_subagent` and `structured_outputs`, so a
 * server advertising them looked like one that did not.
 */
describe("readAppServerInfo capabilities", () => {
  test("parses launch_subagent and structured_outputs when advertised", () => {
    const info = readAppServerInfo(payload({ launch_subagent: true, structured_outputs: true }));
    expect(info?.capabilities.launch_subagent).toBe(true);
    expect(info?.capabilities.structured_outputs).toBe(true);
  });

  test("an absent optional capability reads false, not undefined", () => {
    const info = readAppServerInfo(payload());
    expect(info).not.toBeNull();
    expect(info?.capabilities.launch_subagent).toBe(false);
    expect(info?.capabilities.structured_outputs).toBe(false);
  });

  test("an explicit false stays false", () => {
    const info = readAppServerInfo(payload({ launch_subagent: false, structured_outputs: false }));
    expect(info?.capabilities.launch_subagent).toBe(false);
    expect(info?.capabilities.structured_outputs).toBe(false);
  });

  test("a non-boolean capability is not mistaken for true", () => {
    const info = readAppServerInfo(payload({ launch_subagent: "yes", structured_outputs: 1 }));
    expect(info?.capabilities.launch_subagent).toBe(false);
    expect(info?.capabilities.structured_outputs).toBe(false);
  });

  test("the long-standing capabilities still parse", () => {
    const info = readAppServerInfo(payload());
    expect(info?.capabilities.agent_management).toBe(true);
    expect(info?.capabilities.conversation_management).toBe(true);
    expect(info?.capabilities.memory_management).toBe(true);
    expect(info?.capabilities.runtime_start).toBe(true);
    expect(info?.capabilities.split_channels).toBe(true);
  });

  test("a malformed payload is rejected outright", () => {
    expect(readAppServerInfo(null)).toBeNull();
    expect(readAppServerInfo({})).toBeNull();
    expect(readAppServerInfo({ ...payload(), backend: "cloud" })).toBeNull();
    expect(readAppServerInfo({ ...payload(), capabilities: "yes" })).toBeNull();
  });
});
