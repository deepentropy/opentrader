/*
 * Floating-toolbar popovers — the color palette, line-width, line-style and
 * templates dropdowns that open from the per-drawing SelectedToolbar. Solid
 * port of the reference mock's DrawingStylePopovers; they replace the earlier
 * OS `<input type=color>` + click-to-cycle stand-ins with dedicated widgets.
 *
 * Each renders inside the toolbar (whose root stops pointerdown), so an outside
 * click — handled by the toolbar — closes them.
 */
import { createSignal, For, Show } from "solid-js";
import type { DrawingStyle, LineStyle } from "lightweight-charts-drawing/core/types";
import { ColorPanel } from "./ColorPanel";
import { deleteTemplate, loadTemplates, saveTemplate, type DrawingTemplate } from "./templates";
import { showConfirm, showRename } from "../../components/Dialogs";

export function ColorPopover(props: { value: string; onChange: (c: string) => void; onClose: () => void }) {
  return (
    <div class="dt-popover dt-color-popover" role="dialog" aria-label="Color" data-name="line-tool-color-menu">
      <ColorPanel value={props.value} onChange={props.onChange} onPicked={props.onClose} />
    </div>
  );
}

const WIDTHS = [1, 2, 3, 4] as const;
/** Highlighter widths of the floating toolbar (rows without a preview). */
export const HIGHLIGHTER_WIDTHS = [8, 12, 20, 32, 48, 64, 80, 96] as const;
export function WidthPopover(props: { value: number; onPick: (w: number) => void; options?: readonly number[] }) {
  return (
    <div class="dt-popover dt-width-popover" role="menu" aria-label="Line tool width" data-name="line-tool-width-menu">
      <For each={props.options ?? WIDTHS}>
        {(w) => (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={props.value === w}
            class={`dt-menu-row${props.value === w ? " selected" : ""}`}
            onClick={() => props.onPick(w)}
          >
            <Show when={!props.options}>
              <span class="dt-menu-preview">
                <svg viewBox={`0 0 18 ${w}`} width={18} height={w}><rect width={18} height={w} rx={w / 2} fill="currentColor" /></svg>
              </span>
            </Show>
            <span class="dt-menu-label">{w}px</span>
          </button>
        )}
      </For>
    </div>
  );
}

const STYLES: ReadonlyArray<readonly [LineStyle, string]> = [
  ["solid", "Line"], ["dashed", "Dashed line"], ["dotted", "Dotted line"],
];
export function StylePopover(props: { value: LineStyle; onPick: (s: LineStyle) => void }) {
  return (
    <div class="dt-popover dt-style-popover" role="menu" aria-label="Line tool style" data-name="line-tool-style-menu">
      <For each={STYLES}>
        {([id, label]) => {
          const dash = id === "dashed" ? "6 4" : id === "dotted" ? "2 3" : undefined;
          return (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={props.value === id}
              class={`dt-menu-row${props.value === id ? " selected" : ""}`}
              onClick={() => props.onPick(id)}
            >
              <span class="dt-menu-preview">
                <svg width={28} height={12} fill="none">
                  <path d="M2 6h24" stroke="currentColor" stroke-width={2} stroke-linecap="round" stroke-dasharray={dash} />
                </svg>
              </span>
              <span class="dt-menu-label">{label}</span>
            </button>
          );
        }}
      </For>
    </div>
  );
}

/** Drawing templates menu:
 *  - "toolbar" (floating toolbar): "Save Drawing Template As…"
 *    (one finished drawing only), "Apply Default Drawing Template", then the
 *    tool's templates with a remove cross on hover; remove asks "Delete this
 *    template?" (Delete / Cancel).
 *  - "dialog" (drawing Settings footer "Template"): "Save as…",
 *    "Apply defaults", then the templates with a remove trash on hover; remove
 *    asks "Do you really want to delete drawing template 'X' ?" (Yes / No).
 *  Save opens the "Save drawing template" name dialog (64 chars, list of the
 *  tool's names, replace confirmation). "Apply defaults" = factory style. */
