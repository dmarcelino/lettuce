import { describe, expect, test } from "bun:test";
import {
  InvalidMcpServersError,
  mergeMcpServers,
  readMcpServers,
  SettingsUnreadableError,
  validateMcpServers,
} from "./settings.ts";

/**
 * The merge is the only thing protecting ~18 unrelated top-level settings and
 * the other agents' entries when the MCP editor saves. A replace-instead-of-
 * merge here silently destroys `deviceId` and every other agent's config, so
 * these assert preservation rather than just shape.
 */
const AGENT = "agent-1";
const OTHER = "agent-2";

function settingsFixture() {
  return JSON.stringify(
    {
      lastAgent: AGENT,
      tokenStreaming: true,
      deviceId: "device-abc",
      reflectionTrigger: "manual",
      agents: [
        { agentId: AGENT, model: "gpt-4" },
        {
          agentId: OTHER,
          mcpServers: [{ name: "other-server", transport: "stdio", command: "x" }],
        },
      ],
    },
    null,
    2,
  );
}

describe("mergeMcpServers", () => {
  test("adds servers to the named agent and preserves every other setting", () => {
    const before = JSON.parse(settingsFixture());
    const after = JSON.parse(
      mergeMcpServers(settingsFixture(), AGENT, [
        { name: "searxng", transport: "stdio", command: "uvx", args: ["mcp-searxng"] },
      ]),
    ) as Record<string, any>;

    expect(after.agents[0].mcpServers[0].name).toBe("searxng");
    // The agent's own unrelated keys survive alongside the new servers.
    expect(after.agents[0].model).toBe("gpt-4");
    expect(after.deviceId).toBe(before.deviceId);
    expect(after.tokenStreaming).toBe(before.tokenStreaming);
    expect(after.reflectionTrigger).toBe(before.reflectionTrigger);
    expect(after.lastAgent).toBe(before.lastAgent);
    // The other agent is untouched.
    expect(after.agents[1]).toEqual(before.agents[1]);
    expect(after.agents).toHaveLength(2);
  });

  test("replacing an agent's servers leaves the other agent alone", () => {
    const after = JSON.parse(
      mergeMcpServers(
        JSON.stringify({
          deviceId: "keep-me",
          agents: [
            {
              agentId: AGENT,
              mcpServers: [{ name: "old", transport: "stdio", command: "old" }],
            },
            { agentId: OTHER, mcpServers: [{ name: "other", transport: "stdio", command: "x" }] },
          ],
        }),
        AGENT,
        [{ name: "new", transport: "stdio", command: "new" }],
      ),
    ) as Record<string, any>;

    expect(after.agents[0].mcpServers).toHaveLength(1);
    expect(after.agents[0].mcpServers[0].name).toBe("new");
    expect(after.agents[1].mcpServers[0].name).toBe("other");
    expect(after.deviceId).toBe("keep-me");
  });

  test("an empty list removes the key rather than writing an empty array", () => {
    const after = JSON.parse(
      mergeMcpServers(
        JSON.stringify({ agents: [{ agentId: AGENT, mcpServers: [{ name: "a" }] }] }),
        AGENT,
        [],
      ),
    ) as Record<string, any>;
    expect("mcpServers" in after.agents[0]).toBe(false);
    expect(after.agents[0].agentId).toBe(AGENT);
  });

  test("an empty list for an unknown agent does not create an entry", () => {
    const original = settingsFixture();
    expect(mergeMcpServers(original, "nope", [])).toBe(original);
  });

  test("an unknown agent gets a new entry appended", () => {
    const after = JSON.parse(
      mergeMcpServers(settingsFixture(), "agent-3", [
        { name: "fresh", transport: "stdio", command: "f" },
      ]),
    ) as Record<string, any>;
    expect(after.agents).toHaveLength(3);
    expect(after.agents[2].agentId).toBe("agent-3");
    expect(after.agents[2].mcpServers[0].name).toBe("fresh");
  });

  test("unparseable settings refuse the merge rather than clobbering the file", () => {
    expect(() => mergeMcpServers("{not json", AGENT, [])).toThrow(SettingsUnreadableError);
    expect(() => mergeMcpServers("[]", AGENT, [])).toThrow(SettingsUnreadableError);
    expect(() => mergeMcpServers('"a string"', AGENT, [])).toThrow(SettingsUnreadableError);
  });
});

