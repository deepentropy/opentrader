import { describe, expect, it, vi } from "vitest";

const kv = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("../../data/kv", () => ({
  getItem: (k: string) => kv.store.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.store.set(k, v),
  removeItem: (k: string) => void kv.store.delete(k),
  onExternalChange: () => () => undefined,
}));
vi.mock("../../data/datafeed", () => ({
  // ZZZZ is not a symbol.
  toFullSymbol: (s: string) => (s.endsWith("ZZZZ") ? Promise.reject(new Error("unknown")) : Promise.resolve(s.includes(":") ? s.toUpperCase() : `NASDAQ:${s.toUpperCase()}`)),
}));
const images = vi.hoisted(() => ({ saved: [] as string[], deleted: [] as string[] }));
vi.mock("../../bindings", () => ({
  commands: {
    saveNoteImage: (_b64: string, ext: string) => {
      images.saved.push(ext);
      return Promise.resolve({ status: "ok", data: `snap-${images.saved.length}.${ext}` });
    },
    deleteNoteImage: (name: string) => {
      images.deleted.push(name);
      return Promise.resolve({ status: "ok", data: null });
    },
  },
}));
const bridge = vi.hoisted(() => ({ on: true }));
vi.mock("../../data/community/chart-share", () => ({
  chartBridge: () => (bridge.on ? { capture: () => Promise.resolve({ chart: {}, image: new Blob(["x"], { type: "image/png" }) }) } : null),
}));

// The picture is read as a data URL (no DOM in the tests).
vi.stubGlobal(
  "FileReader",
  class {
    result = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL() {
      this.result = "data:image/png;base64,eA==";
      queueMicrotask(() => this.onload?.());
    }
  },
);

import { createNotesTools } from "../notes-tools";
import { allNotes } from "../../data/symbol-notes";

const tools = createNotesTools(() => "NYSE:IBM");
const run = (name: string, args: Record<string, unknown> = {}) => tools.find((t) => t.name === name)!.run(args) as Promise<Record<string, any>>;

describe("notes tools", () => {
  it("adds notes on the focused symbol or the one asked, with a picture when asked", async () => {
    const a = await run("add_note", { text: "Earnings gap held the 50-day." });
    expect(a).toMatchObject({ symbol: "NYSE:IBM", picture: false });
    const b = await run("add_note", { symbol: "aapl", text: "Watch 200 support", picture: true });
    expect(b).toMatchObject({ symbol: "NASDAQ:AAPL", picture: true });
    expect(images.saved).toEqual(["png"]);
    expect(allNotes()).toHaveLength(2);
  });

  it("refuses an empty text, an unknown symbol, and a picture with no chart", async () => {
    await expect(run("add_note", { text: "  " })).rejects.toThrow(/text/);
    await expect(run("add_note", { symbol: "ZZZZ", text: "x" })).rejects.toThrow(/Unknown symbol/);
    bridge.on = false;
    await expect(run("add_note", { text: "x", picture: true })).rejects.toThrow(/pictured/);
    bridge.on = true;
    expect(allNotes()).toHaveLength(2);
  });

  it("lists newest first, by symbol or by words, and reads one whole", async () => {
    await run("add_note", { symbol: "AAPL", text: `Long thesis: ${"services margin ".repeat(20)}` });
    const all = await run("list_notes");
    expect(all.total).toBe(3);
    expect(all.symbols).toBe(2);
    expect(all.notes[0].text.endsWith("…")).toBe(true);
    expect((await run("list_notes", { symbol: "AAPL" })).notes.map((n: any) => n.symbol)).toEqual(["NASDAQ:AAPL", "NASDAQ:AAPL"]);
    expect((await run("list_notes", { query: "SUPPORT watch" })).notes.map((n: any) => n.text)).toEqual(["Watch 200 support"]);
    const full = await run("read_note", { id: all.notes[0].id });
    expect(full.text).toBe(`Long thesis: ${"services margin ".repeat(20)}`.trim());
    expect(full.date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    await expect(run("read_note", { id: "nope" })).rejects.toThrow(/list_notes/);
  });

  it("deletes a note and its picture, after asking (destructive)", async () => {
    expect(tools.find((t) => t.name === "delete_note")!.annotations?.destructiveHint).toBe(true);
    const id = (await run("list_notes", { query: "support" })).notes[0].id;
    expect(await run("delete_note", { id })).toEqual({ deleted: id, symbol: "NASDAQ:AAPL" });
    expect(images.deleted).toEqual(["snap-1.png"]);
    expect(allNotes()).toHaveLength(2);
  });
});
