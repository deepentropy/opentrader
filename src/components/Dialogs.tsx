/*
 * Prompt dialogs — `showRename` (a name field with the list of existing
 * names) and `showConfirm`: 480 px wide, #1F1F1F, r6, padding 40,
 * title 20/600, centred in the window, no dimming behind.
 * Used by the drawing / chart / indicator template menus.
 *
 * Imperative API (showRename / showConfirm): call from anywhere; the
 * <DialogHost/> mounted once in App renders the open dialogs, newest on top.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

export type ConfirmOptions = {
  /** Title (default "Confirmation"). */
  title?: string;
  text: string;
  /** Main button (default "Yes"). */
  mainText?: string;
  /** Other button (default "No"). */
  cancelText?: string;
  /** Main button colour: success = #089981 (default), danger = #F23645. */
  intent?: "success" | "danger";
  onConfirm: () => void;
  onCancel?: () => void;
};

export type RenameOptions = {
  title: string;
  /** Label above the field. */
  label: string;
  maxLength: number;
  /** Existing names: the field's drop-down list, and the "replace?" check. */
  names: string[];
  /** Confirm text when the typed name already exists (Yes = replace). */
  replaceText: (name: string) => string;
  /** Text the field opens with (selected). */
  initialValue?: string;
  /** Main button text (default "Save"). */
  saveText?: string;
  onSave: (name: string) => void;
};

/** Message with no buttons: icon + title header, text, close button.
 *  A click outside does not close it. */
export type NoticeOptions = {
  title: string;
  text: string;
  /** SVG path data stroked in a 36 x 36 box left of the title. */
  iconPath?: string;
  onClose?: () => void;
};

type Entry =
  | { id: number; kind: "confirm"; opts: ConfirmOptions }
  | { id: number; kind: "rename"; opts: RenameOptions }
  | { id: number; kind: "notice"; opts: NoticeOptions };

const [stack, setStack] = createSignal<Entry[]>([]);
let nextId = 1;
const close = (id: number) => setStack((s) => s.filter((e) => e.id !== id));

export function showConfirm(opts: ConfirmOptions): void {
  setStack((s) => [...s, { id: nextId++, kind: "confirm", opts }]);
}

export function showRename(opts: RenameOptions): void {
  setStack((s) => [...s, { id: nextId++, kind: "rename", opts }]);
}

/** Opens a notice; returns a function that closes it. */
export function showNotice(opts: NoticeOptions): () => void {
  const id = nextId++;
  setStack((s) => [...s, { id, kind: "notice", opts }]);
  return () => {
    if (stack().some((e) => e.id === id)) { close(id); opts.onClose?.(); }
  };
}

/** Case-insensitive "contains" filter. */
const matches = (typed: string, name: string) => typed === "" || name.toLowerCase().includes(typed.toLowerCase());

const CloseIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
  </svg>
);

function Frame(props: { title: string; onClose: () => void; children: import("solid-js").JSX.Element; label: string; iconPath?: string }) {
  return (
    <div class="ot-dlg-layer" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <div class="ot-dlg" role="dialog" aria-label={props.label}>
        <div class="ot-dlg-title">
          <Show when={props.iconPath}>
            <svg class="ot-dlg-title-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" d={props.iconPath} />
            </svg>
          </Show>
          {props.title}
        </div>
        <button type="button" class="ot-dlg-close" aria-label="close" onClick={() => props.onClose()}>
          <CloseIcon />
        </button>
        {props.children}
      </div>
    </div>
  );
}

function ConfirmDialog(props: { entry: Extract<Entry, { kind: "confirm" }> }) {
  const o = props.entry.opts;
  const cancel = () => { close(props.entry.id); o.onCancel?.(); };
  const confirm = () => { close(props.entry.id); o.onConfirm(); };
  useKeys(props.entry.id, cancel, confirm);
  return (
    <Frame title={o.title ?? "Confirmation"} label={o.title ?? "Confirmation"} onClose={cancel}>
      <div class="ot-dlg-content ot-dlg-text">{o.text}</div>
      <div class="ot-dlg-footer">
        <button type="button" class="ot-dlg-btn is-secondary" onClick={cancel}>{o.cancelText ?? "No"}</button>
        <button type="button" class={`ot-dlg-btn is-main is-${o.intent ?? "success"}`} data-name="submit-button" onClick={confirm}>
          {o.mainText ?? "Yes"}
        </button>
      </div>
    </Frame>
  );
}

