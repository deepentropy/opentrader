/*
 * The AI assistant's chats and its agent loop. A message goes to OpenTrader's model (on this computer, local_model.rs)
 * with the short tool list it was trained with; the tool calls it writes run in this window with the app's agent tools
 * (the same ones the MCP server gives coding agents, src/agent/), their results go back, until the model answers in
 * words. A tool that deletes something waits for the user's go-ahead.
 *
 * Chats are kept in kv (the 50 latest, pictures left out).
 */
import { Channel } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { commands } from "../../bindings";
import type { AgentServerDef, AgentTool, ToolResult } from "../../agent/mcp";
import { AgentError } from "../../agent/mcp";
import * as kv from "../kv";
import { applyEvent, finishedCalls, newTurn, shownText, StreamError, textToolCalls, type ToolCall, type Turn } from "./stream";
// The short tool list the model was trained with, byte for byte (its sha256 is checked by a test).
import COMPACT_V1_RAW from "./compact-v1.txt?raw";

export type ToolStep = {
  id: string;
  name: string;
  /** The arguments as the model wrote them (JSON text). */
  arguments: string;
  status: "pending" | "confirm" | "running" | "done" | "error" | "denied";
  /** What goes back to the model. */
  result?: string;
  /** A picture the tool gave (a screenshot): shown, not kept, not sent. */
  image?: string;
};

export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; reasoning?: string; tools?: ToolStep[]; error?: string };

export type Chat = { id: string; title: string; createdAt: number; updatedAt: number; messages: ChatMessage[] };

const KEY = "ot:assistant:chats:v1";
const MAX_CHATS = 50;
const MAX_ROUNDS = 16;
/** A tool result longer than this is cut (the model's context is not endless). */
const MAX_RESULT = 24_000;

function readChats(): Chat[] {
  try {
    const v = JSON.parse(kv.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages)) : [];
  } catch {
    return [];
  }
}

const [state, setState] = createStore<{ chats: Chat[]; activeId: string | null }>({ chats: readChats(), activeId: null });
const [running, setRunning] = createSignal(false);
kv.onExternalChange(KEY, () => {
  if (!running()) setState("chats", reconcile(readChats()));
});

function save(): void {
  const keep = [...state.chats]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CHATS)
    .map((c) => ({ ...c, messages: c.messages.map((m) => (m.role === "assistant" && m.tools ? { ...m, tools: m.tools.map(({ image: _i, ...t }) => t) } : m)) }));
  kv.setItem(KEY, JSON.stringify(keep));
}

// ── The window's tools ───────────────────────────────────────────────────
let server: AgentServerDef | null = null;
let hostReady: () => void = () => {};
/** Resolves once App has handed the tools (they load after the window's first paint). */
const host = new Promise<void>((resolve) => (hostReady = resolve));
/** App hands the agent server (its tools). */
export function setAssistantHost(s: AgentServerDef): void {
  server = s;
  hostReady();
}

/** The short tool list as the model saw it in training (line ends as written there). */
export const COMPACT_V1 = COMPACT_V1_RAW.replace(/\r\n/g, "\n");

/** The model reads a tool's schema when it needs it. */
export function describeTool(tools: AgentTool[]): AgentTool {
  return {
    name: "describe_tool",
    title: "Describe tool",
    description: "The full JSON schema of a tool.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const t = tools.find((x) => x.name === args.name);
      if (!t) return `Unknown tool "${String(args.name)}"`;
      return JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    },
  };
}

async function toolList(): Promise<AgentTool[]> {
  // A message sent right after the window opened waits for the tools.
  await Promise.race([host, new Promise((r) => setTimeout(r, 30_000))]);
  if (!server) throw new Error("The app's tools are not ready: try again in a moment.");
  return [...server.tools, describeTool(server.tools)];
}

