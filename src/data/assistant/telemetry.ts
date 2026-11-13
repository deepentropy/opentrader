/*
 * The AI assistant's conversations in the usage statistics (PostHog LLM analytics, through the same switch and relay
 * as the rest: src/data/analytics.ts; the privacy policy names them). One trace per question: its model requests
 * ($ai_generation), the app actions they ran ($ai_span) and the outcome ($ai_trace), grouped by chat
 * ($ai_session_id); a thumbs up or down on an answer is `assistant_feedback` on the same trace. They tell where the
 * model goes wrong, and feed its next training.
 *
 * Kept small: the system prompt goes as its name (it is fixed), tool results are cut, pictures never leave.
 */
import { track } from "../analytics";
import { modelVersion, promptFor } from "./prompts";

/** The installed model, by its fine-tune version (src-tauri/src/local_model.rs), and the prompt it was trained with. */
export const model = () => `opentrader-assistant-v${modelVersion()}`;
/** A tool result or argument longer than this is cut in the statistics. */
const MAX_TEXT = 4000;

const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…(${s.length - MAX_TEXT} more)` : s);

export const newTraceId = (): string => crypto.randomUUID();

type Wire = { role: string; content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };

/** The messages as sent, lighter: the system prompt by name, long contents cut. */
export function lightMessages(messages: unknown[]): unknown[] {
  return (messages as Wire[]).map((m) =>
    m.role === "system"
      ? { role: "system", content: `[${promptFor(modelVersion()).name}]` }
      : {
          ...m,
          ...(typeof m.content === "string" ? { content: cut(m.content) } : {}),
          ...(m.tool_calls ? { tool_calls: m.tool_calls.map((c) => ({ ...c, function: { ...c.function, arguments: cut(c.function.arguments) } })) } : {}),
        },
  );
}

const base = (trace: string, chat: string) => ({ $ai_trace_id: trace, $ai_session_id: chat, $ai_model: model(), $ai_provider: "local" });

/** One model request. */
export function trackGeneration(o: {
  trace: string;
  chat: string;
  span: string;
  messages: unknown[];
  text: string;
  calls: { name: string; arguments: string }[];
  latencySec: number;
  firstTokenSec?: number;
  error?: string;
}): void {
  track("$ai_generation", {
    ...base(o.trace, o.chat),
    $ai_span_id: o.span,
    $ai_parent_id: o.trace,
    $ai_input: lightMessages(o.messages),
    $ai_output_choices: [
      {
        role: "assistant",
        content: o.text,
        ...(o.calls.length ? { tool_calls: o.calls.map((c) => ({ type: "function", function: { name: c.name, arguments: cut(c.arguments) } })) } : {}),
      },
    ],
    $ai_latency: o.latencySec,
    ...(o.firstTokenSec !== undefined ? { $ai_time_to_first_token: o.firstTokenSec } : {}),
    $ai_stream: true,
    $ai_temperature: 0,
    $ai_stop_reason: o.error ? "error" : o.calls.length ? "tool_use" : "stop",
    $ai_is_error: !!o.error,
    ...(o.error ? { $ai_error: o.error } : {}),
  });
}

/** One app action the model asked for. */
export function trackToolSpan(o: { trace: string; chat: string; parent: string; name: string; args: string; status: string; result?: string; latencySec: number }): void {
  const failed = o.status === "error";
  track("$ai_span", {
    $ai_trace_id: o.trace,
    $ai_session_id: o.chat,
    $ai_span_id: newTraceId(),
    $ai_parent_id: o.parent,
    $ai_span_name: o.name,
    $ai_input_state: cut(o.args),
    $ai_output_state: o.result !== undefined ? cut(o.result) : o.status,
    $ai_latency: o.latencySec,
    $ai_is_error: failed,
    ...(failed ? { $ai_error: o.result ?? "failed" } : {}),
    // denied: the user did not allow a delete.
    tool_status: o.status,
  });
}

/** One question and how it ended. */
export function trackTrace(o: {
  trace: string;
  chat: string;
  question: string;
  answer: string;
  latencySec: number;
  rounds: number;
  error?: string;
  /** Why it stopped early: "user", "repeat", "rounds". */
  stopped?: string;
}): void {
  track("$ai_trace", {
    ...base(o.trace, o.chat),
    $ai_span_name: "assistant_question",
    $ai_input_state: o.question,
    $ai_output_state: o.answer,
    $ai_latency: o.latencySec,
    $ai_is_error: !!o.error,
    ...(o.error ? { $ai_error: o.error } : {}),
    rounds: o.rounds,
    ...(o.stopped ? { stopped: o.stopped } : {}),
  });
}

/** A thumbs up or down on an answer. */
export function trackFeedback(trace: string, chat: string, rating: "good" | "bad"): void {
  track("assistant_feedback", { ...base(trace, chat), rating });
}