export function TemplatesMenu(props: {
  variant: "toolbar" | "dialog";
  /** Tool whose templates are listed (templates are per tool). */
  kind: string;
  /** Style + text to save; undefined hides Save (one finished drawing only). */
  getTemplate?: () => { style: DrawingStyle; text?: string };
  onApply: (tpl: DrawingTemplate) => void;
  onApplyDefault: () => void;
  onClose: () => void;
}) {
  const [list, setList] = createSignal<DrawingTemplate[]>(loadTemplates(props.kind));
  const toolbar = () => props.variant === "toolbar";
  const saveAs = () => {
    const get = props.getTemplate;
    if (!get) return;
    // Snapshot now: the drawing's component may be gone when the name is
    // confirmed (the template is saved from the drawing the menu opened on).
    const snapshot = get();
    const kind = props.kind;
    props.onClose();
    showRename({
      title: "Save drawing template",
      label: "New template name",
      maxLength: 64,
      names: loadTemplates(kind).map((t) => t.name),
      replaceText: (n) => `Drawing template "${n}" already exists. Do you really want to replace it?`,
      onSave: (n) => { saveTemplate(kind, { name: n, ...snapshot }); },
    });
  };
  const remove = (name: string) => {
    const kind = props.kind;
    const done = () => setList(deleteTemplate(kind, name));
    if (toolbar()) {
      showConfirm({
        title: "Delete this template?",
        text: `Doing this will permanently delete your "${name}" drawing template.`,
        mainText: "Delete",
        cancelText: "Cancel",
        intent: "danger",
        onConfirm: done,
      });
    } else {
      showConfirm({ text: `Do you really want to delete drawing template '${name}' ?`, onConfirm: done });
    }
  };
  return (
    <div class="dt-popover dt-templates-popover" role="menu" aria-label="Templates" data-name="templates-menu">
      <Show when={props.getTemplate}>
        <button type="button" role="menuitem" class="dt-menu-row dt-templates-action" onClick={saveAs}>
          {toolbar() ? "Save Drawing Template As…" : "Save as…"}
        </button>
      </Show>
      <button type="button" role="menuitem" class="dt-menu-row dt-templates-action" onClick={() => { props.onApplyDefault(); props.onClose(); }}>
        {toolbar() ? "Apply Default Drawing Template" : "Apply defaults"}
      </button>
      <Show when={list().length > 0}>
        <div class="dt-menu-sep" role="separator" />
      </Show>
      <For each={list()}>
        {(t) => (
          <button
            type="button"
            role="menuitem"
            class="dt-menu-row dt-templates-item"
            onClick={() => { props.onApply(t); props.onClose(); }}
          >
            <span class="dt-menu-label">{t.name}</span>
            <span
              class="dt-templates-del"
              role="button"
              aria-label="Remove"
              title="Remove"
              onClick={(e) => { e.stopPropagation(); remove(t.name); }}
            >
              <Show
                when={toolbar()}
                fallback={
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 4h3v1h-1.04l-.88 9.64a1.5 1.5 0 0 1-1.5 1.36H6.42a1.5 1.5 0 0 1-1.5-1.36L4.05 5H3V4h3v-.5C6 2.67 6.67 2 7.5 2h3c.83 0 1.5.67 1.5 1.5V4ZM7.5 3a.5.5 0 0 0-.5.5V4h4v-.5a.5.5 0 0 0-.5-.5h-3ZM5.05 5l.87 9.55a.5.5 0 0 0 .5.45h5.17a.5.5 0 0 0 .5-.45L12.94 5h-7.9Z" /></svg>
                }
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9.707 9l4.647-4.646-.707-.708L9 8.293 4.354 3.646l-.708.708L8.293 9l-4.647 4.646.708.708L9 9.707l4.646 4.647.708-.707L9.707 9z" /></svg>
              </Show>
            </span>
          </button>
        )}
      </For>
    </div>
  );
}
