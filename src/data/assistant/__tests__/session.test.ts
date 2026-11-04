import { describe, expect, it, vi } from "vitest";

const kv = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("../../kv", () => ({
  getItem: (k: string) => kv.store.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.store.set(k, v),
  removeItem: (k: string) => void kv.store.delete(k),
  onExternalChange: () => () => undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (d: string) => void = () => {};
  },
}));
// The model: the answers queued in `script`, each a list of stream events; the request bodies are kept.
const server = vi.hoisted(() => ({ script: [] as string[][], bodies: [] as any[] }));
vi.mock("../../../bindings", () => ({
  commands: {
    assistantConfig: async () => ({ models: [{ id: "m1", label: "Test", description: "", baseUrl: "http://x/v1", model: "t", hasKey: false }], selected: "m1", effort: null }),
    assistantChat: async (_id: string, _req: number, body: string, ch: { onmessage: (d: string) => void }) => {
      server.bodies.push(JSON.parse(body));
      for (const e of server.script.shift() ?? []) ch.onmessage(e);
      return { status: "ok", data: null };
    },
    assistantCancel: async () => undefined,
  },
}));

import { loadModels } from "../models";
import { activeChat, answerConfirm, newChat, send, setAssistantHost } from "../session";
import type { AgentServerDef, AgentTool } from "../../../agent/mcp";

const text = (s: string) => JSON.stringify({ choices: [{ delta: { content: s }, finish_reason: "stop" }] });
const call = (id: string, name: string, args: object) =>
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] });

const ran: string[] = [];
const tools: AgentTool[] = [
  { name: "get_chart", title: "Get chart", description: "", inputSchema: { type: "object" }, run: async () => (ran.push("get_chart"), { symbol: "NASDAQ:AAPL" }) },
  {
    name: "delete_watchlist",
    title: "Delete",
    description: "",
    inputSchema: { type: "object" },
    annotations: { destructiveHint: true },
    run: async (a) => (ran.push(`delete ${a.name}`), { deleted: a.name }),
  },
];
const def: AgentServerDef = { name: "t", version: () => "1", instructions: "", tools, resources: () => [], prompts: [] };
setAssistantHost(def, () => ({ symbol: "NASDAQ:AAPL", interval: "1D" }));

describe("assistant agent loop", () => {
  it("runs the tool calls, sends their results back, ends on the model's words", async () => {
    await loadModels();
    server.script = [[call("c1", "get_chart", {})], [text("AAPL on 1D.")]];
    await send("What is on my chart?");
    const c = activeChat()!;
    expect(c.title).toBe("What is on my chart?");
    expect(ran).toEqual(["get_chart"]);
    const [user, first, second] = c.messages;
    expect(user).toEqual({ role: "user", text: "What is on my chart?" });
    expect(first).toMatchObject({ role: "assistant", tools: [{ name: "get_chart", status: "done", result: '{"symbol":"NASDAQ:AAPL"}' }] });
    expect(second).toMatchObject({ role: "assistant", text: "AAPL on 1D." });
    // The second request carries the call and its result, and the tools in the OpenAI shape.
    const body = server.bodies[1];
    expect(body.messages[0].role).toBe("system");
    expect(body.messages.slice(-2)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_chart", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: '{"symbol":"NASDAQ:AAPL"}' },
    ]);
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "get_chart", description: "", parameters: { type: "object" } } });
    expect(body.stream).toBe(true);
  });

  it("waits for the user's go-ahead before a tool that deletes", async () => {
    newChat();
    ran.length = 0;
    server.script = [[call("d1", "delete_watchlist", { name: "Old" })], [text("Kept it.")], [call("d2", "delete_watchlist", { name: "Old" })], [text("Deleted.")]];
    const denied = send("Delete Old");
    await vi.waitFor(() => expect(activeChat()!.messages[1]).toMatchObject({ tools: [{ status: "confirm" }] }));
    answerConfirm("d1", false);
    await denied;
    expect(ran).toEqual([]);
    expect(activeChat()!.messages[1]).toMatchObject({ tools: [{ status: "denied", result: "The user did not allow it." }] });
    const allowed = send("Yes, delete it");
    await vi.waitFor(() => expect(activeChat()!.messages[4]).toMatchObject({ tools: [{ status: "confirm" }] }));
    answerConfirm("d2", true);
    await allowed;
    expect(ran).toEqual(["delete Old"]);
    expect(activeChat()!.messages.slice(-1)[0]).toMatchObject({ text: "Deleted." });
  });

  it("shows the server's error in the chat", async () => {
    newChat();
    server.script = [[JSON.stringify({ error: { message: "No credit left" } })]];
    await send("Hello");
    expect(activeChat()!.messages.slice(-1)[0]).toMatchObject({ role: "assistant", error: "No credit left" });
  });
});
