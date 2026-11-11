/*
 * Symbol notes (#301): notes the user writes about a symbol, each with its date and an optional chart snapshot. They
 * are read and written in the Details panel (a symbol's notes, all notes) and flagged on the watchlist rows. A note
 * also keeps the charts shown when it was written (layout, each chart's symbol, interval and time span): a click on
 * it puts them back.
 *
 * Notes are kept in kv (`ot:notes:v1`) and follow other windows' changes; a snapshot is an image file of the app
 * (`save_note_image`), the note keeps its file name only. A symbol's notes are keyed by its full name ("NASDAQ:AAPL").
 */
import { createSignal } from "solid-js";
import { commands } from "../bindings";
import * as kv from "./kv";
import { translateWith } from "../i18n/translator";
import { dateText } from "../i18n/format";

/** The charts of the tab when a note was written: its layout template, focused chart and each chart's symbol,
 *  interval and visible time span (UNIX seconds of the first and last visible bars). */
export type NoteView = {
  layout: string;
  activePane: number;
  panes: { symbol: string; interval: string; from?: number; to?: number }[];
};

export type SymbolNote = {
  id: string;
  /** Full symbol name ("NASDAQ:AAPL"). */
  symbol: string;
  content: string;
  /** UNIX ms. */
  created: number;
  modified: number;
  /** File name of its chart snapshot. */
  snapshot?: string;
  /** The charts shown when it was written. */
  view?: NoteView;
};

/** How the window reads and puts back its charts (registered by the app; none on the website). */
export type NotesChartHost = { view: () => NoteView | null; show: (view: NoteView) => void };
let chartHost: NotesChartHost | null = null;

export function setNotesChartHost(host: NotesChartHost | null): void {
  chartHost = host;
}

/** Shows the charts a note was written on. */
export function showNoteView(note: SymbolNote): boolean {
  if (!note.view || !chartHost) return false;
  chartHost.show(note.view);
  return true;
}

/** The notes of one symbol, for the all-notes list. */
export type NotesGroup = { symbol: string; notes: SymbolNote[]; modified: number };

const KEY = "ot:notes:v1";
/** One plain text per symbol, the Details panel's note before #301. */
const OLD_KEY = "ot:watchlist:notes:v1";

function parse(raw: string | null): SymbolNote[] {
  try {
    const v = raw ? (JSON.parse(raw) as { notes?: unknown }) : null;
    return Array.isArray(v?.notes) ? (v.notes as SymbolNote[]).filter((n) => n && typeof n.id === "string") : [];
  } catch {
    return [];
  }
}

/** The notes of the plain per-symbol texts kept before #301 (one note each, dated `now`). */
export function migratedNotes(old: Record<string, unknown>, now: number): SymbolNote[] {
  return Object.entries(old)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "")
    .map(([symbol, content], i) => ({ id: `n${now.toString(36)}-${i}`, symbol: symbol.toUpperCase(), content, created: now, modified: now }));
}

function load(): SymbolNote[] {
  const raw = kv.getItem(KEY);
  if (raw !== null) return parse(raw);
  let old: Record<string, unknown> = {};
  try {
    old = JSON.parse(kv.getItem(OLD_KEY) ?? "{}") as Record<string, unknown>;
  } catch {
    /* malformed: nothing to keep */
  }
  const notes = migratedNotes(old, Date.now());
  kv.setItem(KEY, JSON.stringify({ notes }));
  kv.removeItem(OLD_KEY);
  return notes;
}

const [notes, setNotesSignal] = createSignal<SymbolNote[]>(load());
kv.onExternalChange(KEY, (raw) => setNotesSignal(parse(raw)));

function save(next: SymbolNote[]): void {
  setNotesSignal(next);
  kv.setItem(KEY, JSON.stringify({ notes: next }));
}

/** Every note (reactive). */
export function allNotes(): SymbolNote[] {
  return notes();
}

/** A symbol's notes, the newest first (reactive). */
export function notesOf(symbol: string): SymbolNote[] {
  const key = symbol.toUpperCase();
  return notes()
    .filter((n) => n.symbol === key)
    .sort((a, b) => b.created - a.created);
}

