/*
 * Tools of dev builds only (never in a release, the tests or the tool list exported for training): what the user does
 * by hand that a recorded example of the assistant needs, done over MCP. dev_attach_file attaches a file to the chat
 * as the assistant panel's Attach button does, so read_trade_file and import_trades read it by its id.
 */
import { attach, MAX_ATTACHMENT_BYTES } from "../data/assistant/attachments";
import { AgentError, type AgentTool } from "./mcp";

export const DEV_TOOLS = import.meta.env.DEV && import.meta.env.MODE !== "test";

export function createDevTools(): AgentTool[] {
  return [
    {
      name: "dev_attach_file",
      title: "Attach a file (dev builds)",
      description: "Dev builds only: attach a file to the assistant chat as the user does with the Attach button. Gives its file id.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: 'File name ("trades.csv").' }, text: { type: "string" } },
        required: ["name", "text"],
      },
      run: async (args) => {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        const text = typeof args.text === "string" ? args.text : "";
        if (!name || !text) throw new AgentError('"name" and "text" are required.');
        if (new TextEncoder().encode(text).length > MAX_ATTACHMENT_BYTES) throw new AgentError("The file is too large: 5 MB at most.");
        const a = attach(name, text);
        return { id: a.id, name: a.name };
      },
    },
  ];
}
