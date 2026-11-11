import { describe, expect, it, vi } from "vitest";

// The notes kept before #301: one plain text per symbol, migrated on first load.
const mocks = vi.hoisted(() => ({
  kv: new Map<string, string>([["ot:watchlist:notes:v1", JSON.stringify({ "NASDAQ:AAPL": "watch earnings", MSFT: "  ", "nyse:ibm": "old" })]]),
  deleted: [] as string[],
}));

vi.mock("../kv", () => ({
  getItem: (k: string) => mocks.kv.get(k) ?? null,
  setItem: (k: string, v: string) => void mocks.kv.set(k, v),
  removeItem: (k: string) => void mocks.kv.delete(k),
  onExternalChange: () => () => undefined,
}));
vi.mock("../../bindings", () => ({
  commands: {
    deleteNoteImage: vi.fn(async (name: string) => {
      mocks.deleted.push(name);
      return { status: "ok", data: null };
    }),
  },
}));

import { addNote, allNotes, editNote, lastNoteOf, migratedNotes, noteDateText, notesGroups, notesOf, removeNote, setNotesChartHost, showNoteView, type NoteView } from "../symbol-notes";

describe("symbol notes (#301)", () => {
  it("migrates the plain per-symbol notes, skipping empty ones", () => {
    expect(mocks.kv.has("ot:watchlist:notes:v1")).toBe(false);
    expect(allNotes().map((n) => [n.symbol, n.content])).toEqual([
      ["NASDAQ:AAPL", "watch earnings"],
      ["NYSE:IBM", "old"],
    ]);
    expect(JSON.parse(mocks.kv.get("ot:notes:v1")!).notes).toHaveLength(2);
    expect(migratedNotes({ A: 1, B: "x" }, 5)).toEqual([{ id: "n5-0", symbol: "B", content: "x", created: 5, modified: 5 }]);
  });

  it("adds, edits and removes notes; a snapshot no note uses is deleted", async () => {
    const a = addNote("nasdaq:aapl", "first", "0123456789abcdef.png");
    await new Promise((r) => setTimeout(r, 2));
    const b = addNote("NASDAQ:AAPL", "second");
    expect(notesOf("NASDAQ:AAPL").map((n) => n.content)).toEqual(["second", "first", "watch earnings"]);

    editNote(a.id, "first, edited");
    expect(notesOf("NASDAQ:AAPL").find((n) => n.id === a.id)).toMatchObject({ content: "first, edited" });
    expect(notesOf("NASDAQ:AAPL").find((n) => n.id === a.id)?.snapshot).toBeUndefined();
    expect(mocks.deleted).toEqual(["0123456789abcdef.png"]);
    expect(lastNoteOf("NASDAQ:AAPL")?.id).toBe(a.id);

    removeNote(b.id);
    expect(notesOf("NASDAQ:AAPL")).toHaveLength(2);
    expect(JSON.parse(mocks.kv.get("ot:notes:v1")!).notes).toHaveLength(3);
  });

  it("lists the symbols with notes, the one edited last first", () => {
    const n = (symbol: string, modified: number) => ({ id: `${symbol}${modified}`, symbol, content: "", created: modified, modified });
    const groups = notesGroups([n("A", 1), n("B", 5), n("A", 3)]);
    expect(groups.map((g) => [g.symbol, g.notes.length, g.modified])).toEqual([
      ["B", 1, 5],
      ["A", 2, 3],
    ]);
  });

  it("dates a note today, yesterday or by its date", () => {
    const now = new Date(2026, 10, 11, 15, 0).getTime();
    expect(noteDateText(new Date(2026, 10, 11, 9, 5).getTime(), now)).toBe("Today, 09:05");
    expect(noteDateText(new Date(2026, 10, 10, 23, 59).getTime(), now)).toBe("Yesterday, 23:59");
    expect(noteDateText(new Date(2026, 9, 2, 8, 30).getTime(), now)).toBe("Oct 2, 2026, 08:30");
  });

  it("keeps the charts shown when a note is written and puts them back", () => {
    const view: NoteView = { layout: "2h", activePane: 1, panes: [{ symbol: "AMEX:SPY", interval: "1D", from: 1, to: 2 }, { symbol: "NASDAQ:AAPL", interval: "15" }] };
    const shown: NoteView[] = [];
    setNotesChartHost({ view: () => view, show: (v) => shown.push(v) });
    const n = addNote("AMEX:SPY", "with charts");
    expect(n.view).toEqual(view);
    expect(showNoteView(n)).toBe(true);
    expect(shown).toEqual([view]);
    // A note written before notes kept charts: nothing to show.
    expect(showNoteView({ ...n, view: undefined })).toBe(false);
    setNotesChartHost(null);
    expect(showNoteView(n)).toBe(false);
  });
});