/** A tool's answer as the text the model reads, and a picture to show. */
function resultOf(value: unknown): { text: string; image?: string } {
  const r = value as ToolResult;
  if (r && typeof r === "object" && Array.isArray(r.content)) {
    let image: string | undefined;
    const parts = r.content.map((c) => {
      if (c.type === "image") {
        image = `data:${c.mimeType};base64,${c.data}`;
        return "[The picture is shown to the user.]";
      }
      return c.text;
    });
    return { text: parts.join("\n"), image };
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { text: text === undefined ? "null" : text };
}

const cut = (s: string) => (s.length > MAX_RESULT ? `${s.slice(0, MAX_RESULT)}\n…(cut: ${s.length - MAX_RESULT} more characters)` : s);

// ── Chats ────────────────────────────────────────────────────────────────
export const chats = () => [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt);
export const activeChat = () => state.chats.find((c) => c.id === state.activeId) ?? null;
export { running };

export function newChat(): void {
  if (running()) stop();
  setState("activeId", null);
}

export function openChat(id: string): void {
  if (running()) stop();
  if (state.chats.some((c) => c.id === id)) setState("activeId", id);
}

export function deleteChat(id: string): void {
  if (state.activeId === id) setState("activeId", null);
  setState("chats", (cs) => cs.filter((c) => c.id !== id));
  save();
}

export function renameChat(id: string, title: string): void {
  const t = title.trim();
  if (!t) return;
  setState("chats", (c) => c.id === id, "title", t);
  save();
}

/** Changes the active chat in place. */
function edit(fn: (c: Chat) => void): void {
  const id = state.activeId;
  setState("chats", (c) => c.id === id, produce((c: Chat) => {
    fn(c);
    c.updatedAt = Date.now();
  }));
}

/** The last message of the active chat, an assistant one. */
function editLast(fn: (m: Extract<ChatMessage, { role: "assistant" }>) => void): void {
  edit((c) => {
    const m = c.messages[c.messages.length - 1];
    if (m?.role === "assistant") fn(m);
  });
}

// ── Confirmations ────────────────────────────────────────────────────────
const waiting = new Map<string, (ok: boolean) => void>();
/** The user's answer to a tool that waits for one (Allow / Don't allow). */
export function answerConfirm(stepId: string, ok: boolean): void {
  waiting.get(stepId)?.(ok);
  waiting.delete(stepId);
}

// ── The loop ─────────────────────────────────────────────────────────────
let requestSeq = 0;
let current: number | null = null;
let stopped = false;

/** Stops the answer under way: the request, and the tools waiting for a go-ahead. */
export function stop(): void {
  stopped = true;
  if (current !== null) void commands.assistantCancel(current);
  for (const [id, resolve] of waiting) {
    resolve(false);
    waiting.delete(id);
  }
}

/** The chat as the model reads it. */
function wireMessages(c: Chat) {
  const out: unknown[] = [{ role: "system", content: COMPACT_V1 }];
  for (const m of c.messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
      continue;
    }
    const calls = (m.tools ?? []).filter((t) => t.status !== "pending");
    if (!m.text && !calls.length) continue;
    out.push({
      role: "assistant",
      content: m.text || null,
      ...(calls.length ? { tool_calls: calls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } })) } : {}),
    });
    for (const t of calls) {
      out.push({ role: "tool", tool_call_id: t.id, content: t.result ?? (t.status === "denied" ? "The user did not allow it." : "Stopped.") });
    }
  }
  return out;
}

/** One request to the model; the turn grows in the chat's last message while it streams. */
async function ask(c: Chat): Promise<Turn> {
  // The short tool list is in the system text (no schemas sent); the model writes its calls in its text.
  const request = ++requestSeq;
  current = request;
  let turn = newTurn();
  const channel = new Channel<string>();
  channel.onmessage = (data) => {
    turn = applyEvent(turn, data);
    editLast((m) => {
      m.text = shownText(turn.content);
      if (turn.reasoning) m.reasoning = turn.reasoning;
    });
  };
  // Temperature 0: the model was trained and measured that way; sampling makes it pick other routes each time.
  const body = { messages: wireMessages(c), stream: true, temperature: 0 };
  const r = await commands.assistantChat(request, JSON.stringify(body), channel);
  current = null;
  if (r.status === "error") throw new Error(r.error);
  if (!turn.toolCalls.length) {
    const { text, calls } = textToolCalls(turn.content, `call${request}`);
    turn = { ...turn, content: text, toolCalls: calls };
    editLast((m) => (m.text = text));
  }
  return turn;
}

