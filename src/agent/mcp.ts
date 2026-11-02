/*
 * The MCP methods of Settings > Coding agents, answered in the window (the Rust endpoint only carries the JSON-RPC
 * messages, agent.rs). Stateless: every request stands alone, so any window can answer it.
 */

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };

export type AgentTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Its answer: a ToolResult as is, anything else as JSON text. A throw is a tool error the agent reads. */
  run: (args: Record<string, unknown>) => Promise<unknown>;
};

export type AgentResource = {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => Promise<string> | string;
};

export type AgentPrompt = {
  name: string;
  description: string;
  arguments?: { name: string; description: string; required?: boolean }[];
  text: (args: Record<string, string>) => string;
};

export type AgentServerDef = {
  name: string;
  version: () => string;
  instructions: string;
  tools: AgentTool[];
  resources: () => Promise<AgentResource[]> | AgentResource[];
  prompts: AgentPrompt[];
};

/** Newest first; an unknown version asked by the client gets the newest. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** A failure the agent should read as is (bad arguments, nothing on the chart…). */
export class AgentError extends Error {}

type Id = string | number | null;
type RpcMessage = { jsonrpc?: string; id?: Id; method?: string; params?: Record<string, unknown> };

class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

const result = (id: Id, value: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result: value });
const failure = (id: Id, code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

function asToolResult(value: unknown): ToolResult {
  if (value && typeof value === "object" && Array.isArray((value as ToolResult).content)) return value as ToolResult;
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

async function callTool(server: AgentServerDef, params: Record<string, unknown>): Promise<ToolResult> {
  const name = params.name;
  const tool = server.tools.find((t) => t.name === name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    return asToolResult(await tool.run(args));
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (!(e instanceof AgentError)) console.warn(`[agent] ${tool.name} failed`, e);
    return { content: [{ type: "text", text }], isError: true };
  }
}

async function dispatch(server: AgentServerDef, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: server.name, title: "OpenTrader", version: server.version() },
        instructions: server.instructions,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: server.tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
      };
    case "tools/call":
      return callTool(server, params);
    case "resources/list":
      return {
        resources: (await server.resources()).map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
      };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "resources/read": {
      const uri = String(params.uri ?? "");
      const res = (await server.resources()).find((r) => r.uri === uri);
      if (!res) throw new RpcError(-32002, `Resource not found: ${uri}`);
      return { contents: [{ uri, mimeType: res.mimeType, text: await res.read() }] };
    }
    case "prompts/list":
      return { prompts: server.prompts.map(({ name, description, arguments: a }) => ({ name, description, arguments: a ?? [] })) };
    case "prompts/get": {
      const p = server.prompts.find((x) => x.name === params.name);
      if (!p) throw new RpcError(-32602, `Unknown prompt: ${String(params.name)}`);
      const args = (params.arguments ?? {}) as Record<string, string>;
      for (const a of p.arguments ?? []) if (a.required && !args[a.name]) throw new RpcError(-32602, `Missing argument: ${a.name}`);
      return { description: p.description, messages: [{ role: "user", content: { type: "text", text: p.text(args) } }] };
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/** The answer to one JSON-RPC message ("" = a notification or a response: nothing to answer). */
export async function handleMessage(server: AgentServerDef, raw: string): Promise<string> {
  let msg: RpcMessage;
  try {
    msg = JSON.parse(raw) as RpcMessage;
  } catch {
    return failure(null, -32700, "Parse error");
  }
  if (Array.isArray(msg)) return failure(null, -32600, "Batches are not supported");
  if (!msg || typeof msg !== "object") return failure(null, -32600, "Invalid request");
  const isRequest = msg.id !== undefined && msg.id !== null && typeof msg.method === "string";
  if (!isRequest) return "";
  const id = msg.id as Id;
  try {
    return result(id, await dispatch(server, msg.method!, msg.params ?? {}));
  } catch (e) {
    if (e instanceof RpcError) return failure(id, e.code, e.message);
    return failure(id, -32603, e instanceof Error ? e.message : String(e));
  }
}
