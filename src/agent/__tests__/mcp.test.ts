import { describe, expect, it } from "vitest";
import { AgentError, PROTOCOL_VERSIONS, handleMessage, type AgentServerDef } from "../mcp";
import { AGENT_PROMPTS, drawingToolsResource, libraryGuideResources } from "../guide";

const server: AgentServerDef = {
  name: "opentrader",
  version: () => "1.2.3",
  instructions: "Use get_chart first.",
  tools: [
    {
      name: "echo",
      title: "Echo",
      description: "Gives its arguments back",
      inputSchema: { type: "object", properties: {} },
      run: async (args) => ({ got: args }),
    },
    {
      name: "fails",
      title: "Fails",
      description: "Always fails",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        throw new AgentError("Nothing on the chart.");
      },
    },
  ],
  resources: () => [{ uri: "opentrader://x", name: "x", description: "X", mimeType: "text/plain", read: () => "hello" }],
  prompts: AGENT_PROMPTS,
};

const call = async (method: string, params?: unknown, id: number | undefined = 1) =>
  JSON.parse(await handleMessage(server, JSON.stringify({ jsonrpc: "2.0", id, method, params })));

describe("agent MCP handler", () => {
  it("initializes with the asked protocol version when known, else the newest", async () => {
    const r = await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.serverInfo).toMatchObject({ name: "opentrader", version: "1.2.3" });
    expect(r.result.capabilities).toHaveProperty("tools");
    expect(r.result.instructions).toBe("Use get_chart first.");
    const newest = await call("initialize", { protocolVersion: "1999-01-01" });
    expect(newest.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it("does not answer notifications", async () => {
    expect(await handleMessage(server, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBe("");
  });

  it("lists and calls tools; a tool failure is a result the agent reads", async () => {
    const list = await call("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "fails"]);
    expect(list.result.tools[0]).not.toHaveProperty("run");
    const ok = await call("tools/call", { name: "echo", arguments: { a: 1 } });
    expect(JSON.parse(ok.result.content[0].text)).toEqual({ got: { a: 1 } });
    const bad = await call("tools/call", { name: "fails", arguments: {} });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toBe("Nothing on the chart.");
    const unknown = await call("tools/call", { name: "nope" });
    expect(unknown.error.code).toBe(-32602);
  });

  it("reads resources and prompts", async () => {
    const read = await call("resources/read", { uri: "opentrader://x" });
    expect(read.result.contents[0]).toEqual({ uri: "opentrader://x", mimeType: "text/plain", text: "hello" });
    const missing = await call("resources/read", { uri: "opentrader://none" });
    expect(missing.error.code).toBe(-32002);
    const prompt = await call("prompts/get", { name: "new_indicator", arguments: { idea: "RSI of volume" } });
    expect(prompt.result.messages[0].content.text).toContain("RSI of volume");
    const noArg = await call("prompts/get", { name: "new_indicator", arguments: {} });
    expect(noArg.error.code).toBe(-32602);
  });

  it("answers errors for bad input", async () => {
    expect(JSON.parse(await handleMessage(server, "{")).error.code).toBe(-32700);
    expect((await call("no/such")).error.code).toBe(-32601);
  });
});

describe("agent guide resources", () => {
  it("lists every drawing kind with its point count", () => {
    const tools = JSON.parse(drawingToolsResource().read() as string) as { kind: string; points: number }[];
    expect(tools.find((t) => t.kind === "trend-line")?.points).toBe(2);
    expect(tools.length).toBeGreaterThan(50);
  });

  it("gives the libraries' guides with SKILL.md first", () => {
    const guides = libraryGuideResources();
    for (const lib of ["oakscriptjs", "lightweight-charts-indicators", "lightweight-charts-drawing"]) {
      const mine = guides.filter((g) => g.uri.startsWith(`opentrader://guides/${lib}/`));
      // A library without a guide yet (older version installed) gives none.
      if (mine.length) expect(mine[0].uri.endsWith("/SKILL.md")).toBe(true);
      for (const g of mine) expect(String(g.read()).length).toBeGreaterThan(0);
    }
  });
});
