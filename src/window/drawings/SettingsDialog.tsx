/*
 * SettingsDialog — modal opened from the SelectedToolbar Settings button or
 * the context menu's Settings… row.
 *
 * 4 tabs (`source-properties-editor`):
 *   • Style       — color/width/lineStyle, plus the line-family toggles
 *                   (extend, middle point, end arrows, stats group), each
 *                   gated to the kinds that support it.
 *   • Text        — on-line label + font/bold/italic/alignment (line family);
 *                   placeholder for kinds without text.
 *   • Coordinates — read-only price + time per point
 *   • Visibility  — Lock + Hide checkboxes
 *
 * Field coverage is intentionally narrow — toggles are
 * added as the matching DrawingStyle fields + renderers land.
 */
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Drawing, DrawingStyle } from "lightweight-charts-drawing/core/types";
import { labelForKind } from "./labels";
import { isIconGlyph } from "./toolbar-groups";
import { factoryStyleFor } from "lightweight-charts-drawing/core/specs";
import { clearKindDefault, kindDefaultOverride, saveKindDefault } from "./templates";
import { TemplatesMenu } from "./DrawingStylePopovers";
import { getTickerInfo } from "../../data/datafeed";
import { INPUTS_KINDS, NO_COORDINATES_KINDS, NO_STYLE_KINDS, POSITION_KINDS, TEXT_BOX_KINDS, TEXT_KINDS, type Tab } from "./settings/kind-config";
import { type SettingsCx, type SettingsDialogProps } from "./settings/context";
import { inputsTab } from "./settings/inputs-tab";
import { styleTab } from "./settings/style-tab";
import { textBoxRows, textTab } from "./settings/text-tab";
import { coordinatesTab } from "./settings/coordinates-tab";
import { visibilityTab } from "./settings/visibility-tab";

// The dialog's pages live in settings/: one module per page (inputs, style,
// text, coordinates, visibility), the per-kind tables (kind-config), the
// shared form controls (controls), the per-kind Style sections
// (style-sections, volume-profile).
export { RangeSlider } from "./settings/visibility-tab";

