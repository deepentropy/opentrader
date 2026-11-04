/*
 * One answer of an OpenAI-compatible chat server, put together from the events it streams (each `delta` adds text or
 * pieces of tool calls, keyed by their index), or read whole from a server that answers without streaming.
 */

export type ToolCall = { id: string; name: string; arguments: string };

export type Turn = {
  content: string;
  /** The reasoning some servers stream apart (`reasoning_content`, `reasoning`): shown folded, never sent back. */
  reasoning: string;
  toolCalls: ToolCall[];
  finish: string | null;
};

export const newTurn = (): Turn => ({ content: "", reasoning: "", toolCalls: [], finish: null });

type Delta = {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
};

/** A server error sent inside the stream. */
export class StreamError extends Error {}

/** `turn` with one event (its JSON text) applied. */
export function applyEvent(turn: Turn, json: string): Turn {
  let ev: {
    error?: { message?: string } | string;
    choices?: { delta?: Delta; message?: Delta; finish_reason?: string | null }[];
  };
  try {
    ev = JSON.parse(json);
  } catch {
    return turn;
  }
  if (ev.error) throw new StreamError(typeof ev.error === "string" ? ev.error : (ev.error.message ?? "The server sent an error."));
  const choice = ev.choices?.[0];
  if (!choice) return turn;
  const next: Turn = { ...turn, toolCalls: turn.toolCalls.map((c) => ({ ...c })) };
  // A whole answer (no streaming): the message replaces what came before.
  const whole = choice.message;
  const d = whole ?? choice.delta ?? {};
  if (whole) {
    next.content = "";
    next.reasoning = "";
    next.toolCalls = [];
  }
  if (d.content) next.content += d.content;
  const r = d.reasoning_content ?? d.reasoning;
  if (r) next.reasoning += r;
  (d.tool_calls ?? []).forEach((tc, i) => {
    const at = whole ? i : (tc.index ?? next.toolCalls.length);
    const call = (next.toolCalls[at] ??= { id: "", name: "", arguments: "" });
    if (tc.id) call.id = tc.id;
    if (tc.function?.name) call.name += tc.function.name;
    if (tc.function?.arguments) call.arguments += tc.function.arguments;
  });
  if (choice.finish_reason) next.finish = choice.finish_reason;
  return next;
}

/** The tool calls of a finished turn, each with an id (some local servers send none). */
export function finishedCalls(turn: Turn, prefix: string): ToolCall[] {
  return turn.toolCalls.filter((c) => c && c.name).map((c, i) => ({ ...c, id: c.id || `${prefix}-${i}`, arguments: c.arguments || "{}" }));
}
