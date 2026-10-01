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
import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from "solid-js";
import { type Drawing, type DrawingStyle } from "lightweight-charts-drawing/core/types";
import { factoryStyleFor, REGRESSION_LINE_DEFAULTS } from "lightweight-charts-drawing/core/specs";
import { clearKindDefault, saveKindDefault, type DrawingTemplate } from "./templates";
import { Icon } from "../../components/Icon";
import { ColorPopover, StylePopover, TemplatesMenu, WidthPopover } from "./DrawingStylePopovers";
import * as kv from "../../data/kv";

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

/** Which popover (if any) is open, keyed by the button that owns it. */
type OpenPopover = "line-tool-color" | "background-color" | "text-color" | "line-tool-width" | "style" | "templates" | "more" | null;

const ORDER_ROWS: ReadonlyArray<readonly ["front" | "forward" | "backward" | "back", string]> = [
  ["front", "Bring to front"],
  ["forward", "Bring forward"],
  ["backward", "Send backward"],
  ["back", "Send to back"],
];

/** Kinds whose renderers actually use `style.textColor` (on-line text label /
 *  angle label) — the text-color button only shows for these (per-tool
 *  floating toolbar). */
const TEXT_COLOR_KINDS = new Set<string>(["trend-line", "ray", "extended-line", "info-line", "trend-angle", "table"]);
/** Kinds with a background colour button (table: line / background / text
 *  colours). */
const BACKGROUND_COLOR_KINDS = new Set<string>(["table"]);
/** Kinds without line width / line style buttons (table; the image has
 *  no line, background or text property). */
const NO_WIDTH_STYLE_KINDS = new Set<string>(["table", "image"]);
/** Kinds without the add-alert button (table and image toolbars). */
const NO_ALERT_KINDS = new Set<string>(["table", "image"]);

/** Kinds whose toolbar line colour / width is copied to every level
 *  (lineColor / lineWidth = levelN.color / levelN.lineWidth). */
const COLLECTED_LEVEL_KINDS = new Set<string>(["parallel-channel"]);
/** Kinds whose floating toolbar has no line colour / line style button
 *  (regression trend: templates, width, settings, lock, remove, more). */
