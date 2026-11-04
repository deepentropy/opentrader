/*
 * The AI assistant's chats and its agent loop. A message goes to the selected model with the app's agent tools (the
 * same ones the MCP server gives coding agents, src/agent/); the tool calls it answers with run in this window, their
 * results go back, until the model answers in words. A tool that deletes something waits for the user's go-ahead.
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
import { config, selectedModel } from "./models";
import { applyEvent, finishedCalls, newTurn, StreamError, type ToolCall, type Turn } from "./stream";
import { systemPrompt, type ChatContext } from "./prompt";

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
let chatContext: () => ChatContext = () => ({});
/** App hands the agent server (its tools and reference texts) and what the focused chart shows. */
export function setAssistantHost(s: AgentServerDef, context: () => ChatContext): void {
  server = s;
  chatContext = context;
}

/** The reference texts (guides, catalogues) as one more tool: the panel has no MCP resources to read. */
async function referenceTool(): Promise<AgentTool | null> {
  const res = server ? await server.resources() : [];
  if (!res.length) return null;
  return {
    name: "read_reference",
    title: "Read reference",
    description: `Read one of OpenTrader's reference texts. Read the oakscriptjs guide before writing a script. uri: ${res.map((r) => `${r.uri} (${r.description})`).join("; ")}.`,
    inputSchema: { type: "object", properties: { uri: { type: "string", enum: res.map((r) => r.uri) } }, required: ["uri"] },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const r = res.find((x) => x.uri === args.uri);
      if (!r) throw new AgentError(`No reference "${String(args.uri)}".`);
      return await r.read();
    },
  };
}

async function toolList(): Promise<AgentTool[]> {
  const ref = await referenceTool();
  return [...(server?.tools ?? []), ...(ref ? [ref] : [])];
}

const asFunctions = (tools: AgentTool[]) =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

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
function wireMessages(c: Chat, context: ChatContext, tools: AgentTool[]) {
  const out: unknown[] = [{ role: "system", content: systemPrompt(context, tools) }];
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
async function ask(c: Chat, tools: AgentTool[]): Promise<Turn> {
  const model = selectedModel();
  if (!model) throw new Error("Add a model first (the model picker).");
  const request = ++requestSeq;
  current = request;
  let turn = newTurn();
  const channel = new Channel<string>();
  channel.onmessage = (data) => {
    turn = applyEvent(turn, data);
    editLast((m) => {
      m.text = turn.content;
      if (turn.reasoning) m.reasoning = turn.reasoning;
    });
  };
  const effort = config().effort;
  const body = {
    messages: wireMessages(c, chatContext(), tools),
    tools: asFunctions(tools),
    stream: true,
    ...(effort ? { reasoning_effort: effort } : {}),
  };
  const r = await commands.assistantChat(model.id, request, JSON.stringify(body), channel);
  current = null;
  if (r.status === "error") throw new Error(r.error);
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
    for (let round = 0; round < MAX_ROUNDS && !stopped; round++) {
      edit((c) => c.messages.push({ role: "assistant", text: "" }));
      const turn = await ask(activeChat()!, tools);
      if (stopped) break;
      const calls = finishedCalls(turn, `call${requestSeq}`);
      if (!calls.length) break;
      editLast((m) => (m.tools = calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments, status: "pending" as const }))));
      for (const call of calls) {
        if (stopped) break;
        await runTool(tools, call, call.id);
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
