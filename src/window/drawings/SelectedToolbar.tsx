/*
 * SelectedToolbar — floating action strip above the selected drawing.
 *
 * Color / width / style now open dedicated popover widgets (ColorPopover with
 * a swatch grid + opacity, WidthPopover, StylePopover) instead of the earlier
 * native `<input type=color>` + click-to-cycle stand-ins, plus a Templates menu
 * to save/apply named style snapshots. Settings / lock / remove unchanged.
 *
 * Positioning: parent passes a screen-space anchor `{x, y}` (the bbox-top
 * center of the selected drawing). The toolbar sits 48px above with a minimum
 * 8px padding from the chart edges.
 *
 * Multi-select: color / text color / width / style / lock / remove apply to
 * EVERY selected drawing (bulk callbacks — one undo entry, matching the
 * Delete key); templates / settings / add-alert / More keep acting on the
 * primary, flagged in their tooltips.
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { type Drawing, type LineStyle } from "lightweight-charts-drawing/core/types";
import { factoryStyleFor } from "lightweight-charts-drawing/core/specs";
import { clearKindDefault, saveKindDefault, type DrawingTemplate } from "./templates";
import { Icon } from "../../components/Icon";
import { ColorPopover, FontSizePopover, HIGHLIGHTER_WIDTHS, StylePopover, TemplatesMenu, WidthPopover } from "./DrawingStylePopovers";
import { groupValue, sameColor, toolbarGroups, visibleColors, type ColorButton, type Group } from "./toolbar-groups";
import * as kv from "../../data/kv";
import { drawingCanAlert } from "../../data/alert-condition";

type Props = {
  drawing: Drawing;
  /** Full multi-selection (primary included). When longer than 1, the group
   *  ops — color / text color / width / style / lock / remove — hit every
   *  member; templates / settings / clone / reorder stay on the primary. */
  group?: Drawing[];
  /** Screen position (relative to the SVG/chart container) of the bbox-top
   *  center for the selected drawing. */
  anchor: { x: number; y: number };
  onUpdate: (d: Drawing) => void;
  /** Bulk replace for group style/lock edits — one undo entry. */
  onUpdateMany?: (list: Drawing[]) => void;
  onRemove: (id: string) => void;
  /** Bulk delete for the group trash — one undo entry. */
  onRemoveMany?: (ids: string[]) => void;
  onOpenSettings: (id: string, tab?: "Style" | "Text" | "Coordinates" | "Visibility") => void;
  onClone: (id: string) => void;
  onCopy: (d: Drawing) => void;
  onReorder: (id: string, dir: "front" | "forward" | "backward" | "back") => void;
  /** Opens the alert dialog prefilled with the drawing's first-point price. */
  onAddAlert?: (d: Drawing) => void;
  /** "Anchor drawing" toggle (anchorable tools only). */
  onToggleAnchor?: () => void;
  /** Table insert buttons ("Add column to right" / "Add row below"). */
  onTableOp?: (op: "insert-column" | "insert-row") => void;
};

const PADDING = 8;
const TOOLBAR_OFFSET_Y = 48;

/* ── Persistent toolbar position ────────────────────────────────────────────
 * The floating line-tool toolbar is ONE window: a `{left, top}` in viewport
 * px saved on every drag stop and restored for every future selection +
 * session, clamped back on-screen. Until the user's first drag we keep the
 * per-selection auto-anchor above the drawing. */
const POS_KEY = "ot:drawing-toolbar-pos";
type ToolbarPos = { left: number; top: number };