const NO_COLOR_STYLE_KINDS = new Set<string>(["regression-trend", "image"]);
function withCollectedLevels(d: Drawing, patch: Partial<DrawingStyle>): DrawingStyle {
  const next = { ...d.style, ...patch };
  // Regression trend: the toolbar width sets the up / down / base lines.
  if (d.kind === "regression-trend" && patch.width != null) {
    const rl = d.style.regressionLines ?? REGRESSION_LINE_DEFAULTS;
    const w = patch.width;
    next.regressionLines = { base: { ...rl.base, width: w }, up: { ...rl.up, width: w }, down: { ...rl.down, width: w } };
    return next;
  }
  if (!COLLECTED_LEVEL_KINDS.has(d.kind) || !d.style.levels || (patch.color == null && patch.width == null)) return next;
  next.levels = d.style.levels.map((l) => ({
    ...l,
    ...(patch.color != null ? { color: patch.color } : {}),
    ...(patch.width != null ? { width: patch.width } : {}),
  }));
  return next;
}

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

  /** Style patch across the whole selection (color / text color / width /
   *  line-style buttons — these apply to every selected drawing). */
  function patchStyle(patch: Partial<DrawingStyle>) {
    const targets = groupTargets();
    const next = targets.map((d) => ({ ...d, style: withCollectedLevels(d, patch) } as Drawing));
    // A tool's defaults are saved on every UI property edit, so the next
    // drawing of the tool starts with this style.
    for (const d of next) saveKindDefault(d.kind, d.style);
    if (next.length > 1 && props.onUpdateMany) {
      props.onUpdateMany(next);
      return;
    }
    props.onUpdate(next.find((d) => d.id === props.drawing.id) ?? next[0]);
  }

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

  // Inline icons that react to drawing state — width thickness bar + style
  // dash pattern.
  // Regression trend: the width button shows the collected up-line width.
  const shownWidth = () =>
    props.drawing.kind === "regression-trend"
      ? (props.drawing.style.regressionLines ?? REGRESSION_LINE_DEFAULTS).up.width
      : props.drawing.style.width;
  const widthBarHeight = () => Math.max(1, Math.min(5, shownWidth()));
  const styleDash = () => {
    const ls = props.drawing.style.lineStyle;
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
      style={{ position: pinned() ? "fixed" : "absolute", left: `${left()}px`, top: `${top()}px`, "z-index": pinned() ? 24 : 4 }}
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
            title={isGroup() ? "Templates (applies to the primary drawing)" : "Templates"}
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

        <Show when={!NO_COLOR_STYLE_KINDS.has(props.drawing.kind)}>
        {/* Color — opens the swatch-grid popover */}
        <span class="selected-toolbar-control">
          <button
            type="button"
            class="selected-toolbar-btn selected-toolbar-btn-line-tool-color"
            data-name="line-tool-color"
            title="Line tool colors"
            aria-label="Line tool colors"
            aria-expanded={openPopover() === "line-tool-color"}
            onClick={() => toggle("line-tool-color")}
          >
            <span class="selected-toolbar-icon-wrap">
              <Icon name="dt-line-tool-color" size={16} />
              <span class="selected-toolbar-color-bar">
                <span class="selected-toolbar-color-bar-fill" style={{ "background-color": props.drawing.style.color }} />
              </span>
            </span>
          </button>
          <Show when={openPopover() === "line-tool-color"}>
            <ColorPopover
              value={props.drawing.style.color}
              onChange={(c) => patchStyle({ color: c })}
              onClose={() => setOpenPopover(null)}
            />
          </Show>
        </span>
        </Show>

        {/* Background colour ("Line tool backgrounds"). */}
        <Show when={BACKGROUND_COLOR_KINDS.has(props.drawing.kind)}>
          <span class="selected-toolbar-control">
            <button
              type="button"
              class="selected-toolbar-btn selected-toolbar-btn-background-color"
              data-name="background-color"
              title="Line tool backgrounds"
              aria-label="Line tool backgrounds"
              aria-expanded={openPopover() === "background-color"}
              onClick={() => toggle("background-color")}
            >
              <span class="selected-toolbar-icon-wrap">
                <Icon name="dt-background-color" size={20} />
                <span class="selected-toolbar-color-bar">
                  <span class="selected-toolbar-color-bar-fill" style={{ "background-color": props.drawing.style.backgroundColor ?? props.drawing.style.color }} />
                </span>
              </span>
            </button>
            <Show when={openPopover() === "background-color"}>
              <ColorPopover
                value={props.drawing.style.backgroundColor ?? props.drawing.style.color}
                onChange={(c) => patchStyle({ backgroundColor: c })}
                onClose={() => setOpenPopover(null)}
              />
            </Show>
          </span>
        </Show>

        {/* Text color — only for kinds that render text (on-line label / angle
            label). Edits style.textColor; falls back to the line colour for the
            swatch + popover when unset (matches the effective render). */}
        <Show when={TEXT_COLOR_KINDS.has(props.drawing.kind)}>
          <span class="selected-toolbar-control">
            <button
              type="button"
              class="selected-toolbar-btn selected-toolbar-btn-text-color"
              data-name="text-color"
              title="Line tool text colors"
              aria-label="Line tool text colors"
              aria-expanded={openPopover() === "text-color"}
              onClick={() => toggle("text-color")}
            >
              <span class="selected-toolbar-icon-wrap">
                <Icon name="dt-text-color" size={16} />
                <span class="selected-toolbar-color-bar">
                  <span class="selected-toolbar-color-bar-fill" style={{ "background-color": props.drawing.style.textColor ?? props.drawing.style.color }} />
                </span>
              </span>
            </button>
            <Show when={openPopover() === "text-color"}>
              <ColorPopover
                value={props.drawing.style.textColor ?? props.drawing.style.color}
                onChange={(c) => patchStyle({ textColor: c })}
                onClose={() => setOpenPopover(null)}
              />
            </Show>
          </span>
        </Show>

        {/* Width — opens the 1/2/3/4px popover */}
        <Show when={!NO_WIDTH_STYLE_KINDS.has(props.drawing.kind)}>
        <span class="selected-toolbar-control">
          <button
            type="button"
            class="selected-toolbar-btn selected-toolbar-btn-line-tool-width"
            data-name="line-tool-width"
            title="Line tool width"
            aria-label="Line tool width"
            aria-expanded={openPopover() === "line-tool-width"}
            onClick={() => toggle("line-tool-width")}
          >
            <span class="selected-toolbar-width-wrap">
              <svg viewBox={`0 0 18 ${widthBarHeight()}`} width="18" height={widthBarHeight()}>
                <rect width="18" height={widthBarHeight()} fill="currentColor" rx={widthBarHeight() / 2} />
              </svg>
              <span class="selected-toolbar-width-label">{shownWidth()}px</span>
            </span>
          </button>
          <Show when={openPopover() === "line-tool-width"}>
            <WidthPopover
              value={shownWidth()}
              onPick={(w) => { patchStyle({ width: w }); setOpenPopover(null); }}
            />
          </Show>
        </span>
        </Show>

        <Show when={!NO_COLOR_STYLE_KINDS.has(props.drawing.kind) && !NO_WIDTH_STYLE_KINDS.has(props.drawing.kind)}>
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
            <svg width="28" height="28" fill="none">
              <path
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-dasharray={styleDash()}
                d="M4 14h20"
              />
            </svg>
          </button>
          <Show when={openPopover() === "style"}>
            <StylePopover
              value={props.drawing.style.lineStyle}
              onPick={(s) => { patchStyle({ lineStyle: s }); setOpenPopover(null); }}
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
        <Show when={props.onAddAlert && !NO_ALERT_KINDS.has(props.drawing.kind)}>
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