export function SettingsDialog(props: SettingsDialogProps) {
  /** Page order Inputs / Style / Text / Coordinates / Visibility; a page is
   *  added only when the tool has content for it: Text only for tools with text,
   *  Coordinates only for tools with editable coordinates. */
  const dialogTabs = (): Tab[] => {
    const k = props.drawing.kind;
    const out: Tab[] = [];
    if (INPUTS_KINDS.has(k)) out.push("Inputs");
    // Emoji and sticker glyphs have no Style page (fixed colours); the
    // icon glyph has its Color row.
    const fixedGlyph = k === "font-icon" && !isIconGlyph(props.drawing);
    if (!NO_STYLE_KINDS.has(k) && !fixedGlyph) out.push("Style");
    if (TEXT_KINDS.has(k)) out.push("Text");
    // An anchored drawing (pane position, Pin) has no editable coordinates.
    if (!NO_COORDINATES_KINDS.has(k) && !props.drawing.anchored) out.push("Coordinates");
    out.push("Visibility");
    return out;
  };
  const [activeTab, setActiveTab] = createSignal<Tab>(
    props.initialTab && dialogTabs().includes(props.initialTab)
      ? props.initialTab
      : dialogTabs().includes("Style") ? "Style" : dialogTabs()[0],
  );
  // Footer "Template" dropdown (save/apply named styles + reset to defaults).
  const [templatesOpen, setTemplatesOpen] = createSignal(false);
  let footerTemplateEl: HTMLDivElement | undefined;

  // Cancel reverts what the dialog changed (the reference undoes to a
  // checkpoint taken at open): the drawing as it was and the tool default
  // it had. Ok, the close button, Escape and an outside click keep the edits.
  const openedDrawing = JSON.parse(JSON.stringify(props.drawing)) as Drawing;
  const openedDefault = kindDefaultOverride(props.drawing.kind);
  const cancel = () => {
    if (openedDefault) saveKindDefault(openedDrawing.kind, openedDefault);
    else clearKindDefault(openedDrawing.kind);
    props.onUpdate(openedDrawing);
    props.onClose();
  };

  function patchStyle(patch: Partial<DrawingStyle>) {
    const style = { ...props.drawing.style, ...patch };
    // The tool's defaults are saved on every UI property edit.
    saveKindDefault(props.drawing.kind, style);
    props.onUpdate({ ...props.drawing, style } as Drawing);
  }

  const kind = () => props.drawing.kind as string;
  // Risk unit options: "%" and the symbol currency ("Cash" when unknown).
  const [tickerInfo] = createResource(
    () => (POSITION_KINDS.has(props.drawing.kind) && props.symbol ? props.symbol : null),
    (sym) => getTickerInfo(sym).catch(() => null),
  );
  const moneyUnit = () => tickerInfo()?.currency || "Cash";
  const pip = () => props.coords?.pipSize() ?? 0.01;
  const priceDigits = () => Math.max(0, Math.min(8, Math.round(-Math.log10(pip()))));
  // What the pages (settings/*-tab.tsx) read and patch.
  const cx: SettingsCx = { props, kind, moneyUnit, patchStyle, pip, priceDigits };

  // Title rename (pencil): the field replaces the title and the close
  // button with the whole name selected; Enter or leaving the field saves,
  // Escape cancels, an empty name keeps the old one.
  const [renaming, setRenaming] = createSignal(false);
  const displayName = () => props.drawing.name ?? labelForKind(props.drawing.kind);
  let renameCancelled = false;
  const endRename = (save: boolean, value: string) => {
    if (!renaming()) return;
    setRenaming(false);
    const v = value.trim();
    if (!save || !v || v === displayName()) return;
    props.onUpdate({ ...props.drawing, name: v !== labelForKind(props.drawing.kind) ? v : undefined } as Drawing);
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (renaming()) { renameCancelled = true; setRenaming(false); return; }
        // Escape unwinds one layer at a time. The footer Template menu and any
        // open nested popover (colour panel / Stats checklist) each own their
        // own Escape dismissal — defer to them and only close the bare dialog.
        if (templatesOpen()) { setTemplatesOpen(false); return; }
        if (document.querySelector(".dlg-color-panel, .drawing-settings-multiselect-menu")) return;
        props.onClose();
      }
    };
    // Capture phase so the overlay's own Escape handler doesn't fire first.
    window.addEventListener("keydown", onKey, true);
    // Outside-click closes the template menu (capture, since the dialog stops
    // bubble-phase clicks at its root).
    const onDocClick = (e: MouseEvent) => {
      if (!templatesOpen()) return;
      const t = e.target as Node | null;
      if (t && footerTemplateEl?.contains(t)) return;
      setTemplatesOpen(false);
    };
    document.addEventListener("click", onDocClick, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("click", onDocClick, true);
    });
  });

  return (
    <div
      class="drawing-settings-backdrop"
      role="presentation"
      onClick={props.onClose}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        class="drawing-settings-dialog"
        role="dialog"
        aria-label={displayName()}
        data-name="source-properties-editor"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="drawing-settings-header">
          <Show
            when={!renaming()}
            fallback={
              <input
                type="text"
                class="drawing-settings-rename"
                aria-label="Drawing name"
                value={displayName()}
                ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); endRename(true, e.currentTarget.value); }
                }}
                onBlur={(e) => {
                  const cancelled = renameCancelled;
                  renameCancelled = false;
                  endRename(!cancelled, e.currentTarget.value);
                }}
              />
            }
          >
            <div class="drawing-settings-title">
              <span class="drawing-settings-title-text">{displayName()}</span>
              <button type="button" class="drawing-settings-edit" data-name="edit" aria-label="Rename" onClick={() => { renameCancelled = false; setRenaming(true); }}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"><path fill="currentColor" d="M16.73 6.56a2.5 2.5 0 0 1 3.54 0l1.17 1.17a2.5 2.5 0 0 1 0 3.54l-.59.58-9 9-1 1-.14.15H6v-4.7l.15-.15 1-1 9-9 .58-.59Zm2.83.7a1.5 1.5 0 0 0-2.12 0l-.23.24 3.29 3.3.23-.24a1.5 1.5 0 0 0 0-2.12l-1.17-1.17Zm.23 4.24L16.5 8.2l-8.3 8.3 3.3 3.3 8.3-8.3Zm-9 9L7.5 17.2l-.5.5V21h3.3l.5-.5Z" /></svg>
              </button>
            </div>
            <button type="button" aria-label="Close" data-qa-id="close" class="drawing-settings-close" onClick={props.onClose}>
              <svg viewBox="0 0 18 18" width="18" height="18">
                <path stroke="currentColor" stroke-width="1.2" d="m1.5 1.5 15 15m0-15-15 15" />
              </svg>
            </button>
          </Show>
        </header>

        <nav class="drawing-settings-tabs" role="tablist" aria-orientation="horizontal">
          <For each={dialogTabs()}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab() === tab}
                class={"drawing-settings-tab" + (activeTab() === tab ? " selected" : "")}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            )}
          </For>
        </nav>

        <div class="drawing-settings-body" role="tabpanel">
          <Show when={activeTab() === "Inputs"}>
            {inputsTab(cx)}
          </Show>

          <Show when={activeTab() === "Style"}>
            {/* Style page: the rows of each tool in display order
                (STYLE_ROWS). */}
            {styleTab(cx)}
          </Show>

          <Show when={activeTab() === "Text"}>
            {textTab(cx)}
          </Show>

          {/* Text tools, Text page rows after the text:
              text = [x] Background, [x] Border, [x] Text wrap; callout =
              Background, Border (colour + width), [x] Text wrap; comment =
              Background, Border; pin = [x] Background, [x] Border. */}
          <Show when={activeTab() === "Text" && TEXT_BOX_KINDS.has(kind())}>
            {textBoxRows(cx)}
          </Show>

          <Show when={activeTab() === "Coordinates"}>
            {coordinatesTab(cx)}
          </Show>

          <Show when={activeTab() === "Visibility"}>
            {visibilityTab(cx)}
          </Show>
        </div>

        <footer class="drawing-settings-footer">
          {/* Template dropdown — save the current style as a named template,
              apply a saved one, or reset to the kind's defaults (footer
              "Template" control). Opens upward (footer is at the bottom). */}
          <div class="drawing-settings-footer-template" ref={footerTemplateEl}>
            <button
              type="button"
              class="drawing-settings-template-btn"
              aria-haspopup="menu"
              aria-expanded={templatesOpen()}
              onClick={() => setTemplatesOpen((o) => !o)}
            >
              Template
              <span class="drawing-settings-chevron"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.92 7.83 9 12.29l5.08-4.46-1-1.13L9 10.29l-4.09-3.6-.99 1.14Z" /></svg></span>
            </button>
            <Show when={templatesOpen()}>
              <TemplatesMenu
                variant="dialog"
                kind={props.drawing.kind}
                getTemplate={() => ({ style: props.drawing.style, text: (props.drawing as { text?: string }).text })}
                // A saved template over the factory style (+ text of text tools).
                onApply={(tpl) =>
                  props.onUpdate({
                    ...props.drawing,
                    style: { ...factoryStyleFor(props.drawing.kind), ...tpl.style },
                    ...(tpl.text !== undefined ? { text: tpl.text } : {}),
                  } as Drawing)
                }
                // "Apply defaults" = factory style; the tool's saved default is
                // cleared.
                onApplyDefault={() => {
                  clearKindDefault(props.drawing.kind);
                  props.onUpdate({ ...props.drawing, style: factoryStyleFor(props.drawing.kind) } as Drawing);
                }}
                onClose={() => setTemplatesOpen(false)}
              />
            </Show>
          </div>
          <div class="drawing-settings-footer-buttons">
            <button
              type="button"
              name="cancel"
              class="drawing-settings-btn secondary"
              onClick={cancel}
            >
              Cancel
            </button>
            <button
              type="button"
              name="submit"
              data-name="submit-button"
              class="drawing-settings-btn primary"
              onClick={props.onClose}
            >
              Ok
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
