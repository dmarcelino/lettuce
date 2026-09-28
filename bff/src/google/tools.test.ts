import { describe, expect, test } from "bun:test";
import type { McpServer } from "../mcp/settings.ts";
import {
  McpCatalog,
  publicSchema,
  qualifiedName,
  searchCatalog,
  toCatalogTools,
} from "../mcp-bridge/catalog.ts";
import type { ListedTool, McpClientPort } from "../mcp-bridge/client.ts";
import { bridgeHandlers, resolveTool } from "../mcp-bridge/tools.ts";
import fullFixture from "./fixtures/workspace-mcp-1.29.0.full.json";
import readonlyFixture from "./fixtures/workspace-mcp-1.29.0.readonly.json";
import { availableGoogleTools, CURATED_GOOGLE_TOOLS, googleHandlers } from "./tools.ts";

const GOOGLE_URL = "http://google-mcp:8000/mcp";
const google: McpServer = { name: "google", transport: "http", url: GOOGLE_URL };
const full = fullFixture as ListedTool[];
const readonly = readonlyFixture as ListedTool[];

function fakeClient(listing: ListedTool[]) {
  const calls: [string, string, Record<string, unknown>][] = [];
  const client: McpClientPort = {
    async listTools() {
      return listing;
    },
    async callTool(server, tool, args) {
      calls.push([server.name, tool, args]);
      return { text: `ran ${tool}`, isError: false };
    },
  };
  return { client, calls };
}

async function catalogOf(listing: ListedTool[], servers: McpServer[] = [google]) {
  const { client, calls } = fakeClient(listing);
  const catalog = new McpCatalog({ servers: async () => servers, client });
  await catalog.refresh();
  return { catalog, client, calls };
}

// ── The fixture is the contract with workspace-mcp ──────────────────────────
// Recorded from the pinned image (WORKSPACE_MCP_VERSION) — refresh it on every
// bump; these tests are what then say whether the curated mappings still fit.
describe("curated Google tools against workspace-mcp 1.29.0", () => {
  const byName = new Map(full.map((t) => [t.name, t]));

  test("every tool a curated tool needs exists", () => {
    for (const curated of CURATED_GOOGLE_TOOLS) {
      for (const need of curated.needs)
        expect(byName.has(need), `${curated.spec.name} → ${need}`).toBe(true);
    }
  });

  test("every argument a curated tool sets is one the underlying tool accepts", () => {
    const samples: Record<string, Record<string, unknown>[]> = {
      gmail_search: [{ query: "is:unread", max_results: 5 }],
      gmail_read: [{ message_id: "m1" }, { thread_id: "t1" }],
      gmail_send: [
        { to: "a@b.c", subject: "s", body: "b", cc: "c@d.e", bcc: "f@g.h", thread_id: "t1" },
      ],
      gmail_draft: [{ subject: "s", body: "b", to: "a@b.c", thread_id: "t1" }],
      calendar_events: [
        {
          time_min: "2026-09-29T00:00:00Z",
          time_max: "2026-09-30T00:00:00Z",
          query: "x",
          max_results: 3,
        },
      ],
      calendar_freebusy: [{ time_min: "2026-09-29T00:00:00Z", time_max: "2026-09-30T00:00:00Z" }],
      calendar_event: [
        {
          action: "create",
          summary: "s",
          start_time: "a",
          end_time: "b",
          description: "d",
          location: "l",
          attendees: ["x@y.z"],
        },
        { action: "delete", event_id: "e1" },
      ],
      tasks_list: [{}, { lists: true }],
      tasks_update: [
        { action: "create", title: "t", notes: "n", due: "2026-10-01T00:00:00Z" },
        { action: "complete", task_id: "k" },
      ],
    };
    for (const curated of CURATED_GOOGLE_TOOLS) {
      for (const args of samples[curated.spec.name] ?? []) {
        const call = curated.build(args);
        if (typeof call === "string") throw new Error(`${curated.spec.name}: ${call}`);
        const schema = byName.get(call.tool)?.inputSchema as {
          properties: Record<string, unknown>;
          required?: string[];
        };
        for (const key of Object.keys(call.arguments)) {
          expect(
            Object.hasOwn(schema.properties, key),
            `${curated.spec.name} → ${call.tool}.${key}`,
          ).toBe(true);
        }
        for (const required of schema.required ?? []) {
          expect(Object.hasOwn(call.arguments, required), `${call.tool} needs ${required}`).toBe(
            true,
          );
        }
      }
    }
  });

  test("approval follows the server's own read/write marking", () => {
    for (const curated of CURATED_GOOGLE_TOOLS) {
      const readOnly = curated.needs.every(
        (n) => byName.get(n)?.annotations?.readOnlyHint === true,
      );
      expect(curated.spec.approval, curated.spec.name).toBe(readOnly ? "auto" : "ask");
    }
  });
});

