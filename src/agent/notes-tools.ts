/*
 * Symbol notes tools of Settings > Coding agents (#301): read the notes the user wrote about symbols, write one (with
 * the charts shown, and a picture of the chart when asked) and delete one, through the same store as the Details
 * panel's notes.
 */
import { chartBridge } from "../data/community/chart-share";
import { toFullSymbol } from "../data/datafeed";
import { addNote, allNotes, removeNote, saveSnapshot, type SymbolNote } from "../data/symbol-notes";
import { AgentError, type AgentTool } from "./mcp";

/** Characters of a note shown by list_notes (read_note gives it whole). */
const PREVIEW = 160;
const MAX_LIST = 50;
const MAX_TEXT = 20_000;

/** Local date and time "YYYY-MM-DD HH:MM" of UNIX ms: what the user saw when writing it. */
function localTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function symbolOf(raw: unknown, what: string): Promise<string> {
  if (typeof raw !== "string" || !raw.trim()) throw new AgentError(`"${what}": a symbol ("AAPL" or "NASDAQ:AAPL").`);
  try {
    return (await toFullSymbol(raw)).toUpperCase();
  } catch {
    throw new AgentError(`Unknown symbol "${raw.trim()}".`);
  }
}

function noteById(id: unknown): SymbolNote {
  const n = typeof id === "string" ? allNotes().find((x) => x.id === id.trim()) : undefined;
  if (!n) throw new AgentError(`No note with id "${String(id)}": take ids from list_notes.`);
  return n;
}

export function createNotesTools(focused: () => string): AgentTool[] {
  return [
    {
      name: "list_notes",
      title: "List notes",
      description:
        "The user's notes on symbols, newest first: id (for read_note), symbol, date (local time), the start of the text, and whether a chart picture is kept. " +
        "symbol: only that symbol's notes; query: notes whose text has these words.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: 'A symbol ("AAPL" or "NASDAQ:AAPL"). Default: every symbol.' },
          query: { type: "string", description: "Words the note's text has." },
        },
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        let list = [...allNotes()];
        if (args.symbol !== undefined) {
          const s = await symbolOf(args.symbol, "symbol");
          list = list.filter((n) => n.symbol === s);
        }
        const words = typeof args.query === "string" ? args.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
        if (words.length) list = list.filter((n) => words.every((w) => n.content.toLowerCase().includes(w)));
        list.sort((a, b) => b.created - a.created);
        return {
          total: list.length,
          symbols: [...new Set(allNotes().map((n) => n.symbol))].length,
          notes: list.slice(0, MAX_LIST).map((n) => ({
            id: n.id,
            symbol: n.symbol,
            date: localTime(n.created),
            text: n.content.length > PREVIEW ? `${n.content.slice(0, PREVIEW)}…` : n.content,
            ...(n.snapshot ? { picture: true } : {}),
          })),
          ...(list.length > MAX_LIST ? { more: list.length - MAX_LIST } : {}),
        };
      },
    },
    {
      name: "read_note",
      title: "Read note",
      description: "A note whole: its symbol, dates (local time), text, whether a chart picture is kept, and the charts shown when it was written (symbol and interval of each).",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "Id from list_notes." } }, required: ["id"] },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const n = noteById(args.id);
        return {
          id: n.id,
          symbol: n.symbol,
          date: localTime(n.created),
          ...(n.modified !== n.created ? { edited: localTime(n.modified) } : {}),
          text: n.content,
          picture: Boolean(n.snapshot),
          ...(n.view ? { charts: n.view.panes.map((p) => ({ symbol: p.symbol, interval: p.interval })) } : {}),
        };
      },
    },
    {
      name: "add_note",
      title: "Add note",
      description:
        "Write a note on a symbol (default: the focused chart's), as the user does in the Details panel. It keeps the charts shown now; " +
        "picture: true also keeps a picture of the focused chart. Write what the user asked to note, in their words.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Default: the focused chart's symbol." },
          text: { type: "string" },
          picture: { type: "boolean", description: "Keep a picture of the focused chart with the note." },
        },
        required: ["text"],
      },
      run: async (args) => {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) throw new AgentError('"text" is required.');
        if (text.length > MAX_TEXT) throw new AgentError(`"text": at most ${MAX_TEXT} characters.`);
        const symbol = await symbolOf(args.symbol ?? focused(), "symbol");
        let snapshot: string | undefined;
        if (args.picture === true) {
          const c = await chartBridge()?.capture();
          if (!c) throw new AgentError("The chart could not be pictured: add the note without picture.");
          snapshot = await saveSnapshot(c.image);
        }
        const n = addNote(symbol, text, snapshot);
        return { id: n.id, symbol: n.symbol, date: localTime(n.created), picture: Boolean(n.snapshot) };
      },
    },
    {
      name: "delete_note",
      title: "Delete note",
      description: "Delete a note (and its chart picture). Ask the user first: it cannot be undone.",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "Id from list_notes." } }, required: ["id"] },
      annotations: { destructiveHint: true },
      run: async (args) => {
        const n = noteById(args.id);
        removeNote(n.id);
        return { deleted: n.id, symbol: n.symbol };
      },
    },
  ];
}