/** The note of a symbol edited last (reactive). */
export function lastNoteOf(symbol: string): SymbolNote | undefined {
  const key = symbol.toUpperCase();
  let last: SymbolNote | undefined;
  for (const n of notes()) if (n.symbol === key && (!last || n.modified > last.modified)) last = n;
  return last;
}

/** The symbols with notes, the one edited last first. */
export function notesGroups(list: SymbolNote[]): NotesGroup[] {
  const groups = new Map<string, NotesGroup>();
  for (const n of list) {
    const g = groups.get(n.symbol) ?? { symbol: n.symbol, notes: [], modified: 0 };
    g.notes.push(n);
    g.modified = Math.max(g.modified, n.modified);
    groups.set(n.symbol, g);
  }
  return [...groups.values()].sort((a, b) => b.modified - a.modified);
}

let seq = 0;

/** A new note of `symbol`; it keeps the charts shown now. */
export function addNote(symbol: string, content: string, snapshot?: string): SymbolNote {
  const now = Date.now();
  const note: SymbolNote = { id: `n${now.toString(36)}-${(seq++).toString(36)}`, symbol: symbol.toUpperCase(), content, created: now, modified: now };
  if (snapshot) note.snapshot = snapshot;
  const view = chartHost?.view();
  if (view) note.view = view;
  save([...notes(), note]);
  return note;
}

/** A new text and snapshot for a note; a snapshot it no longer has is removed. */
export function editNote(id: string, content: string, snapshot?: string): void {
  const old = notes().find((n) => n.id === id);
  if (!old) return;
  const next: SymbolNote = { ...old, content, modified: Date.now() };
  if (snapshot) next.snapshot = snapshot;
  else delete next.snapshot;
  save(notes().map((n) => (n.id === id ? next : n)));
  if (old.snapshot && old.snapshot !== snapshot) dropSnapshot(old.snapshot);
}

export function removeNote(id: string): void {
  const old = notes().find((n) => n.id === id);
  if (!old) return;
  save(notes().filter((n) => n.id !== id));
  if (old.snapshot) dropSnapshot(old.snapshot);
}

/** Remove a snapshot file no note uses any more (files are named by content: two notes can share one). */
function dropSnapshot(name: string): void {
  if (notes().some((n) => n.snapshot === name)) return;
  snapshotUrls.delete(name);
  void commands.deleteNoteImage(name);
}

/** "Today, 14:05", "Yesterday, 14:05" or the date and time of a note. */
export function noteDateText(ms: number, now = Date.now()): string {
  const time = dateText(ms, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const day = (t: number) => new Date(t).toDateString();
  if (day(ms) === day(now)) return translateWith("Today, {0}", time);
  if (day(ms) === day(now - 86_400_000)) return translateWith("Yesterday, {0}", time);
  return dateText(ms, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

// ── Snapshots ──

/** Store a chart picture; its file name. */
export async function saveSnapshot(image: Blob): Promise<string> {
  const base64 = await blobBase64(image);
  const r = await commands.saveNoteImage(base64, image.type === "image/jpeg" ? "jpg" : "png");
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

const snapshotUrls = new Map<string, Promise<string>>();

/** A snapshot as a data URL, read once per run. */
export function snapshotUrl(name: string): Promise<string> {
  let p = snapshotUrls.get(name);
  if (!p) {
    p = commands.readNoteImage(name).then((r) => {
      if (r.status === "error") throw new Error(r.error);
      return `data:image/${name.endsWith(".png") ? "png" : "jpeg"};base64,${r.data}`;
    });
    p.catch(() => snapshotUrls.delete(name));
    snapshotUrls.set(name, p);
  }
  return p;
}

/** Show a snapshot at full size, as the chart's "Open image in new tab". */
export async function openSnapshot(name: string): Promise<void> {
  const url = await snapshotUrl(name);
  await commands.openSnapshot(url.split(",")[1] ?? "");
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
