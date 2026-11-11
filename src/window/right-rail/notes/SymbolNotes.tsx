/*
 * Symbol notes in the Details panel (#301): the notes of the shown symbol (newest first, each with its date, Edit and
 * Remove, an optional chart snapshot) above a box to write one, the list of all notes by symbol, and the "Notes" card
 * of the details. The pages take the place of the details while they are open (WatchlistDetail).
 */
import { createEffect, createResource, createSignal, For, on, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { openUrl } from "@tauri-apps/plugin-opener";
import { chartBridge } from "../../../data/community/chart-share";
import {
  addNote,
  allNotes,
  editNote,
  lastNoteOf,
  notesGroups,
  notesOf,
  noteDateText,
  openSnapshot,
  removeNote,
  saveSnapshot,
  showNoteView,
  snapshotUrl,
  type SymbolNote,
} from "../../../data/symbol-notes";
import { ChartContextMenu, type CtxNode } from "../../chart/ChartContextMenu";
import { translateWith } from "../../../i18n/translator";

/** Short name of a full symbol ("NASDAQ:AAPL" → "AAPL"). */
export function shortSymbol(symbol: string): string {
  return symbol.split(":").pop() ?? symbol;
}

const BACK_ICON = (
  <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
    <path fill="currentColor" d="M16.85 7.65 10.5 14l6.35 6.35-.7.7L9.09 14l7.06-7.05.7.7Z" />
  </svg>
);
const LIST_ICON = (
  <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
    <path fill="currentColor" d="M8 8h2v2H8V8Zm4 .5h9v1h-9v-1ZM8 13h2v2H8v-2Zm4 .5h9v1h-9v-1ZM8 18h2v2H8v-2Zm4 .5h9v1h-9v-1Z" />
  </svg>
);
const CAMERA_ICON = (
  <svg viewBox="0 0 28 28" width="24" height="24" aria-hidden="true">
    <path fill="currentColor" d="M11.12 6h5.76l1.5 2.5H22A1.5 1.5 0 0 1 23.5 10v10a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20V10A1.5 1.5 0 0 1 6 8.5h3.62l1.5-2.5Zm.57 1-1.5 2.5H6a.5.5 0 0 0-.5.5v10c0 .28.22.5.5.5h16a.5.5 0 0 0 .5-.5V10a.5.5 0 0 0-.5-.5h-4.19l-1.5-2.5h-4.62ZM14 12a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm-4 3a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" />
  </svg>
);
const EDIT_ICON = (
  <svg viewBox="0 0 28 28" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M19.59 5.7a2 2 0 0 1 2.82 0l.89.89a2 2 0 0 1 0 2.82L10.7 22H6v-4.7L19.59 5.7Zm2.12.71a1 1 0 0 0-1.42 0L18.7 8 20 9.3l1.59-1.59a1 1 0 0 0 0-1.42l-.88-.88ZM19.3 10 18 8.7 7 19.7V21h1.3l11-11Z" />
  </svg>
);
const REMOVE_ICON = (
  <svg viewBox="0 0 28 28" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M12 5h4v1h-4V5Zm-5 3h14v1h-1.03l-.84 12.6A1.5 1.5 0 0 1 17.63 23h-7.26a1.5 1.5 0 0 1-1.5-1.4L8.03 9H7V8Zm2.03 1 .84 12.53a.5.5 0 0 0 .5.47h7.26a.5.5 0 0 0 .5-.47L17.97 9H9.03ZM12 11v9h-1v-9h1Zm5 0v9h-1v-9h1Z" />
  </svg>
);
const CLOSE_ICON = (
  <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true">
    <path fill="currentColor" d="M4.35 3.65 9 8.29l4.65-4.64.7.7L9.71 9l4.64 4.65-.7.7L9 9.71l-4.65 4.64-.7-.7L8.29 9 3.65 4.35l.7-.7Z" />
  </svg>
);
const NOTE_ICON = (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M4 3.5A1.5 1.5 0 0 1 5.5 2h7A1.5 1.5 0 0 1 14 3.5v8.7L10.2 16H5.5A1.5 1.5 0 0 1 4 14.5v-11ZM5.5 3a.5.5 0 0 0-.5.5v11c0 .28.22.5.5.5H9.5v-2.5A1.5 1.5 0 0 1 11 11h2V3.5a.5.5 0 0 0-.5-.5h-7Zm7.3 9H11a.5.5 0 0 0-.5.5v1.8l2.3-2.3ZM6.5 6h5v1h-5V6Zm0 2.5h5v1h-5v-1Z" />
  </svg>
);
const EMPTY_ICON = (
  <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.5" d="M18 8.75h20.5l9.75 9.75v35.25a2 2 0 0 1-2 2H18a2 2 0 0 1-2-2v-43a2 2 0 0 1 2-2ZM38.25 9v9.5h9.75M22 27h20M22 34h20M22 41h12" />
  </svg>
);

/** A symbol's letter in a circle, as the watchlist rows show it; its logo when known. */
function SymbolLogo(props: { symbol: string; url?: string | null }) {
  return (
    <Show when={props.url} fallback={<span class="ot-ticker-logo ot-ticker-logo--sm notes-logo" aria-hidden="true">{shortSymbol(props.symbol).charAt(0)}</span>}>
      {(url) => <img class="notes-logo-img" src={url()} alt="" width="20" height="20" loading="lazy" />}
    </Show>
  );
}

/** Header of a notes page: back, the title, an action at the end. */
function NotesHeader(props: { title: string; logo?: JSX.Element; onBack: () => void; end?: JSX.Element; name: string }) {
  return (
    <header class="notes-header" data-name={props.name}>
      <button type="button" class="notes-icon-btn notes-back ot-flip-rtl" aria-label="Back" title="Back" onClick={() => props.onBack()}>
        {BACK_ICON}
      </button>
      {props.logo}
      <span class="notes-header-title">{props.title}</span>
      {props.end}
    </header>
  );
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** A note's text, its web addresses as links opened in the browser. */
function NoteText(props: { text: string }) {
  const parts = () => {
    const out: (string | { href: string })[] = [];
    let at = 0;
    for (const m of props.text.matchAll(URL_RE)) {
      if (m.index! > at) out.push(props.text.slice(at, m.index));
      out.push({ href: m[0] });
      at = m.index! + m[0].length;
    }
    if (at < props.text.length) out.push(props.text.slice(at));
    return out;
  };
  return (
    <div class="notes-item-text" data-no-translate>
      <For each={parts()}>
        {(p) =>
          typeof p === "string" ? (
            p
          ) : (
            <a href={p.href} onClick={(e) => { e.preventDefault(); e.stopPropagation(); void openUrl(p.href); }}>
              {p.href}
            </a>
          )
        }
      </For>
    </div>
  );
}

/** A chart snapshot's picture; a click shows it at full size. */
function SnapshotImage(props: { name: string; class: string }) {
  const [url] = createResource(() => props.name, snapshotUrl);
  return (
    <Show when={url()}>
      {(u) => (
        <button type="button" class={props.class} title="Chart preview" onClick={(e) => { e.stopPropagation(); void openSnapshot(props.name); }}>
          <img src={u()} alt="Chart preview" />
        </button>
      )}
    </Show>
  );
}

/** What the box at the bottom of a symbol's notes holds: a note being written or edited. */
type Draft = { editing: string | null; text: string; snapshot: Blob | string | null };

/** The notes of `symbol` and the box to write one. `compose` (a changing number): put the cursor in the box. */
export function SymbolNotesPage(props: {
  symbol: string;
  logoUrl?: string | null;
  compose: number;
  /** The box to write a note opened. */
  onWriting?: () => void;
  onBack: () => void;
  onAllNotes: () => void;
}) {
  const [draft, setDraft] = createSignal<Draft>({ editing: null, text: "", snapshot: null });
  const [focused, setFocused] = createSignal(false);
  const [taking, setTaking] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [menu, setMenu] = createSignal<{ x: number; y: number; note: SymbolNote } | null>(null);
  let input!: HTMLTextAreaElement;
  let list!: HTMLDivElement;
  /** Where the last press began: the box grows when it takes the cursor, so the press that opened it can end on
   *  Cancel or Add, which then must not act. */
  let pressedOn: EventTarget | null = null;
  const pressedHere = (e: MouseEvent) => e.detail === 0 || (e.currentTarget as Node).contains(pressedOn as Node);
  const notes = () => notesOf(props.symbol);

  const reset = () => {
    setDraft({ editing: null, text: "", snapshot: null });
    setFocused(false);
    setTaking(false);
    input?.blur();
  };
  // Another symbol: its own notes and an empty box.
  createEffect(on(() => props.symbol, reset, { defer: true }));
  createEffect(on(() => props.compose, () => queueMicrotask(() => input?.focus())));

  const startEdit = (n: SymbolNote) => {
    setDraft({ editing: n.id, text: n.content, snapshot: n.snapshot ?? null });
    input.focus();
    input.selectionStart = input.selectionEnd = n.content.length;
  };
  const remove = (n: SymbolNote) => {
    if (draft().editing === n.id) reset();
    removeNote(n.id);
  };
  const takeSnapshot = async () => {
    input.focus();
    setTaking(true);
    try {
      const c = await chartBridge()?.capture();
      if (c) setDraft((d) => ({ ...d, snapshot: c.image }));
    } finally {
      setTaking(false);
    }
  };
  const submit = async () => {
    const d = draft();
    if (!d.text.trim() || saving()) return;
    setSaving(true);
    try {
      const snapshot = d.snapshot instanceof Blob ? await saveSnapshot(d.snapshot) : (d.snapshot ?? undefined);
      if (d.editing) editNote(d.editing, d.text, snapshot);
      else {
        addNote(props.symbol, d.text, snapshot);
        list.scrollTop = 0;
      }
      reset();
    } catch (e) {
      console.warn("[notes] not saved", e);
    } finally {
      setSaving(false);
    }
  };
  const [draftUrl] = createResource(
    () => draft().snapshot,
    (s) => (s instanceof Blob ? Promise.resolve(URL.createObjectURL(s)) : snapshotUrl(s)),
  );
  const menuNodes = (n: SymbolNote): CtxNode[] => [
    { kind: "item", id: "edit", label: "Edit", icon: EDIT_ICON, onSelect: () => startEdit(n) },
    { kind: "item", id: "remove", label: "Remove", icon: REMOVE_ICON, onSelect: () => remove(n) },
  ];

  return (
    <div class="notes-page" data-name="details-symbol-notes-content">
      <NotesHeader
        name="details-symbol-notes-header"
        title={translateWith("{0} notes", shortSymbol(props.symbol))}
        logo={<SymbolLogo symbol={props.symbol} url={props.logoUrl} />}
        onBack={props.onBack}
        end={
          <button type="button" class="notes-icon-btn notes-header-end" aria-label="All notes" title="All notes" data-name="details-all-notes-button" onClick={() => props.onAllNotes()}>
            {LIST_ICON}
          </button>
        }
      />
      <div class="notes-items" classList={{ "is-empty": notes().length === 0 }} ref={list}>
        <Show
          when={notes().length > 0}
          fallback={
            <div class="notes-empty">
              {EMPTY_ICON}
              <span>Write your first note</span>
            </div>
          }
        >
          <For each={notes()}>
            {(n) => (
              <div
                class="notes-item"
                classList={{ "is-editing": draft().editing === n.id || menu()?.note.id === n.id, "has-view": !!n.view }}
                title={n.view ? "Show the charts as they were" : undefined}
                onClick={(e) => {
                  // Not a press on its buttons or links, nor the end of a text selection.
                  if ((e.target as Element).closest("button, a") || window.getSelection()?.toString()) return;
                  showNoteView(n);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, note: n });
                }}
              >
                <Show when={n.snapshot}>{(s) => <SnapshotImage name={s()} class="notes-item-snapshot" />}</Show>
                <NoteText text={n.content} />
                <div class="notes-item-info">
                  <span class="notes-item-date">{noteDateText(n.created)}</span>
                  <div class="notes-item-actions">
                    <button type="button" class="notes-icon-btn" title="Edit" aria-label="Edit" data-name="details-edit-note" onClick={() => startEdit(n)}>
                      {EDIT_ICON}
                    </button>
                    <button type="button" class="notes-icon-btn" title="Remove" aria-label="Remove" data-name="details-remove-note" onClick={() => remove(n)}>
                      {REMOVE_ICON}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
      <form
        onPointerDown={(e) => (pressedOn = e.target)}
        class="notes-composer"
        classList={{ "is-open": focused() }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div class="notes-input-box">
          <textarea
            ref={input}
            class="notes-input"
            rows={focused() ? 4 : 1}
            placeholder="Type something"
            value={draft().text}
            onInput={(e) => setDraft((d) => ({ ...d, text: e.currentTarget.value }))}
            onFocus={() => {
              setFocused(true);
              props.onWriting?.();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                reset();
              }
            }}
          />
          <div class="notes-input-tools">
            <Show when={draft().snapshot && draftUrl()}>
              {(u) => (
                <div class="notes-draft-snapshot">
                  <img src={u()} alt="Chart preview" />
                  <button
                    type="button"
                    class="notes-draft-remove"
                    title="Remove snapshot"
                    aria-label="Remove snapshot"
                    data-name="remove-chart-snapshot"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setDraft((d) => ({ ...d, snapshot: null }))}
                  >
                    {CLOSE_ICON}
                  </button>
                </div>
              )}
            </Show>
            <Show when={chartBridge()}>
              <button
                type="button"
                class="notes-icon-btn notes-snapshot-btn"
                classList={{ "is-busy": taking() }}
                disabled={!!draft().snapshot || taking()}
                title={draft().snapshot || taking() ? undefined : "Attach chart snapshot"}
                aria-label="Attach chart snapshot"
                data-name="attach-chart-snapshot"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void takeSnapshot()}
              >
                {CAMERA_ICON}
              </button>
            </Show>
          </div>
        </div>
        <Show when={focused()}>
          <div class="notes-composer-actions">
            <button type="button" class="ot-dlg-btn is-secondary notes-btn" onClick={(e) => pressedHere(e) && reset()}>
              Cancel
            </button>
            <button
              type="submit"
              class="ot-dlg-btn is-neutral notes-btn"
              disabled={!draft().text.trim() || taking() || saving()}
              onClick={(e) => {
                if (!pressedHere(e)) e.preventDefault();
              }}
            >
              {draft().editing ? "Save" : "Add"}
            </button>
          </div>
        </Show>
      </form>
      <Show when={menu()}>
        {(m) => (
          <Portal>
            <ChartContextMenu x={m().x} y={m().y} nodes={menuNodes(m().note)} onClose={() => setMenu(null)} />
          </Portal>
        )}
      </Show>
    </div>
  );
}

