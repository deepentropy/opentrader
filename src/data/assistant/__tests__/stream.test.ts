import { describe, expect, it } from "vitest";
import { applyEvent, finishedCalls, newTurn, StreamError } from "../stream";

const ev = (delta: object, finish: string | null = null) => JSON.stringify({ choices: [{ delta, finish_reason: finish }] });

describe("assistant stream", () => {
  it("puts streamed text, reasoning and tool-call pieces together", () => {
    let t = newTurn();
    t = applyEvent(t, ev({ reasoning_content: "Looking " }));
    t = applyEvent(t, ev({ content: "Adding " }));
    t = applyEvent(t, ev({ content: "RSI." }));
    t = applyEvent(t, ev({ tool_calls: [{ index: 0, id: "c1", function: { name: "add_", arguments: '{"indicatorId":' } }] }));
    t = applyEvent(t, ev({ tool_calls: [{ index: 0, function: { name: "indicator", arguments: '"RSI"}' } }] }));
    t = applyEvent(t, ev({ tool_calls: [{ index: 1, id: "c2", function: { name: "get_chart", arguments: "" } }] }, "tool_calls"));
    expect(t.content).toBe("Adding RSI.");
    expect(t.reasoning).toBe("Looking ");
    expect(t.toolCalls).toEqual([
      { id: "c1", name: "add_indicator", arguments: '{"indicatorId":"RSI"}' },
      { id: "c2", name: "get_chart", arguments: "" },
    ]);
    expect(t.finish).toBe("tool_calls");
    // Missing arguments become {}, missing ids are made.
    expect(finishedCalls(t, "r1")[1]).toEqual({ id: "c2", name: "get_chart", arguments: "{}" });
    expect(finishedCalls({ ...t, toolCalls: [{ id: "", name: "x", arguments: "" }] }, "r1")[0].id).toBe("r1-0");
  });

  it("reads a whole answer from a server that does not stream", () => {
    const whole = JSON.stringify({
      choices: [{ message: { content: "Done", tool_calls: [{ id: "a", function: { name: "set_symbol", arguments: '{"symbol":"AAPL"}' } }] }, finish_reason: "tool_calls" }],
    });
    const t = applyEvent(newTurn(), whole);
    expect(t).toMatchObject({ content: "Done", toolCalls: [{ id: "a", name: "set_symbol", arguments: '{"symbol":"AAPL"}' }], finish: "tool_calls" });
  });

  it("throws on an error event and skips what is not JSON", () => {
    expect(() => applyEvent(newTurn(), JSON.stringify({ error: { message: "quota" } }))).toThrow(StreamError);
    expect(applyEvent(newTurn(), ": keep-alive")).toEqual(newTurn());
  });
});
