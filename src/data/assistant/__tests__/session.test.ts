import { describe, expect, it, vi } from "vitest";

vi.mock("../../kv", () => ({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined, onExternalChange: () => () => undefined }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (d: string) => void = () => {};
  },
}));
// The statistics: the events sent.
const sent = vi.hoisted(() => ({ events: [] as { event: string; props: Record<string, any> }[] }));
vi.mock("../../analytics", () => ({ track: (event: string, props: Record<string, any>) => sent.events.push({ event, props }) }));
// The model: the answers queued in `script`, each a list of stream events; the request bodies are kept.
const server = vi.hoisted(() => ({ script: [] as string[][], bodies: [] as any[] }));
vi.mock("../../../bindings", () => ({
  commands: {
    assistantChat: async (_req: number, body: string, ch: { onmessage: (d: string) => void }) => {
      server.bodies.push(JSON.parse(body));
      for (const e of server.script.shift() ?? []) ch.onmessage(e);
      return { status: "ok", data: null };
    },
    assistantCancel: async () => undefined,
  },
}));

import { activeChat, answerConfirm, describeTool, newChat, rateAnswer, send, setAssistantHost } from "../session";
import { PROMPTS } from "../prompts";

// No model installed in the tests: the window sends the prompt of the version this build offers (v2 until v3 ships).
const COMPACT_V1 = PROMPTS[2].text;
import type { AgentTool } from "../../../agent/mcp";

const say = (s: string) => JSON.stringify({ choices: [{ delta: { content: s }, finish_reason: null }] });
const call = (name: string, args: object) => say(`<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`);

const ran: string[] = [];
const tools: AgentTool[] = [
  { name: "set_symbol", title: "Set symbol", description: "Show a symbol.", inputSchema: { type: "object", properties: { symbol: { type: "string" } } }, run: async (a) => (ran.push(`set ${a.symbol}`), { symbol: `NASDAQ:${a.symbol}` }) },
  { name: "get_chart", title: "Get chart", description: "", inputSchema: { type: "object" }, run: async () => { throw new Error("boom"); } },
  {
    name: "delete_watchlist",
    title: "Delete",
    description: "",
    inputSchema: { type: "object" },
    annotations: { destructiveHint: true },
    run: async (a) => (ran.push(`delete ${a.name}`), { deleted: a.name }),
  },
];
setAssistantHost({ name: "t", version: () => "1", instructions: "", tools, resources: () => [], prompts: [] });

