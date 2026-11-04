/*
 * Settings > Coding agents, window side: answers the MCP messages the Rust endpoint hands this window (agent.rs).
 * Installed by App in the desktop app only; the AI assistant panel runs the same tools (src/data/assistant/).
 */
import { commands, events } from "../bindings";
import { buildInfo } from "../data/app-update";
import { currentWindowLabel } from "../window/shell/window-bridge";
import { indicatorCatalogueResource } from "./catalogue";
import { AGENT_INSTRUCTIONS, AGENT_PROMPTS, drawingToolsResource, libraryGuideResources } from "./guide";
import { handleMessage, type AgentServerDef } from "./mcp";
import { createAgentTools, type AgentHost } from "./tools";

export function createAgentServer(host: AgentHost): AgentServerDef {
  let version = "";
  void buildInfo().then((i) => (version = i?.version ?? ""));
  return {
    name: "opentrader",
    version: () => version || "0",
    instructions: AGENT_INSTRUCTIONS,
    tools: createAgentTools(host),
    resources: () => [...libraryGuideResources(), indicatorCatalogueResource(), drawingToolsResource()],
    prompts: AGENT_PROMPTS,
  };
}

/** Listen for the endpoint's messages, answered by `server` (the one the AI assistant panel shares); returns the stop
 *  function. */
export function installAgentBridge(server: AgentServerDef): () => void {
  let stop: (() => void) | null = null;
  let stopped = false;
  const label = currentWindowLabel();
  void events.agentRequest
    .listen(async (e) => {
      const { window, id, body } = e.payload;
      if (window !== label) return;
      const reply = await handleMessage(server, body).catch((err) =>
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(err) } }),
      );
      await commands.agentReply(id, reply);
    })
    .then((un) => {
      if (stopped) un();
      else {
        stop = un;
        void commands.agentReady();
      }
    });
  return () => {
    stopped = true;
    stop?.();
  };
}
