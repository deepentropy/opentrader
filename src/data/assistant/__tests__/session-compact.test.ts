import { describe, expect, it, vi } from "vitest";

vi.mock("../../kv", () => ({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined, onExternalChange: () => () => undefined }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (d: string) => void = () => {};
  },
}));
const server = vi.hoisted(() => ({ script: [] as string[][], bodies: [] as any[] }));
vi.mock("../../../bindings", () => ({
  commands: {
    assistantConfig: async () => ({ models: [{ id: "m1", label: "Small", description: "", baseUrl: "http://127.0.0.1:8080/v1", model: "ot", hasKey: false, compact: true }], selected: "m1", effort: null }),
    assistantChat: async (_id: string, _req: number, body: string, ch: { onmessage: (d: string) => void }) => {
      server.bodies.push(JSON.parse(body));
      for (const e of server.script.shift() ?? []) ch.onmessage(e);
      return { status: "ok", data: null };
    },
    assistantCancel: async () => undefined,
  },
}));

import { loadModels } from "../models";
import { activeChat, COMPACT_V1, describeTool, send, setAssistantHost } from "../session";
import type { AgentTool } from "../../../agent/mcp";

const say = (s: string) => JSON.stringify({ choices: [{ delta: { content: s }, finish_reason: null }] });
const tools: AgentTool[] = [
  { name: "set_symbol", title: "Set symbol", description: "Show a symbol.", inputSchema: { type: "object", properties: { symbol: { type: "string" } } }, run: async (a) => ({ symbol: `NASDAQ:${a.symbol}` }) },
];
setAssistantHost({ name: "t", version: () => "1", instructions: "", tools, resources: () => [], prompts: [] }, () => ({}));

describe("the small model's short tool list", () => {
  it("is the prompt it was trained with, byte for byte", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(COMPACT_V1));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe("4c2056112f7b16cad48a1be0a75eead5e5afbd6a6bc5d66a42a2e8778941bc54");
  });

  it("sends it alone (no schemas), reads the calls the model writes, and offers describe_tool", async () => {
    await loadModels();
    server.script = [[say("Showing it.\n<tool_call>\n"), say('{"name": "set_symbol", "arguments": {"symbol": "AAPL"}}\n</tool_call>')], [say("AAPL is on the chart.")]];
    await send("show apple");
    const [first, second] = server.bodies;
    expect(first.tools).toBeUndefined();
    expect(first.messages[0]).toEqual({ role: "system", content: COMPACT_V1 });
    const ms = activeChat()!.messages;
    expect(ms[1]).toMatchObject({ role: "assistant", text: "Showing it.", tools: [{ name: "set_symbol", status: "done", result: '{"symbol":"NASDAQ:AAPL"}' }] });
    expect(ms[2]).toMatchObject({ text: "AAPL is on the chart." });
    // The call goes back as a tool call, its result as a tool message.
    expect(second.messages.slice(-2)).toEqual([
      { role: "assistant", content: "Showing it.", tool_calls: [{ id: expect.any(String), type: "function", function: { name: "set_symbol", arguments: '{"symbol":"AAPL"}' } }] },
      { role: "tool", tool_call_id: expect.any(String), content: '{"symbol":"NASDAQ:AAPL"}' },
    ]);
  });

  it("describe_tool answers with the tool's entry, compact", async () => {
    const d = describeTool(tools);
    expect(await d.run({ name: "set_symbol" })).toBe('{"name":"set_symbol","description":"Show a symbol.","inputSchema":{"type":"object","properties":{"symbol":{"type":"string"}}}}');
    expect(await d.run({ name: "nope" })).toBe('Unknown tool "nope"');
  });
});