describe("assistant agent loop", () => {
  it("sends the trained short tool list, byte for byte, and no schemas", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(COMPACT_V1));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe("4c2056112f7b16cad48a1be0a75eead5e5afbd6a6bc5d66a42a2e8778941bc54");
    server.script = [[say("Showing it.\n<tool_call>\n"), say('{"name": "set_symbol", "arguments": {"symbol": "AAPL"}}\n</tool_call>')], [say("AAPL is on the chart.")]];
    await send("show apple");
    const [first, second] = server.bodies;
    expect(first.tools).toBeUndefined();
    expect(first.temperature).toBe(0);
    expect(first.messages[0]).toEqual({ role: "system", content: COMPACT_V1 });
    const ms = activeChat()!.messages;
    expect(activeChat()!.title).toBe("show apple");
    expect(ms[1]).toMatchObject({ role: "assistant", text: "Showing it.", tools: [{ name: "set_symbol", status: "done", result: '{"symbol":"NASDAQ:AAPL"}' }] });
    expect(ms[2]).toMatchObject({ text: "AAPL is on the chart." });
    // The call goes back as a tool call, its result as a tool message.
    expect(second.messages.slice(-2)).toEqual([
      { role: "assistant", content: "Showing it.", tool_calls: [{ id: expect.any(String), type: "function", function: { name: "set_symbol", arguments: '{"symbol":"AAPL"}' } }] },
      { role: "tool", tool_call_id: expect.any(String), content: '{"symbol":"NASDAQ:AAPL"}' },
    ]);
  });

  it("waits for the user's go-ahead before a tool that deletes", async () => {
    newChat();
    ran.length = 0;
    server.script = [[call("delete_watchlist", { name: "Old" })], [say("Kept it.")], [call("delete_watchlist", { name: "Old" })], [say("Deleted.")]];
    const denied = send("Delete Old");
    await vi.waitFor(() => expect(activeChat()!.messages[1]).toMatchObject({ tools: [{ status: "confirm" }] }));
    answerConfirm((activeChat()!.messages[1] as { tools: { id: string }[] }).tools[0].id, false);
    await denied;
    expect(ran).toEqual([]);
    expect(activeChat()!.messages[1]).toMatchObject({ tools: [{ status: "denied", result: "The user did not allow it." }] });
    const allowed = send("Yes, delete it");
    await vi.waitFor(() => expect(activeChat()!.messages[4]).toMatchObject({ tools: [{ status: "confirm" }] }));
    answerConfirm((activeChat()!.messages[4] as { tools: { id: string }[] }).tools[0].id, true);
    await allowed;
    expect(ran).toEqual(["delete Old"]);
    expect(activeChat()!.messages.slice(-1)[0]).toMatchObject({ text: "Deleted." });
  });

  it("stops a call that keeps failing, and shows the server's error", async () => {
    newChat();
    server.script = [[call("get_chart", {})], [call("get_chart", {})], [call("get_chart", {})], [say("never asked")]];
    await send("What is on my chart?");
    expect(activeChat()!.messages.slice(-1)[0]).toMatchObject({ error: "Stopped: get_chart failed three times (boom)." });
    newChat();
    server.script = [[JSON.stringify({ error: { message: "out of memory" } })]];
    await send("Hello");
    expect(activeChat()!.messages.slice(-1)[0]).toMatchObject({ role: "assistant", error: "out of memory" });
  });

  it("says so when the model ends with no text after a failed step", async () => {
    newChat();
    server.script = [[call("get_chart", {})], [say("")]];
    await send("What is on my chart?");
    const ms = activeChat()!.messages;
    expect(ms[1]).toMatchObject({ tools: [{ status: "error", result: "boom" }] });
    expect(ms.slice(-1)[0]).toMatchObject({ text: "", error: "No answer: try asking another way." });
  });

  it("stops when the same call comes back three times with the same result", async () => {
    newChat();
    ran.length = 0;
    server.script = [[call("set_symbol", { symbol: "X" })], [call("set_symbol", { symbol: "X" })], [call("set_symbol", { symbol: "X" })], [say("never asked")]];
    await send("loop");
    expect(ran).toEqual(["set X", "set X", "set X"]);
    expect(activeChat()!.messages.slice(-1)[0]).toMatchObject({ error: "Stopped: the same set_symbol came back three times with the same result. Try asking another way." });
  });

  it("puts each question in the statistics: its requests, actions and outcome, and the thumbs given", async () => {
    newChat();
    sent.events.length = 0;
    server.script = [[call("set_symbol", { symbol: "MU" })], [say("MU is on the chart.")]];
    await send("show micron");
    const names = sent.events.map((e) => e.event);
    expect(names).toEqual(["$ai_generation", "$ai_span", "$ai_generation", "$ai_trace"]);
    const [gen, span, , trace] = sent.events.map((e) => e.props);
    const id = trace.$ai_trace_id;
    expect(sent.events.every((e) => e.props.$ai_trace_id === id && e.props.$ai_session_id === activeChat()!.id)).toBe(true);
    // The system prompt goes by its name; the model's calls go as tool calls.
    expect(gen).toMatchObject({ $ai_model: "opentrader-assistant-v2", $ai_provider: "local", $ai_stop_reason: "tool_use", $ai_is_error: false });
    expect(gen.$ai_input[0]).toEqual({ role: "system", content: "[compact-v1]" });
    expect(gen.$ai_output_choices[0].tool_calls[0].function).toEqual({ name: "set_symbol", arguments: '{"symbol":"MU"}' });
    expect(span).toMatchObject({ $ai_span_name: "set_symbol", $ai_parent_id: gen.$ai_span_id, $ai_output_state: '{"symbol":"NASDAQ:MU"}', tool_status: "done" });
    expect(trace).toMatchObject({ $ai_input_state: "show micron", $ai_output_state: "MU is on the chart.", rounds: 2, $ai_is_error: false });
    // The thumbs: on the answer's last message, once (the same again takes it back).
    rateAnswer(id, "bad");
    expect(sent.events.slice(-1)[0]).toMatchObject({ event: "assistant_feedback", props: { $ai_trace_id: id, rating: "bad" } });
    expect(activeChat()!.messages.slice(-1)[0]).toMatchObject({ trace: id, rating: "bad" });
    rateAnswer(id, "bad");
    expect(activeChat()!.messages.slice(-1)[0]).toMatchObject({ rating: undefined });
  });

  it("describe_tool answers with the tool's entry, compact", async () => {
    const d = describeTool(tools);
    expect(await d.run({ name: "set_symbol" })).toBe('{"name":"set_symbol","description":"Show a symbol.","inputSchema":{"type":"object","properties":{"symbol":{"type":"string"}}}}');
    expect(await d.run({ name: "nope" })).toBe('Unknown tool "nope"');
  });
});