describe("readMcpServers", () => {
  test("returns the named agent's servers", () => {
    const raw = JSON.stringify({
      agents: [{ agentId: AGENT, mcpServers: [{ name: "one" }, { name: "two" }] }],
    });
    expect(readMcpServers(raw, AGENT).map((s) => s.name)).toEqual(["one", "two"]);
  });

  test("an agent with no servers, no entry, or no agents array reads as empty", () => {
    expect(readMcpServers(JSON.stringify({ agents: [{ agentId: AGENT }] }), AGENT)).toEqual([]);
    expect(readMcpServers(JSON.stringify({ agents: [] }), AGENT)).toEqual([]);
    expect(readMcpServers(JSON.stringify({}), AGENT)).toEqual([]);
  });

  test("displays a malformed stored entry rather than refusing to show it", () => {
    // Validation is a write-time concern. Refusing to DISPLAY something the CLI
    // or an older editor wrote would hide the user's own configuration.
    const raw = JSON.stringify({
      agents: [{ agentId: AGENT, mcpServers: [{ name: "odd" }, null] }],
    });
    expect(readMcpServers(raw, AGENT)).toEqual([{ name: "odd" }]);
  });
});

describe("validateMcpServers", () => {
  const ok = (servers: unknown[]) => expect(validateMcpServers(servers)).toBeInstanceOf(Array);

  test("accepts the shapes the editor produces", () => {
    ok([{ name: "a", transport: "stdio", command: "uvx", args: ["x"] }]);
    ok([{ name: "b", transport: "http", url: "https://e.com/mcp" }]);
    ok([{ name: "c", transport: "sse", url: "https://e.com/sse", headers: { A: "1" } }]);
    ok([{ name: "d", command: "bare" }]);
  });

  test("refuses a nameless server", () => {
    expect(() => validateMcpServers([{ command: "x" }])).toThrow(InvalidMcpServersError);
    expect(() => validateMcpServers([{ name: "   ", command: "x" }])).toThrow(
      InvalidMcpServersError,
    );
  });

  test("refuses an unknown transport", () => {
    expect(() => validateMcpServers([{ name: "a", transport: "carrier-pigeon" }])).toThrow(
      InvalidMcpServersError,
    );
  });

  test("refuses a stdio server with no command and a remote server with no url", () => {
    expect(() => validateMcpServers([{ name: "a", transport: "stdio" }])).toThrow(
      InvalidMcpServersError,
    );
    expect(() => validateMcpServers([{ name: "a", transport: "http" }])).toThrow(
      InvalidMcpServersError,
    );
  });

  test("refuses non-string args, env and headers", () => {
    expect(() => validateMcpServers([{ name: "a", command: "x", args: [1] }])).toThrow(
      InvalidMcpServersError,
    );
    expect(() => validateMcpServers([{ name: "a", command: "x", env: { K: 1 } }])).toThrow(
      InvalidMcpServersError,
    );
    expect(() =>
      validateMcpServers([{ name: "a", transport: "http", url: "u", headers: { K: {} } }]),
    ).toThrow(InvalidMcpServersError);
  });

  test("refuses duplicate names", () => {
    expect(() =>
      validateMcpServers([
        { name: "a", command: "x" },
        { name: "a", command: "y" },
      ]),
    ).toThrow(/Duplicate/);
  });

  test("refuses a non-array payload", () => {
    expect(() => validateMcpServers({ name: "a" })).toThrow(InvalidMcpServersError);
    expect(() => validateMcpServers(null)).toThrow(InvalidMcpServersError);
  });

  test("trims the name and defaults the transport", () => {
    const [server = { name: "" }] = validateMcpServers([{ name: "  padded  ", command: " x " }]);
    expect(server.name).toBe("padded");
    expect(server.transport).toBe("stdio");
  });
});
