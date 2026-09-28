import { describe, expect, test } from "bun:test";
import {
  GLOBAL_MCP_AGENT,
  InvalidMcpServersError,
  LOCAL_BASE_URL,
  readMcpServers,
  renderMcpSettings,
  SettingsUnreadableError,
  validateMcpServers,
} from "./settings.ts";

const DDG = { name: "duckduckgo", transport: "http" as const, url: "http://ddg-mcp:8000/mcp" };

describe("renderMcpSettings", () => {
  test("stores the list under the global agent, with the local backend's baseUrl", () => {
    // `letta mcp` matches agentId AND baseUrl; without the key the entry is invisible.
    const parsed = JSON.parse(renderMcpSettings([DDG]));
    expect(parsed.agents).toEqual([
      { agentId: GLOBAL_MCP_AGENT, baseUrl: LOCAL_BASE_URL, mcpServers: [DDG] },
    ]);
    expect(GLOBAL_MCP_AGENT.startsWith("agent-local-")).toBe(true);
  });

  test("marks the one-time migration done, so the CLI never rewrites the file", () => {
    const parsed = JSON.parse(renderMcpSettings([]));
    expect(parsed.autoConversationTitlesRollbackApplied).toBe(true);
  });

  test("round-trips through readMcpServers", () => {
    expect(readMcpServers(renderMcpSettings([DDG]))).toEqual([DDG]);
  });
});

describe("readMcpServers", () => {
  test("no agents, no global entry, or no servers read as empty", () => {
    expect(readMcpServers("{}")).toEqual([]);
    expect(readMcpServers(JSON.stringify({ agents: [{ agentId: "agent-local-x" }] }))).toEqual([]);
    expect(readMcpServers(JSON.stringify({ agents: [{ agentId: GLOBAL_MCP_AGENT }] }))).toEqual([]);
  });

  test("ignores other agents' entries", () => {
    const raw = JSON.stringify({
      agents: [
        { agentId: "agent-local-x", mcpServers: [{ name: "not-ours", command: "x" }] },
        { agentId: GLOBAL_MCP_AGENT, mcpServers: [DDG] },
      ],
    });
    expect(readMcpServers(raw)).toEqual([DDG]);
  });

  test("displays a malformed stored entry rather than hiding it", () => {
    const raw = JSON.stringify({
      agents: [{ agentId: GLOBAL_MCP_AGENT, mcpServers: [{ name: "odd" }, null, "junk"] }],
    });
    expect(readMcpServers(raw)).toEqual([{ name: "odd" }]);
  });

  test("an unparseable file is an error, not an empty list that a save would overwrite", () => {
    expect(() => readMcpServers("{not json")).toThrow(SettingsUnreadableError);
    expect(() => readMcpServers("[]")).toThrow(SettingsUnreadableError);
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