async function runTool(tools: AgentTool[], call: ToolCall, stepId: string): Promise<void> {
  const setStep = (patch: Partial<ToolStep>) =>
    editLast((m) => {
      const s = m.tools?.find((t) => t.id === stepId);
      if (s) Object.assign(s, patch);
    });
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) {
    setStep({ status: "error", result: `Unknown tool "${call.name}". Tools: ${tools.map((t) => t.name).join(", ")}.` });
    return;
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    setStep({ status: "error", result: `The arguments are not JSON: ${call.arguments}` });
    return;
  }
  if (tool.annotations?.destructiveHint) {
    setStep({ status: "confirm" });
    const ok = await new Promise<boolean>((resolve) => waiting.set(stepId, resolve));
    if (!ok) {
      setStep({ status: "denied", result: "The user did not allow it." });
      return;
    }
  }
  setStep({ status: "running" });
  try {
    const { text, image } = resultOf(await tool.run(args));
    setStep({ status: "done", result: cut(text), ...(image ? { image } : {}) });
  } catch (e) {
    if (!(e instanceof AgentError)) console.warn(`[assistant] ${tool.name} failed`, e);
    setStep({ status: "error", result: e instanceof Error ? e.message : String(e) });
  }
}

/** Sends a message in the active chat (a new chat when there is none) and runs the answer to its end. */
export async function send(text: string): Promise<void> {
  const t = text.trim();
  if (!t || running()) return;
  if (!state.activeId) {
    const now = Date.now();
    const chat: Chat = { id: `c${now.toString(36)}`, title: t.length > 60 ? `${t.slice(0, 57)}…` : t, createdAt: now, updatedAt: now, messages: [] };
    setState("chats", (cs) => [...cs, chat]);
    setState("activeId", chat.id);
  }
  edit((c) => c.messages.push({ role: "user", text: t }));
  setRunning(true);
  stopped = false;
  try {
    const tools = await toolList();
    const repeats = new Map<string, number>();
    for (let round = 0; round < MAX_ROUNDS && !stopped; round++) {
      edit((c) => c.messages.push({ role: "assistant", text: "" }));
      const turn = await ask(activeChat()!);
      if (stopped) break;
      const calls = finishedCalls(turn, `call${requestSeq}`);
      if (!calls.length) break;
      editLast((m) => (m.tools = calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments, status: "pending" as const }))));
      for (const call of calls) {
        if (stopped) break;
        await runTool(tools, call, call.id);
      }
      // A small model can go round in circles: the same call a third time in this answer gets the same result, so stop
      // and say so (with the error when it failed).
      const ms = activeChat()!.messages;
      const steps = (ms[ms.length - 1] as Extract<ChatMessage, { role: "assistant" }>).tools ?? [];
      const key = (t: ToolStep) => `${t.name} ${t.arguments}`;
      for (const t of steps) repeats.set(key(t), (repeats.get(key(t)) ?? 0) + 1);
      const repeated = steps.find((t) => (repeats.get(key(t)) ?? 0) >= 3);
      if (repeated) {
        editLast(
          (m) =>
            (m.error =
              repeated.status === "error"
                ? `Stopped: ${repeated.name} failed three times (${repeated.result}).`
                : `Stopped: the same ${repeated.name} came back three times with the same result. Try asking another way.`),
        );
        break;
      }
      if (round === MAX_ROUNDS - 1) editLast((m) => (m.error = "Stopped after too many steps: ask again to go on."));
    }
  } catch (e) {
    const msg = e instanceof StreamError || e instanceof Error ? e.message : String(e);
    edit((c) => {
      const last = c.messages[c.messages.length - 1];
      if (last?.role === "assistant") last.error = msg;
      else c.messages.push({ role: "assistant", text: "", error: msg });
    });
  } finally {
    current = null;
    setRunning(false);
    // A step still waiting (stopped meanwhile) is marked so.
    editLast((m) => m.tools?.forEach((s) => (s.status === "pending" || s.status === "confirm" || s.status === "running") && ((s.status = "denied"), (s.result ??= "Stopped."))));
    save();
  }
}