function RenameDialog(props: { entry: Extract<Entry, { kind: "rename" }> }) {
  const o = props.entry.opts;
  const [value, setValue] = createSignal(o.initialValue ?? "");
  const [listOpen, setListOpen] = createSignal(false);
  let input!: HTMLInputElement;
  const name = () => value().trim();
  const shown = createMemo(() => o.names.filter((n) => matches(value(), n)));
  const cancel = () => close(props.entry.id);
  const save = () => {
    const n = name();
    if (!n) return;
    if (o.names.includes(n)) {
      showConfirm({ text: o.replaceText(n), onConfirm: () => { o.onSave(n); close(props.entry.id); }, onCancel: () => input.focus() });
      return;
    }
    o.onSave(n);
    close(props.entry.id);
  };
  useKeys(props.entry.id, () => (listOpen() ? setListOpen(false) : cancel()), save);
  onMount(() => { input.focus(); input.select(); });
  return (
    <Frame title={o.title} label={o.title} onClose={cancel}>
      <div class="ot-dlg-content">
        <label class="ot-dlg-label" for={`ot-dlg-input-${props.entry.id}`}>{o.label}</label>
        <div class="ot-dlg-field">
          <span class="ot-dlg-input-box">
            <input
              ref={input}
              id={`ot-dlg-input-${props.entry.id}`}
              class="ot-dlg-input"
              type="text"
              maxLength={o.maxLength}
              value={value()}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => { setValue(e.currentTarget.value); setListOpen(shown().length > 0 && e.currentTarget.value !== ""); }}
            />
            <Show when={o.names.length > 0}>
              <button type="button" class={`ot-dlg-list-btn${listOpen() ? " is-open" : ""}`} aria-label="Show names" tabIndex={-1} onClick={() => { setListOpen(!listOpen()); input.focus(); }}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                  <path fill="currentColor" d="M3.92 7.83 9 12.29l5.08-4.46-1-1.13L9 10.29l-4.09-3.6-.99 1.14Z" />
                </svg>
              </button>
            </Show>
          </span>
          <Show when={listOpen() && shown().length > 0}>
            <div class="ot-dlg-suggestions" role="listbox">
              <For each={shown()}>
                {(n) => (
                  <div role="option" class="ot-dlg-suggestion" onMouseDown={(e) => e.preventDefault()} onClick={() => { setValue(n); setListOpen(false); input.focus(); }}>
                    {n}
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
      <div class="ot-dlg-footer">
        <button type="button" class="ot-dlg-btn is-secondary" onClick={cancel}>Cancel</button>
        <button type="button" class="ot-dlg-btn is-main is-neutral" data-name="submit-button" aria-disabled={!name()} disabled={!name()} onClick={save}>
          {o.saveText ?? "Save"}
        </button>
      </div>
    </Frame>
  );
}

function NoticeDialog(props: { entry: Extract<Entry, { kind: "notice" }> }) {
  const o = props.entry.opts;
  const dismiss = () => { close(props.entry.id); o.onClose?.(); };
  useKeys(props.entry.id, dismiss, dismiss);
  return (
    <Frame title={o.title} label={o.title} iconPath={o.iconPath} onClose={dismiss}>
      <div class="ot-dlg-content ot-dlg-text">{o.text}</div>
    </Frame>
  );
}

/** Escape / Enter for the TOP dialog only. */
function useKeys(id: number, onEscape: () => void, onEnter: () => void) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = stack();
      if (!s.length || s[s.length - 1].id !== id) return;
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onEscape(); }
      else if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); onEnter(); }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
}

export function DialogHost() {
  return (
    <Portal mount={document.body}>
      <For each={stack()}>
        {(e) =>
          e.kind === "confirm" ? <ConfirmDialog entry={e} /> : e.kind === "rename" ? <RenameDialog entry={e} /> : <NoticeDialog entry={e} />
        }
      </For>
    </Portal>
  );
}