/** Every symbol with notes, the one edited last first; a click opens its notes. */
export function AllNotesPage(props: { onBack: () => void; onOpen: (symbol: string) => void }) {
  const groups = () => notesGroups(allNotes());
  return (
    <div class="notes-page" data-name="details-all-notes-content">
      <NotesHeader name="details-all-notes-header" title="All notes" onBack={props.onBack} />
      <div class="notes-items notes-groups" classList={{ "is-empty": groups().length === 0 }}>
        <Show
          when={groups().length > 0}
          fallback={
            <div class="notes-empty">
              {EMPTY_ICON}
              <span>Hmmm, seems that you don't have any notes at the moment</span>
            </div>
          }
        >
          <For each={groups()}>
            {(g) => {
              const last = () => g.notes.reduce((a, b) => (b.modified > a.modified ? b : a));
              return (
                <button type="button" class="notes-group" onClick={() => props.onOpen(g.symbol)}>
                  <span class="notes-group-head">
                    <SymbolLogo symbol={g.symbol} />
                    <span class="notes-group-title" data-no-translate>{shortSymbol(g.symbol)}</span>
                  </span>
                  <span class="notes-group-text" classList={{ "is-empty": !last().content.trim() }}>
                    {last().content.trim() ? <span data-no-translate>{last().content}</span> : "Empty note"}
                  </span>
                  <span class="notes-group-date">{translateWith("Last edited {0}", noteDateText(g.modified))}</span>
                </button>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}

/** The "Notes" card of the details: the symbol's last edited note; a click opens its notes. */
export function NotesCard(props: { symbol: string; onOpen: () => void }) {
  return (
    <Show when={lastNoteOf(props.symbol)}>
      {(n) => (
        <button type="button" class="notes-card" data-name="details-note" onClick={() => props.onOpen()}>
          <span class="notes-card-title">
            {NOTE_ICON}
            <span>Notes</span>
          </span>
          <span class="notes-card-text">{n().content.trim() ? <span data-no-translate>{n().content}</span> : "Empty note"}</span>
          <span class="notes-card-footer">Open notes</span>
        </button>
      )}
    </Show>
  );
}

/** The watchlist row's mark of a symbol with notes: its last note in the tooltip; a click opens its notes. */
export function NotesMark(props: { symbol: string; onOpen: () => void }) {
  return (
    <Show when={lastNoteOf(props.symbol)}>
      {(n) => (
        <span
          class="watchlist-notes-mark"
          role="button"
          title={n().content}
          aria-label="Open notes"
          onClick={(e) => {
            e.stopPropagation();
            props.onOpen();
          }}
        >
          {NOTE_ICON}
        </span>
      )}
    </Show>
  );
}