function loadToolbarPos(): ToolbarPos | null {
  try {
    const raw = kv.getItem(POS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (
      v !== null && typeof v === "object" &&
      typeof (v as ToolbarPos).left === "number" && typeof (v as ToolbarPos).top === "number"
    ) {
      return v as ToolbarPos;
    }
  } catch { /* corrupt entry → fall back to auto-anchor */ }
  return null;
}

function saveToolbarPos(pos: ToolbarPos): void {
  kv.setItem(POS_KEY, JSON.stringify(pos));
}

/** Which popover (if any) is open, keyed by the button that owns it
 *  ("color:<slot>" for the colour buttons). */
type OpenPopover = string | null;

const ORDER_ROWS: ReadonlyArray<readonly ["front" | "forward" | "backward" | "back", string]> = [
  ["front", "Bring to front"],
  ["forward", "Bring forward"],
  ["backward", "Send backward"],
  ["back", "Send to back"],
];


/** A style group of one selected drawing. */
type Target<T> = { d: Drawing; group: Group<T> };
/** One colour button: the group of every selected drawing that has it. */
type ColorSlot = { key: string; id: ColorButton["id"]; title: string; targets: Target<string>[] };
/** Colour buttons of a multi-selection: one per group kind, default titles. */
const MULTI_COLOR_TITLES: Record<ColorButton["id"], string> = {
  "line-tool-color": "Line tool colors",
  "background-color": "Line tool backgrounds",
  "text-color": "Line tool text colors",
};
const COLOR_ICONS: Record<ColorButton["id"], [string, number]> = {
  "line-tool-color": ["dt-line-tool-color", 16],
  "background-color": ["dt-background-color", 20],
  "text-color": ["dt-text-color", 16],
};

export function SelectedToolbar(props: Props) {
  const [openPopover, setOpenPopover] = createSignal<OpenPopover>(null);
  const toggle = (p: Exclude<OpenPopover, null>) =>
    setOpenPopover((cur) => (cur === p ? null : p));

  // Frozen base position (pre-drag mode only). The floating toolbar does NOT
  // follow the drawing on pan / object-move — it stays where it first appeared.
  // We capture the anchor once per selection, keyed on the drawing id and read
  // untracked so the pan-driven `anchor` updates don't re-freeze it.
  const [base, setBase] = createSignal({ x: props.anchor.x, y: props.anchor.y });
  let lastId: string | undefined;
  createEffect(() => {
    const id = props.drawing.id;
    if (id === lastId) return;
    lastId = id;
    const a = untrack(() => props.anchor);
    setBase({ x: a.x, y: a.y });
  });

  // Once the user drags the grip the toolbar is PINNED: one viewport-space
  // `{left, top}` shared by every selection and persisted across sessions
  // (kv `ot:drawing-toolbar-pos`).
  // Null until the first-ever drag → the auto-anchor path above applies.
  const [pinned, setPinned] = createSignal<ToolbarPos | null>(loadToolbarPos());
  let rootEl: HTMLDivElement | undefined;

  // Keep every open popover (templates, colour, width, style, More and its
  // submenu) inside the window: a popup menu opens under its button, then
  // clamps x / y into the window and scrolls when taller than the window.
  const clampPopovers = () => {
    if (!rootEl) return;
    for (const el of rootEl.querySelectorAll<HTMLElement>(".dt-popover, .dt-order-submenu")) {
      el.style.translate = "";
      el.style.maxHeight = "";
      el.style.overflowY = "";
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      if (r.height > vh) { el.style.maxHeight = `${vh}px`; el.style.overflowY = "auto"; }
      const h = Math.min(r.height, vh);
      const dx = Math.max(-r.left, Math.min(0, vw - r.right));
      const dy = Math.max(-r.top, Math.min(0, vh - (r.top + h)));
      if (dx || dy) el.style.translate = `${dx}px ${dy}px`;
    }
  };
  onMount(() => {
    if (!rootEl) return;
    let raf = 0;
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(clampPopovers); };
    const mo = new MutationObserver(schedule);
    mo.observe(rootEl, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    onCleanup(() => { mo.disconnect(); cancelAnimationFrame(raf); window.removeEventListener("resize", schedule); });
  });

  // Clamp a saved position back into the viewport so a
  // toolbar dragged on a large window can't restore off-screen on a small one.
  const clampPos = (p: ToolbarPos): ToolbarPos => {
    const w = rootEl?.offsetWidth ?? 320;
    const h = rootEl?.offsetHeight ?? 38;
    return {
      left: Math.max(PADDING, Math.min(p.left, window.innerWidth - w - PADDING)),
      top: Math.max(PADDING, Math.min(p.top, window.innerHeight - h - PADDING)),
    };
  };

  // Left grip handle drag — moves the pinned viewport position live and
  // persists it on release. Uses window-level move/up listeners (not
  // pointer-capture on the grip) so the drag keeps tracking when the cursor
  // leaves the small grip, and remove themselves on release. onCleanup clears
  // any dangling listeners if the toolbar unmounts mid-drag.
  let detachDrag: (() => void) | null = null;
  const onGripDown = (e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setOpenPopover(null);
    const rect = rootEl?.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, left: rect?.left ?? 0, top: rect?.top ?? 0 };
    const onMove = (ev: PointerEvent) =>
      setPinned({ left: start.left + (ev.clientX - start.x), top: start.top + (ev.clientY - start.y) });
    const onUp = () => {
      const p = pinned();
      if (p) saveToolbarPos(clampPos(p));
      detachDrag?.();
    };
    detachDrag = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      detachDrag = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  onCleanup(() => detachDrag?.());

  // Group targets for the group-op buttons. Single selection → just the
  // primary; the bulk callbacks keep a group edit to one undo entry.
  const groupTargets = (): Drawing[] => {
    const g = props.group;
    return g && g.length > 1 ? g : [props.drawing];
  };
  const isGroup = () => groupTargets().length > 1;

  /** Writes one value to a button's groups (colour / width / style buttons
   *  act on every selected drawing that has the group). */
  function applyGroup<T>(targets: Target<T>[], v: T) {
    const byId = new Map(targets.map((t) => [t.d.id, t]));
    const next = groupTargets()
      .filter((d) => byId.has(d.id))
      .map((d) => ({ ...d, style: byId.get(d.id)!.group.set(d, d.style, v) } as Drawing));
    if (next.length === 0) return;
    // A tool's defaults are saved on every UI property edit, so the next
    // drawing of the tool starts with this style.
    for (const d of next) saveKindDefault(d.kind, d.style);
    if (next.length > 1 && props.onUpdateMany) {
      props.onUpdateMany(next);
      return;
    }
    props.onUpdate(next.find((d) => d.id === props.drawing.id) ?? next[0]);
  }

  // Style buttons of the selection (per-tool groups, toolbar-groups.ts). One
  // drawing: its own buttons and titles; several: one button per group kind
  // over every drawing that has it.
  const colorSlots = createMemo((): ColorSlot[] => {
    const ds = groupTargets();
    if (ds.length === 1) {
      return visibleColors(ds[0]).map((b, i) => ({ key: `${b.id}:${i}`, id: b.id, title: b.title, targets: [{ d: ds[0], group: b.group }] }));
    }
    const out: ColorSlot[] = [];
    for (const id of ["line-tool-color", "background-color", "text-color"] as const) {
      const targets = ds.flatMap((d) => {
        const b = visibleColors(d).find((x) => x.id === id);
        return b ? [{ d, group: b.group }] : [];
      });
      if (targets.length) out.push({ key: id, id, title: MULTI_COLOR_TITLES[id], targets });
    }
    return out;
  });
  const widthTargets = (highlighter: boolean) => createMemo((): Target<number>[] =>
    groupTargets().flatMap((d) => {
      const w = toolbarGroups(d).width;
      return w && !!w.highlighter === highlighter ? [{ d, group: w }] : [];
    }));
  const lineWidthTargets = widthTargets(false);
  const highlighterWidthTargets = widthTargets(true);
  const styleTargets = createMemo((): Target<LineStyle>[] =>
    groupTargets().flatMap((d) => {
      const st = toolbarGroups(d).style;
      return st ? [{ d, group: st }] : [];
    }));
  const fontSizeTargets = createMemo((): Target<number>[] =>
    groupTargets().flatMap((d) => {
      const f = toolbarGroups(d).fontSize;
      return f ? [{ d, group: f }] : [];
    }));
  const valuesOf = <T,>(targets: Target<T>[]) => targets.flatMap((t) => t.group.get(t.d));
  const colorOf = (slot: ColorSlot) => groupValue(valuesOf(slot.targets), sameColor);
  /** Width button title: "Line tool widths" when several drawings share it. */
  const widthTitle = (targets: Target<number>[]) => (targets.length > 1 ? "Line tool widths" : "Line tool width");

  /** Templates menu → a saved template on the selection's drawings of the
   *  same tool: style over the factory style,
   *  plus the text of text tools. */
  function applyTemplate(tpl: DrawingTemplate) {
    const targets = groupTargets().filter((d) => d.kind === props.drawing.kind);
    const next = targets.map((d) => ({
      ...d,
      style: { ...factoryStyleFor(d.kind), ...tpl.style },
      ...(tpl.text !== undefined ? { text: tpl.text } : {}),
    } as Drawing));
    if (next.length > 1 && props.onUpdateMany) props.onUpdateMany(next);
    else if (next[0]) props.onUpdate(next[0]);
  }

  /** "Apply Default Drawing Template": factory style on every selected
   *  drawing, and the tools' saved defaults are cleared. */
  function applyFactoryDefaults() {
    const targets = groupTargets();
    for (const d of targets) clearKindDefault(d.kind);
    const next = targets.map((d) => ({ ...d, style: factoryStyleFor(d.kind) } as Drawing));
    if (next.length > 1 && props.onUpdateMany) props.onUpdateMany(next);
    else props.onUpdate(next[0]);
  }


  // The primary's NEXT state applies to every member, so a mixed group
  // converges instead of each member flipping its own flag.
  function toggleLocked() {
    const locked = !props.drawing.locked;
    const targets = groupTargets();
    if (targets.length > 1 && props.onUpdateMany) {
      props.onUpdateMany(targets.map((d) => ({ ...d, locked } as Drawing)));
      return;
    }
    props.onUpdate({ ...props.drawing, locked } as Drawing);
  }

  function removeSelection() {
    // Locked members survive bulk deletion, matching the Delete key; a single
    // locked drawing can still be removed through its own toolbar.
    const targets = groupTargets().filter((d) => !d.locked || d.id === props.drawing.id);
    if (targets.length > 1 && props.onRemoveMany) props.onRemoveMany(targets.map((d) => d.id));
    else props.onRemove(props.drawing.id);
  }

  // Close any open popover on Escape or an outside click. The toolbar root
  // stops pointerdown propagation, so a window-level pointerdown only fires for
  // genuinely-outside clicks.
  onMount(() => {
    const onDown = () => setOpenPopover(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenPopover(null); };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    });
  });

  // Pinned → viewport-fixed at the saved spot (clamped). Otherwise the
  // auto-anchor: 48px above the drawing's bbox-top, clamped to the pane.
  const left = () => {
    const p = pinned();
    return p ? clampPos(p).left : Math.max(PADDING, base().x - 100);
  };
  const top = () => {
    const p = pinned();
    return p ? clampPos(p).top : Math.max(PADDING, base().y - TOOLBAR_OFFSET_Y);
  };

  // Inline icons that react to the values — width thickness bar + style dash
  // pattern ("mixed" when the group's values differ).
  const styleValue = () => groupValue(valuesOf(styleTargets()));
  const styleDash = () => {
    const ls = styleValue();
    if (ls === "dashed") return "6 4";
    if (ls === "dotted") return "2 3";
    return undefined;
  };

  return (
    <div
      ref={rootEl}
      class="selected-toolbar"
      data-name="drawing-toolbar"
      // Pinned coordinates are viewport-space → `fixed`; the auto-anchor is
      // relative to the pane container → `absolute`.
      // Above the drawings layer (z-index 5) in both modes, so its popovers are
      // not covered by the drawing they edit.
      style={{ position: pinned() ? "fixed" : "absolute", left: `${left()}px`, top: `${top()}px`, "z-index": 24 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div class="selected-toolbar-content">
        {/* Drag grip — repositions the toolbar; the position persists across
            selections AND sessions (kv). */}
        <span
          class="selected-toolbar-drag"
          data-name="drag"
          title="Drag"
          aria-label="Drag toolbar"
          onPointerDown={onGripDown}
        >
          {/* 6-dot grip — the same SVG (viewBox 0 0 8 12) the
           *  favorites toolbar uses, rendered at its native 8×12 so the dots
           *  stay round + correctly spaced (rendering it via Icon squished the
           *  8×12 art into a square). */}
          <svg viewBox="0 0 8 12" width="8" height="12" fill="currentColor" aria-hidden="true">
            <rect width="2" height="2" rx="1" />
            <rect width="2" height="2" rx="1" y="5" />
            <rect width="2" height="2" rx="1" y="10" />
            <rect width="2" height="2" rx="1" x="6" />
            <rect width="2" height="2" rx="1" x="6" y="5" />
            <rect width="2" height="2" rx="1" x="6" y="10" />
          </svg>
        </span>

        {/* Templates FIRST — widget order (templates, color,
            text color, width, style, settings, add-alert, lock, remove, more). */}
        <span class="selected-toolbar-control">
          <button
            type="button"
            class="selected-toolbar-btn selected-toolbar-btn-templates"
            data-name="templates"
            title="Templates"
            aria-label="Templates"
            aria-expanded={openPopover() === "templates"}
            onClick={() => toggle("templates")}
          >
            <Icon name="dt-templates" size={28} />
          </button>
          <Show when={openPopover() === "templates"}>
            <TemplatesMenu
              variant="toolbar"
              kind={props.drawing.kind}
              // Save As only for one selected drawing.
              getTemplate={isGroup() ? undefined : () => ({ style: props.drawing.style, text: (props.drawing as { text?: string }).text })}
              onApply={applyTemplate}
              onApplyDefault={applyFactoryDefaults}
              onClose={() => setOpenPopover(null)}
            />
          </Show>
        </span>

        {/* Table insert buttons (toggle-insert-cells-button-*): a column
            right of / a row below the active cell, else at the end. */}
        <Show when={props.drawing.kind === "table" && props.onTableOp}>
          <button
            type="button"
            class="selected-toolbar-btn"
            data-name="toggle-insert-cells-button-Chart.SelectedObject.InsertColumnTable"
            title="Add column to right"
            aria-label="Add column to right"
            onClick={() => props.onTableOp?.("insert-column")}
          >
            <Icon name="dt-table-insert-column" size={28} />
          </button>
          <button
            type="button"
            class="selected-toolbar-btn"
            data-name="toggle-insert-cells-button-Chart.SelectedObject.InsertRowTable"
            title="Add row below"
            aria-label="Add row below"
            onClick={() => props.onTableOp?.("insert-row")}
          >
            <Icon name="dt-table-insert-row" size={28} />
          </button>
        </Show>

        {/* Colour buttons of the tool (line colours, backgrounds, text
            colours; per-tool groups and titles, toolbar-groups.ts). The bar
            shows the group's colour, empty when its colours differ. */}
        <For each={colorSlots()}>
          {(slot) => {
            const key = `color:${slot.key}`;
            const value = () => colorOf(slot);
            return (
              <span class="selected-toolbar-control">
                <button
                  type="button"
                  class={`selected-toolbar-btn selected-toolbar-btn-${slot.id}`}
                  data-name={slot.id}
                  title={slot.title}
                  aria-label={slot.title}
                  aria-expanded={openPopover() === key}
                  onClick={() => toggle(key)}
                >
                  <span class="selected-toolbar-icon-wrap">
                    <Icon name={COLOR_ICONS[slot.id][0]} size={COLOR_ICONS[slot.id][1]} />
                    <span class="selected-toolbar-color-bar">
                      <span class="selected-toolbar-color-bar-fill" style={{ "background-color": value() === "mixed" ? "transparent" : value() }} />
                    </span>
                  </span>
                </button>
                <Show when={openPopover() === key}>
                  <ColorPopover
                    value={value() === "mixed" ? "" : value()}
                    onChange={(c) => applyGroup(slot.targets, c)}
                    onClose={() => setOpenPopover(null)}
                  />
                </Show>
              </span>
            );
          }}
        </For>

        {/* Width — the 1/2/3/4px popover (highlighter: its own sizes). */}
        <For each={[{ key: "line-tool-width", targets: lineWidthTargets, options: undefined }, { key: "highlighter-width", targets: highlighterWidthTargets, options: HIGHLIGHTER_WIDTHS }] as const}>
          {(w) => {
            const value = () => groupValue(valuesOf(w.targets()));
            const barH = () => { const v = value(); return v === "mixed" ? 1 : Math.max(1, Math.min(5, v)); };
            return (
              <Show when={w.targets().length > 0}>
                <span class="selected-toolbar-control">
                  <button
                    type="button"
                    class="selected-toolbar-btn selected-toolbar-btn-line-tool-width"
                    data-name={w.key}
                    title={widthTitle(w.targets())}
                    aria-label={widthTitle(w.targets())}
                    aria-expanded={openPopover() === w.key}
                    onClick={() => toggle(w.key)}
                  >
                    <span class="selected-toolbar-width-wrap">
                      <Show
                        when={value() !== "mixed"}
                        fallback={
                          // Mixed widths: three bars of growing thickness, no label.
                          <svg viewBox="0 0 18 12" width="18" height="12" fill="currentColor" aria-hidden="true">
                            <rect y="1" width="18" height="1" rx=".5" />
                            <rect y="5" width="18" height="2" rx="1" />
                            <rect y="9" width="18" height="3" rx="1.5" />
                          </svg>
                        }
                      >
                        <svg viewBox={`0 0 18 ${barH()}`} width="18" height={barH()}>
                          <rect width="18" height={barH()} fill="currentColor" rx={barH() / 2} />
                        </svg>
                        <span class="selected-toolbar-width-label">{value()}px</span>
                      </Show>
                    </span>
                  </button>
                  <Show when={openPopover() === w.key}>
                    <WidthPopover
                      value={value() === "mixed" ? 0 : (value() as number)}
                      options={w.options}
                      onPick={(v) => { applyGroup(w.targets(), v); setOpenPopover(null); }}
                    />
                  </Show>
                </span>
              </Show>
            );
          }}
        </For>

        {/* Font size — the size as text, a menu of sizes (text tools, pin,
            signpost). */}
        <Show when={fontSizeTargets().length > 0}>
          <span class="selected-toolbar-control">
            <button
              type="button"
              class="selected-toolbar-btn selected-toolbar-btn-font-size"
              data-name="font-size"
              title="Font size"
              aria-label="Font size"
              aria-expanded={openPopover() === "font-size"}
              onClick={() => toggle("font-size")}
            >
              <span class="selected-toolbar-font-size">{groupValue(valuesOf(fontSizeTargets())) === "mixed" ? "—" : String(groupValue(valuesOf(fontSizeTargets())))}</span>
            </button>
            <Show when={openPopover() === "font-size"}>
              <FontSizePopover
                value={(() => { const v = groupValue(valuesOf(fontSizeTargets())); return v === "mixed" ? 0 : (v as number); })()}
                onPick={(s) => { applyGroup(fontSizeTargets(), s); setOpenPopover(null); }}
              />
            </Show>
          </span>
        </Show>

        <Show when={styleTargets().length > 0}>
        {/* Style — opens the Line/Dashed/Dotted popover */}
        <span class="selected-toolbar-control">
          <button
            type="button"
            class="selected-toolbar-btn selected-toolbar-btn-style"
            data-name="style"
            title="Style"
            aria-label="Style"
            aria-expanded={openPopover() === "style"}
            onClick={() => toggle("style")}
          >
            <Show
              when={styleValue() !== "mixed"}
              fallback={
                // Mixed styles: a solid, a dashed and a dotted line.
                <svg width="28" height="28" fill="none" aria-hidden="true">
                  <path stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4 8h20" />
                  <path stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" d="M4 14h20" />
                  <path stroke="currentColor" stroke-width="1.5" stroke-dasharray="1.5 2.5" d="M4 20h20" />
                </svg>
              }
            >
              <svg width="28" height="28" fill="none">
                <path
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-dasharray={styleDash()}
                  d="M4 14h20"
                />
              </svg>
            </Show>
          </button>
          <Show when={openPopover() === "style"}>
            <StylePopover
              value={styleValue() === "mixed" ? ("" as LineStyle) : (styleValue() as LineStyle)}
              onPick={(s) => { applyGroup(styleTargets(), s); setOpenPopover(null); }}
            />
          </Show>
        </span>
        </Show>

        {/* Settings */}
        <button
          type="button"
          class="selected-toolbar-btn selected-toolbar-btn-settings"
          data-name="settings"
          title={isGroup() ? "Settings (applies to the primary drawing)" : "Settings"}
          aria-label="Settings"
          onClick={() => props.onOpenSettings(props.drawing.id)}
        >
          <Icon name="dt-settings" size={28} />
        </button>

        {/* Add alert — prefilled with the drawing's first-point price. */}
        <Show when={props.onAddAlert && drawingCanAlert(props.drawing.kind)}>
          <button
            type="button"
            class="selected-toolbar-btn selected-toolbar-btn-add-alert"
            data-name="add-alert"
            title="Add alert"
            aria-label="Add alert"
            onClick={() => props.onAddAlert?.(props.drawing)}
          >
            <Icon name="dt-add-alert" size={28} />
          </button>
        </Show>

        {/* Lock toggle */}
        <button
          type="button"
          class={"selected-toolbar-btn selected-toolbar-btn-lock" + (props.drawing.locked ? " active" : "")}
          data-name="lock"
          title={(props.drawing.locked ? "Unlock" : "Lock") + (isGroup() ? ` ${groupTargets().length} drawings` : "")}
          aria-label={props.drawing.locked ? "Unlock" : "Lock"}
          aria-pressed={!!props.drawing.locked}
          onClick={toggleLocked}
        >
          <Icon name="dt-lock" size={28} />
        </button>

        {/* Anchor drawing (toggle-anchor, after Lock; active = anchored). */}
        <Show when={props.onToggleAnchor && !isGroup()}>
          <button
            type="button"
            class={"selected-toolbar-btn selected-toolbar-btn-anchor" + (props.drawing.anchored ? " active" : "")}
            data-name="toggle-anchor"
            title="Anchor drawing"
            aria-label="Anchor drawing"
            aria-pressed={!!props.drawing.anchored}
            onClick={() => props.onToggleAnchor?.()}
          >
            <Icon name="dt-anchor" size={28} />
          </button>
        </Show>

        {/* Remove — the whole selection when more than one drawing is picked
            (same bulk path as the Delete key: one undo entry). */}
        <button
          type="button"
          class="selected-toolbar-btn selected-toolbar-btn-remove"
          data-name="remove"
          title={isGroup() ? `Remove ${groupTargets().length} drawings` : "Remove"}
          aria-label="Remove"
          onClick={removeSelection}
        >
          <Icon name="dt-remove" size={28} />
        </button>

        {/* More — menu (Visual order ▸ / Visibility on
            intervals… / Clone / Copy / Hide; per-drawing sync omitted — no
            backing in this app). */}
        <span class="selected-toolbar-control">
          <button
            type="button"
            class="selected-toolbar-btn selected-toolbar-btn-more"
            data-name="more"
            title={isGroup() ? "More (applies to the primary drawing)" : "More"}
            aria-label="More"
            aria-expanded={openPopover() === "more"}
            onClick={() => toggle("more")}
          >
            <Icon name="dt-more" size={28} />
          </button>
          <Show when={openPopover() === "more"}>
            <MoreMenu
              drawing={props.drawing}
              onReorder={(dir) => { props.onReorder(props.drawing.id, dir); setOpenPopover(null); }}
              onVisibility={() => { props.onOpenSettings(props.drawing.id, "Visibility"); setOpenPopover(null); }}
              onClone={() => { props.onClone(props.drawing.id); setOpenPopover(null); }}
              onCopy={() => { props.onCopy(props.drawing); setOpenPopover(null); }}
              onHide={() => { props.onUpdate({ ...props.drawing, hidden: !props.drawing.hidden } as Drawing); setOpenPopover(null); }}
            />
          </Show>
        </span>
      </div>
    </div>
  );
}

/** The "More" dropdown of the floating toolbar (214×307; sync radios
 *  omitted, see header comment). */
function MoreMenu(props: {
  drawing: Drawing;
  onReorder: (dir: "front" | "forward" | "backward" | "back") => void;
  onVisibility: () => void;
  onClone: () => void;
  onCopy: () => void;
  onHide: () => void;
}) {
  const [orderOpen, setOrderOpen] = createSignal(false);
  // Flip the submenu left when a rightward open would leave the viewport (the
  // toolbar — and thus this menu — often sits near the pane's right edge).
  const [orderLeft, setOrderLeft] = createSignal(false);
  const SUBMENU_W = 160; // keep in sync with .dt-order-submenu width
  return (
    <div class="dt-popover dt-more-popover" role="menu" aria-label="More" data-name="more-menu">
      <div
        class="dt-more-submenu-host"
        onPointerEnter={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setOrderLeft(r.right + SUBMENU_W > window.innerWidth - 4);
          setOrderOpen(true);
        }}
        onPointerLeave={() => setOrderOpen(false)}
      >
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={orderOpen()} class="dt-menu-row">
          <span class="dt-menu-label">Visual order</span>
          <span class="dt-menu-subarrow" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="11" height="11">
              <path fill="currentColor" d="M6 3l5 5-5 5z" />
            </svg>
          </span>
        </button>
        <Show when={orderOpen()}>
          <div class="dt-popover dt-order-submenu" classList={{ "opens-left": orderLeft() }} role="menu">
            {ORDER_ROWS.map(([dir, label]) => (
              <button type="button" role="menuitem" class="dt-menu-row" onClick={() => props.onReorder(dir)}>
                <span class="dt-menu-label">{label}</span>
              </button>
            ))}
          </div>
        </Show>
      </div>
      <button type="button" role="menuitem" class="dt-menu-row" onClick={props.onVisibility}>
        <span class="dt-menu-label">Visibility on intervals…</span>
      </button>
      <div class="dt-menu-sep" role="separator" />
      <button type="button" role="menuitem" class="dt-menu-row" onClick={props.onClone}>
        <span class="dt-menu-label">Clone</span>
        <span class="dt-menu-shortcut">Ctrl + Drag</span>
      </button>
      <button type="button" role="menuitem" class="dt-menu-row" onClick={props.onCopy}>
        <span class="dt-menu-label">Copy</span>
        <span class="dt-menu-shortcut">Ctrl + C</span>
      </button>
      <div class="dt-menu-sep" role="separator" />
      <button type="button" role="menuitem" class="dt-menu-row" onClick={props.onHide}>
        <span class="dt-menu-label">{props.drawing.hidden ? "Show" : "Hide"}</span>
      </button>
    </div>
  );
}