describe("availableGoogleTools", () => {
  test("full access offers every curated tool", async () => {
    const { catalog } = await catalogOf(full);
    const { specs, server } = availableGoogleTools(catalog.snapshot().tools, GOOGLE_URL);
    expect(specs.map((s) => s.name)).toEqual(CURATED_GOOGLE_TOOLS.map((c) => c.spec.name));
    expect(server?.name).toBe("google");
  });

  test("read-only levels never show a write tool", async () => {
    const { catalog } = await catalogOf(readonly);
    const names = availableGoogleTools(catalog.snapshot().tools, GOOGLE_URL).specs.map(
      (s) => s.name,
    );
    expect(names).toEqual([
      "gmail_search",
      "gmail_read",
      "calendar_events",
      "calendar_freebusy",
      "tasks_list",
    ]);
  });

  test("no Google server, no Google tools", async () => {
    const { catalog } = await catalogOf(full, [
      { name: "other", transport: "http", url: "http://other:1/mcp" },
    ]);
    expect(availableGoogleTools(catalog.snapshot().tools, GOOGLE_URL)).toEqual({
      specs: [],
      server: null,
    });
  });
});

describe("googleHandlers", () => {
  test("a curated call becomes the underlying tool call", async () => {
    const { catalog, client, calls } = await catalogOf(full);
    const handlers = googleHandlers({
      catalog: () => catalog.current(),
      googleUrl: GOOGLE_URL,
      client,
    });
    const answer = await handlers.get("tasks_update")?.({ action: "complete", task_id: "k1" });
    expect(answer).toEqual({ text: "ran manage_task", isError: false });
    expect(calls).toEqual([
      [
        "google",
        "manage_task",
        { action: "update", task_list_id: "@default", task_id: "k1", status: "completed" },
      ],
    ]);
  });

  test("a tool the grant no longer allows answers with why", async () => {
    const { catalog, client } = await catalogOf(readonly);
    const handlers = googleHandlers({
      catalog: () => catalog.current(),
      googleUrl: GOOGLE_URL,
      client,
    });
    const answer = await handlers.get("gmail_send")?.({ to: "a@b.c", subject: "s", body: "b" });
    expect(answer?.isError).toBe(true);
    expect(answer?.text).toContain("Settings → Google");
  });

  test("bad arguments are explained before anything is called", async () => {
    const { catalog, client, calls } = await catalogOf(full);
    const handlers = googleHandlers({
      catalog: () => catalog.current(),
      googleUrl: GOOGLE_URL,
      client,
    });
    expect((await handlers.get("calendar_event")?.({ action: "update" }))?.text).toContain(
      "event_id",
    );
    expect((await handlers.get("gmail_read")?.({}))?.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("the MCP bridge", () => {
  test("names follow upstream's mcp__<server>__<tool>, and the account parameter is hidden", async () => {
    const { catalog } = await catalogOf(full);
    const search = catalog.snapshot().tools.find((t) => t.tool === "search_gmail_messages");
    expect(search?.qualified).toBe("mcp__google__search_gmail_messages");
    expect(search?.readOnly).toBe(true);
    expect(Object.keys((search?.inputSchema.properties as object) ?? {})).not.toContain(
      "user_google_email",
    );
    expect(qualifiedName("my server", "x")).toBe("mcp__my_server__x");
    expect(
      publicSchema({
        type: "object",
        properties: { user_google_email: {}, a: {} },
        required: ["user_google_email", "a"],
      }),
    ).toEqual({
      type: "object",
      properties: { a: {} },
      required: ["a"],
    });
  });

  test("search ranks by what the tool does", async () => {
    const { catalog } = await catalogOf(full);
    const hits = searchCatalog(catalog.snapshot().tools, "gmail labels");
    expect(hits[0]?.tool).toMatch(/label/);
    expect(searchCatalog(catalog.snapshot().tools, "free busy calendar")[0]?.tool).toBe(
      "query_freebusy",
    );
  });

  test("mcp_call runs only read-only tools; writes go through mcp_call_write", async () => {
    const { catalog, client, calls } = await catalogOf(full);
    const handlers = bridgeHandlers(catalog, client);
    const refused = await handlers.get("mcp_call")?.({
      tool: "mcp__google__send_gmail_message",
      arguments: {},
    });
    expect(refused?.isError).toBe(true);
    expect(refused?.text).toContain("mcp_call_write");
    expect(calls).toEqual([]);
    expect(
      await handlers.get("mcp_call")?.({ tool: "list_gmail_labels", arguments: "{}" }),
    ).toEqual({
      text: "ran list_gmail_labels",
      isError: false,
    });
    expect(
      await handlers.get("mcp_call_write")?.({
        tool: "mcp__google__send_gmail_message",
        arguments: { to: "a@b.c" },
      }),
    ).toEqual({
      text: "ran send_gmail_message",
      isError: false,
    });
    expect(calls.map((c) => c[1])).toEqual(["list_gmail_labels", "send_gmail_message"]);
  });

  test("an unannotated tool counts as a write", async () => {
    const { catalog } = await catalogOf(full);
    expect(
      catalog.snapshot().tools.find((t) => t.tool === "get_gmail_attachment_content")?.readOnly,
    ).toBe(false);
  });

  test("describe and search speak in the names the model will call", async () => {
    const { catalog, client } = await catalogOf(full);
    const handlers = bridgeHandlers(catalog, client);
    const search = await handlers.get("mcp_search")?.({ query: "send email" });
    expect(search?.text).toContain("mcp__google__send_gmail_message");
    expect(search?.text).toContain("[writes]");
    const describe = await handlers.get("mcp_describe")?.({ tool: "mcp__google__get_events" });
    expect(describe?.text).toContain("read-only: run with mcp_call");
    expect(describe?.text).not.toContain("user_google_email");
    expect(resolveTool(catalog.snapshot().tools, "nope")).toContain("mcp_search");
  });

  test("no servers: the bridge says so instead of guessing", async () => {
    const { catalog, client } = await catalogOf(full, []);
    const answer = await bridgeHandlers(catalog, client).get("mcp_search")?.({ query: "x" });
    expect(answer).toEqual({ text: "No MCP servers are available right now.", isError: true });
  });

  test("stdio servers are not bridged", async () => {
    const { catalog } = await catalogOf(full, [
      { name: "local", transport: "stdio", command: "x" },
    ]);
    expect(catalog.snapshot().tools).toEqual([]);
  });

  test("a server that fails to list is reported and skipped", async () => {
    const client: McpClientPort = {
      async listTools() {
        throw new Error("connect ECONNREFUSED");
      },
      async callTool() {
        return { text: "", isError: false };
      },
    };
    const catalog = new McpCatalog({ servers: async () => [google], client });
    await catalog.refresh();
    expect(catalog.snapshot().tools).toEqual([]);
    expect(catalog.snapshot().failures.get("google")).toContain("ECONNREFUSED");
    expect(toCatalogTools(google, [])).toEqual([]);
  });
});
