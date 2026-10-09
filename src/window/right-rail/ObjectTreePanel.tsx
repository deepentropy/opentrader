/*
 * ObjectTreePanel — right-rail "object_tree" tab content.
 *
 * Drawing rows backed by App's drawings
 * array. Row click selects the drawing on the chart; per-row icons
 * toggle lock / hide / remove. This is the only UI that can unhide an
 * individually-hidden drawing — without it, the per-drawing Hide flag
 * is a one-way trip.
 *
 * Rows, one block per chart pane: the pane's objects in its drawing order,
 * front object first (sources = main series, studies, compared symbols, and
 * drawings in one list, published by the focused chart). A source row has
 * hide (and remove, but for the main series).
 *
 * Drag-to-reorder: rows are HTML5-draggable; a row dropped above / below
 * another row of its pane takes that place in the drawing order (a drawing
 * can go behind a source, a source in front of a drawing). A study dropped
 * on a row of another pane moves to that pane.
 *
 * Header toolbar: copy-clone is wired to App's cloneDrawing (clones the selected
 * drawing). Manage toggles a management mode: per-row checkboxes plus bulk
 * hide / lock / delete over the checked set (each op routed through the same
 * per-item onUpdate/onRemove callbacks the row icons use). Group names the
 * checked drawings (a `group` tag persisted on each drawing via onUpdate) and
 * makes them adjacent, so they render under a shared header with an Ungroup
 * action. Move to puts the selected study in a new pane (study-selection.ts).
 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { PanelHeader } from "../../components/PanelHeader";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Icon, type IconName } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Tooltip } from "../../components/Tooltip";
import { labelForKind, iconForKind } from "../drawings/labels";
import { focusedStudySelection, requestMoveStudy, requestSelectStudy } from "../chart/study-selection";
import {
  focusedTreePanes,
  focusedTreeSources,
  requestMoveSource,
  requestRemoveSource,
  requestToggleSourceHidden,
  type TreeSource,
} from "../chart/object-tree-sources";
import { ChartContextMenu } from "../chart/ChartContextMenu";
import { copyDrawing } from "../drawings/clipboard";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { consumeDataWindowRequest, dataWindow } from "../../data/data-window-store";

type View = "tree" | "data-window";

const TABS = [
  { id: "tree" as const, label: "Object tree" },
  { id: "data-window" as const, label: "Data window" },
];

// ── Data window formatting ───────────────────────────────────────────────────
const MINUS = "−"; // Unicode minus, matching the chart legend.
function priceDecimals(p: number): number {
  const a = Math.abs(p);
  return a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
}
function fmtPrice(p: number): string {
  return p.toFixed(priceDecimals(p));
}
function fmtSigned(n: number, decimals: number): string {
  return `${n < 0 ? MINUS : "+"}${Math.abs(n).toFixed(decimals)}`;
}
function fmtVolume(v: number): string {
  const a = Math.abs(v);
  const [div, suffix] =
    a >= 1e9 ? [1e9, " B"] : a >= 1e6 ? [1e6, " M"] : a >= 1e3 ? [1e3, " K"] : [1, ""];
  return parseFloat((v / div).toFixed(2)).toString() + suffix;
}
/** Compact value format for indicator plots ("773.19 M", "82.50"), as in the
 *  study legend. */
function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)} B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)} M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)} K`;
  return v.toFixed(2);
}
function fmtDate(timeSec: number, tz?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(tz ? { timeZone: tz } : {}),
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "2-digit",
  }).format(new Date(timeSec * 1000));
}
function fmtTime(timeSec: number, tz?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(tz ? { timeZone: tz } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timeSec * 1000));
}

/** One label/value line in the data window. `dir` tints up/down; `color`
 *  overrides (indicator plot colour). */
function DwRow(props: { label: string; value: string; dir?: "up" | "down"; color?: string }) {
  return (
    <div class="data-window-row">
      <span class="data-window-label">{props.label}</span>
      <span
        class={`data-window-value${props.dir ? ` ${props.dir}` : ""}`}
        style={props.color ? { color: props.color } : undefined}
      >
        {props.value}
      </span>
    </div>
  );
}

/** Data window view — the focused pane's bar values under the crosshair (or its
 *  latest bar), fed by data/data-window-store. */
function DataWindow() {
  return (
    <Show
      when={dataWindow()}
      fallback={
        <div class="ot-empty-state object-tree-panel-empty">
          Hover the chart to see values.
        </div>
      }
    >
      {(s) => (
        <div class="data-window">
          {/* Date + time first, then a separator (the section border), then the
              symbol header, then the bar data. */}
          <div class="data-window-section">
            <DwRow label="Date" value={fmtDate(s().time, s().timeZone)} />
            <Show when={s().intraday}>
              <DwRow label="Time" value={fmtTime(s().time, s().timeZone)} />
            </Show>
          </div>
          <div class="data-window-section">
            <div class="data-window-header">
              <Icon name={s().chartTypeIcon as IconName} size={16} />
              <span class="data-window-symbol">{s().ticker}</span>
              <span class="data-window-sub">
                {[s().interval, s().exchange].filter(Boolean).join(" · ")}
              </span>
            </div>
            <DwRow label="Open" value={fmtPrice(s().open)} dir={s().dir} />
            <DwRow label="High" value={fmtPrice(s().high)} dir={s().dir} />
            <DwRow label="Low" value={fmtPrice(s().low)} dir={s().dir} />
            <DwRow label="Close" value={fmtPrice(s().close)} dir={s().dir} />
            <DwRow
              label="Change"
              value={`${fmtSigned(s().changeAbs, priceDecimals(s().close))} (${fmtSigned(s().changePct, 2)}%)`}
              dir={s().changeAbs >= 0 ? "up" : "down"}
            />
            <DwRow label="Volume" value={s().volume != null ? fmtVolume(s().volume!) : "—"} />
          </div>
          <For each={s().indicators}>
            {(ind) => (
              <Show when={ind.plots.length > 0}>
                <div class="data-window-section">
                  <Show
                    when={ind.plots.length > 1}
                    fallback={
                      <DwRow label={ind.title} value={fmtVal(ind.plots[0].value)} color={ind.plots[0].color} />
                    }
                  >
                    <div class="data-window-header">
                      <span class="data-window-symbol">{ind.title}</span>
                    </div>
                    <For each={ind.plots}>
                      {(p, i) => <DwRow label={`#${i() + 1}`} value={fmtVal(p.value)} color={p.color} />}
                    </For>
                  </Show>
                </div>
              </Show>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}

type Props = {
  drawings: Drawing[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  onUpdate: (d: Drawing) => void;
  onRemove: (id: string) => void;
  /** Move a drawing to an absolute slot in this panel's display order. */
  onMove: (id: string, toDisplayIndex: number) => void;
  /** Clone the selected drawing — wired to the header copy-clone button. */
  onClone: (id: string) => void;
};

/** Local view of the persisted-but-untyped group tag. Drawings round-trip
 *  through JSON persistence, so the extra field survives; the Drawing type
 *  itself lives in window/drawings (owned by the chart side). */
type Grouped = Drawing & { group?: string };
const groupOf = (d: Drawing): string | null => (d as Grouped).group ?? null;
/** Copy of `d` with the group tag set (or removed, with undefined). */
function withGroup(d: Drawing, group: string | undefined): Drawing {
  const next: Grouped = { ...(d as Grouped) };
  if (group === undefined) delete next.group;
  else next.group = group;
  return next;
}

export function ObjectTreePanel(props: Props) {
  const [view, setView] = createSignal<View>("tree");
  // Alt+D (App) → show the Data window view, whether mounted already or just now.
  createEffect(() => {
    if (consumeDataWindowRequest()) setView("data-window");
  });
  // Drag-to-reorder state: the id being dragged + which row (and which half)
  // the cursor is currently over, for the insertion-line affordance.
  const [dragId, setDragId] = createSignal<string | null>(null);
  const [dragOver, setDragOver] = createSignal<{ id: string; below: boolean } | null>(null);

  function endDrag() {
    setDragId(null);
    setDragOver(null);
  }
  /** Drag over the row of object `id`: the insertion line shows when the
   *  dragged object can go there. */
  function dragOverRow(e: DragEvent & { currentTarget: HTMLElement }, id: string) {
    const from = dragId();
    const fromPane = from ? paneOfObject(from) : null;
    const toPane = paneOfObject(id);
    // In its own pane; a study can also go to another pane.
    const allowed =
      !!from && from !== id && fromPane !== null && toPane !== null &&
      (fromPane === toPane || sources().find((s) => s.id === from)?.kind === "study");
    if (!allowed) return setDragOver(null);
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setDragOver({ id, below: e.clientY - r.top > r.height / 2 });
  }
  /** Drop: the dragged object goes right above / below the row's object in
   *  the pane's drawing order (the focused chart applies and saves it). */
  function dropOnRow(e: DragEvent) {
    e.preventDefault();
    const from = dragId();
    const o = dragOver();
    if (from && o) requestMoveSource(from, o.id, o.below);
    endDrag();
  }

  function toggleLocked(d: Drawing) {
    props.onUpdate({ ...d, locked: !d.locked });
  }
  function toggleHidden(d: Drawing) {
    props.onUpdate({ ...d, hidden: !d.hidden });
  }

  // ── Manage mode ── per-row checkboxes + bulk actions over the checked set.
  const [manage, setManage] = createSignal(false);
  /** "Move to" menu position (null = closed). */
  const [moveMenu, setMoveMenu] = createSignal<{ x: number; y: number } | null>(null);
  /** "Clone, Copy" menu position (null = closed). */
  const [copyMenu, setCopyMenu] = createSignal<{ x: number; y: number } | null>(null);
  const selectedDrawing = () => props.drawings.find((d) => d.id === props.selectedId) ?? null;

  // Inline rename (the reference tree): a click on the already selected row
  // starts it after 500 ms (a double click in between does not); Enter or
  // leaving the field saves, Escape cancels, an empty name keeps the old one.
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  let renameTimer = 0;
  const cancelRenameTimer = () => {
    window.clearTimeout(renameTimer);
    renameTimer = 0;
  };
  onCleanup(cancelRenameTimer);
  const nameOf = (d: Drawing) => d.name ?? labelForKind(d.kind);
  const endRename = (d: Drawing, save: boolean, value: string) => {
    if (renamingId() !== d.id) return;
    setRenamingId(null);
    const v = value.trim();
    if (!save || !v || v === nameOf(d)) return;
    props.onUpdate({ ...d, name: v !== labelForKind(d.kind) ? v : undefined } as Drawing);
  };
  const [checked, setChecked] = createSignal<Set<string>>(new Set());
  const toggleManage = () => {
    setManage((m) => !m);
    setChecked(new Set<string>());
  };
  const toggleChecked = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  // Checked drawings that still exist (rows removed elsewhere drop out).
  const checkedDrawings = () => props.drawings.filter((d) => checked().has(d.id));

  // Bulk hide/lock: OFF→ON unless every checked row already has the flag.
  function bulkSet(field: "hidden" | "locked") {
    const targets = checkedDrawings();
    if (targets.length === 0) return;
    const on = !targets.every((d) => d[field]);
    for (const d of targets) props.onUpdate({ ...d, [field]: on });
  }
  function bulkDelete() {
    for (const d of checkedDrawings()) props.onRemove(d.id);
    setChecked(new Set<string>());
  }

  // ── Groups ── display order, topmost first (the render order below).
  const displayList = createMemo(() => props.drawings.slice().reverse());

  /** Name the checked drawings as a group and make them adjacent in display
   *  order (anchored at the topmost member), so they render contiguously
   *  under one header. */
  function makeGroup() {
    const ids = new Set(checkedDrawings().map((d) => d.id));
    if (ids.size < 2) return;
    const names = new Set(props.drawings.map(groupOf).filter(Boolean));
    let n = 1;
    let name = "Group 1";
    while (names.has(name)) name = `Group ${++n}`;
    for (const d of props.drawings.filter((d) => ids.has(d.id))) {
      props.onUpdate(withGroup(d, name));
    }
    // Adjacency: move each member to the slot after the anchor, re-reading the
    // display order between moves (onMove mutates it).
    const order = () => displayList().map((d) => d.id);
    const anchorSlot = order().findIndex((id) => ids.has(id));
    if (anchorSlot < 0) return;
    const members = order().filter((id) => ids.has(id));
    members.forEach((id, k) => {
      const cur = order().indexOf(id);
      const target = anchorSlot + k;
      if (cur !== target) props.onMove(id, target);
    });
    setManage(false);
    setChecked(new Set<string>());
  }

  function ungroup(name: string) {
    for (const d of props.drawings.filter((d) => groupOf(d) === name)) {
      props.onUpdate(withGroup(d, undefined));
    }
  }

  // ── Sources ── the focused chart's main series, studies and compared
  // symbols (object-tree-sources.ts), per pane, front source first.
  const sources = focusedTreeSources;
  /** Pane of an object (source or drawing) of the focused chart, or null. */
  const paneOfObject = (id: string): number | null =>
    focusedTreePanes().find((p) => p.items.some((x) => x.id === id))?.pane ?? null;
  /** Rows of every pane, front object first: a source, or a run of drawings
   *  between two sources (ids only, so the rows stay while a drawing is
   *  edited). */
  type Segment = { source: string } | { drawings: string[] };
  const paneSegments = createMemo<{ pane: number; segments: Segment[] }[]>(
    () =>
      focusedTreePanes().map((p) => {
        const segments: Segment[] = [];
        for (const it of p.items) {
          const last = segments[segments.length - 1];
          if (it.kind === "source") segments.push({ source: it.id });
          else if (last && "drawings" in last) last.drawings.push(it.id);
          else segments.push({ drawings: [it.id] });
        }
        return { pane: p.pane, segments };
      }),
    [],
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  const drawingById = createMemo(() => new Map(props.drawings.map((d) => [d.id, d])));

  /** One source row: hide for all, remove for studies and compared symbols.
   *  A drag puts it above / below another source of its pane (drawing order);
   *  a double click opens its settings. */
  const sourceRow = (s: TreeSource) => {
    const over = () => dragOver();
    const cls = () =>
      "object-tree-row is-draggable" +
      (s.kind === "series" ? " primary" : "") +
      (focusedStudySelection()?.id === s.id ? " selected" : "") +
      (s.hidden ? " hidden-state" : "") +
      (dragId() === s.id ? " dragging" : "") +
      (over()?.id === s.id ? (over()!.below ? " drag-over-below" : " drag-over-above") : "");
    return (
      <div
        class={cls()}
        data-name="object-tree-row"
        data-source-id={s.id}
        draggable={true}
        onClick={() => { if (s.kind !== "series") requestSelectStudy(s.id); }}
        onDblClick={() => {
          if (s.kind === "series") window.dispatchEvent(new CustomEvent("chart-open-settings"));
          else if (s.kind === "study") window.dispatchEvent(new CustomEvent("chart-open-study-settings", { detail: { id: s.id } }));
        }}
        onDragStart={(e) => {
          setDragId(s.id);
          e.dataTransfer?.setData("text/plain", s.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => dragOverRow(e, s.id)}
        onDrop={dropOnRow}
        onDragEnd={endDrag}
      >
        <span class="object-tree-row-icon" aria-hidden="true">
          <Show
            when={s.kind === "series"}
            fallback={<Icon name="header-indicators-metrics-and-strategies" size={18} />}
          >
            <span class="ot-ticker-logo ot-ticker-logo--sm">{s.title.trim().charAt(0).toUpperCase()}</span>
          </Show>
        </span>
        <span class="object-tree-row-label">{s.title}</span>
        <span class="object-tree-row-actions">
          <button
            type="button"
            data-name="hide"
            aria-label={s.hidden ? "Show" : "Hide"}
            aria-pressed={s.hidden}
            class="object-tree-row-action"
            title={s.hidden ? "Show" : "Hide"}
            onClick={(e) => { e.stopPropagation(); requestToggleSourceHidden(s.id); }}
          >
            <Icon name={s.hidden ? "draw-hide" : "draw-show"} size={18} />
          </button>
          <Show when={s.kind !== "series"}>
            <button
              type="button"
              data-name="remove"
              aria-label="Remove"
              class="object-tree-row-action"
              title="Remove"
              onClick={(e) => { e.stopPropagation(); requestRemoveSource(s.id); }}
            >
              <Icon name="draw-trash" size={18} />
            </button>
          </Show>
        </span>
      </div>
    );
  };

  /** Drawing rows of one pane (drag-to-reorder), topmost first. A contiguous
   *  run of same-`group` drawings renders under a shared group header. */
  const drawingRows = (list: () => Drawing[]) => (
    <For each={list()}>
              {(d, i) => {
                const isSelected = () => props.selectedId === d.id;
                const over = () => dragOver();
                const grp = () => groupOf(d);
                const headerFor = () => {
                  const g = grp();
                  if (!g) return null;
                  const prev = i() > 0 ? list()[i() - 1] : null;
                  return !prev || groupOf(prev) !== g ? g : null;
                };
                const cls = () =>
                  "object-tree-row is-draggable" +
                  (isSelected() ? " selected" : "") +
                  (grp() ? " in-group" : "") +
                  (d.hidden ? " hidden-state" : "") +
                  (d.locked ? " locked-state" : "") +
                  (dragId() === d.id ? " dragging" : "") +
                  (over()?.id === d.id
                    ? over()!.below
                      ? " drag-over-below"
                      : " drag-over-above"
                    : "");
                return (
                  <>
                  <Show when={headerFor()}>
                    {(g) => (
                      <div class="object-tree-group" data-name="object-tree-group">
                        <span class="object-tree-row-icon" aria-hidden="true">
                          <Icon name="ot-header-group" size={18} />
                        </span>
                        <span class="object-tree-group-label">{g()}</span>
                        <button
                          type="button"
                          class="object-tree-group-ungroup"
                          title="Ungroup"
                          aria-label={`Ungroup ${g()}`}
                          onClick={() => ungroup(g())}
                        >
                          Ungroup
                        </button>
                      </div>
                    )}
                  </Show>
                  <div
                    class={cls()}
                    role="button"
                    tabIndex={0}
                    data-name="object-tree-row"
                    draggable={!manage() && renamingId() !== d.id}
                    onClick={() => {
                      if (manage()) return toggleChecked(d.id);
                      if (renamingId() === d.id) return;
                      const wasSelected = isSelected();
                      props.setSelectedId(d.id);
                      cancelRenameTimer();
                      if (wasSelected) {
                        renameTimer = window.setTimeout(() => {
                          renameTimer = 0;
                          if (props.selectedId === d.id) setRenamingId(d.id);
                        }, 500);
                      }
                    }}
                    onDblClick={cancelRenameTimer}
                    onDragStart={(e) => {
                      setDragId(d.id);
                      e.dataTransfer?.setData("text/plain", d.id);
                      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => dragOverRow(e, d.id)}
                    onDrop={dropOnRow}
                    onDragEnd={endDrag}
                  >
                    <Show when={manage()}>
                      <input
                        class="object-tree-row-check"
                        type="checkbox"
                        checked={checked().has(d.id)}
                        aria-label="Select drawing"
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleChecked(d.id)}
                      />
                    </Show>
                    <span class="object-tree-row-icon" aria-hidden="true">
                      <Icon name={iconForKind(d.kind)} size={18} />
                    </span>
                    <Show when={renamingId() === d.id} fallback={<span class="object-tree-row-label">{nameOf(d)}</span>}>
                      <input
                        ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                        class="object-tree-rename-input"
                        type="text"
                        value={nameOf(d)}
                        spellcheck={false}
                        autocomplete="off"
                        aria-label="Rename"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Escape") { e.preventDefault(); endRename(d, false, ""); }
                          else if (e.key === "Enter") { e.preventDefault(); endRename(d, true, e.currentTarget.value); }
                        }}
                        onBlur={(e) => endRename(d, true, e.currentTarget.value)}
                      />
                    </Show>
                    <span class="object-tree-row-actions">
                      <button
                        type="button"
                        data-name="lock"
                        aria-label={d.locked ? "Unlock" : "Lock"}
                        aria-pressed={!!d.locked}
                        class="object-tree-row-action"
                        title={d.locked ? "Unlock" : "Lock"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleLocked(d);
                        }}
                      >
                        <Icon name="draw-lock" size={18} />
                      </button>
                      <button
                        type="button"
                        data-name="hide"
                        aria-label={d.hidden ? "Show" : "Hide"}
                        aria-pressed={!!d.hidden}
                        class="object-tree-row-action"
                        title={d.hidden ? "Show" : "Hide"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleHidden(d);
                        }}
                      >
                        <Icon name={d.hidden ? "draw-hide" : "draw-show"} size={18} />
                      </button>
                      <button
                        type="button"
                        data-name="remove"
                        aria-label="Remove"
                        class="object-tree-row-action"
                        title="Remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onRemove(d.id);
                        }}
                      >
                        <Icon name="draw-trash" size={18} />
                      </button>
                    </span>
                  </div>
                  </>
                );
              }}
            </For>
  );

  return (
    <aside class="ot-rail-panel object-tree-panel" aria-label="Object tree">
      {/* Stacked header: the Object tree / Data window toggle on top, the
          action icons in a toolbar row directly below it. */}
      <PanelHeader
        ariaLabel="Object tree header"
        left={
          <SegmentedControl<View>
            items={TABS}
            value={view()}
            onChange={setView}
            ariaLabel="Object tree view"
          />
        }
      />
      <div class="object-tree-toolbar" data-name="object-tree-toolbar">
        <Tooltip text="Create a group of drawings" side="bottom">
          <IconButton
            data-name="group-button"
            aria-label="Create a group of drawings"
            disabled={!manage() || checked().size < 2}
            onClick={makeGroup}
          >
            <Icon name="ot-header-group" size={18} />
          </IconButton>
        </Tooltip>
        {/* Clone, Copy: a menu with Copy (the drawing clipboard, as Ctrl+C)
            and Clone, for the selected drawing. */}
        <Tooltip text="Clone, Copy" side="bottom">
          <IconButton
            data-name="copy-clone-button"
            aria-label="Clone, Copy"
            aria-expanded={!!copyMenu()}
            disabled={!selectedDrawing()}
            onClick={(e: MouseEvent) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setCopyMenu(copyMenu() ? null : { x: r.left, y: r.bottom + 2 });
            }}
          >
            <Icon name="ot-header-copy-clone" size={18} />
          </IconButton>
        </Tooltip>
        <Show when={copyMenu()}>
          {(m) => (
            <ChartContextMenu
              x={m().x}
              y={m().y}
              onClose={() => setCopyMenu(null)}
              nodes={[
                { kind: "item", id: "copy", label: "Copy",
                  onSelect: () => { const d = selectedDrawing(); if (d) copyDrawing(d); } },
                { kind: "item", id: "clone", label: "Clone",
                  onSelect: () => { const d = selectedDrawing(); if (d) props.onClone(d.id); } },
              ]}
            />
          )}
        </Show>
        {/* Move to: the selected study (shared with the chart selection)
            to a new pane above / below its pane. */}
        <Tooltip text="Move to" side="bottom">
          <IconButton
            data-name="move-to-button"
            aria-label="Move to"
            aria-expanded={!!moveMenu()}
            disabled={!focusedStudySelection()?.moveAbove && !focusedStudySelection()?.moveBelow}
            onClick={(e: MouseEvent) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMoveMenu(moveMenu() ? null : { x: r.left, y: r.bottom + 2 });
            }}
          >
            <Icon name="ot-header-move-to" size={18} />
          </IconButton>
        </Tooltip>
        <Show when={moveMenu()}>
          {(m) => (
            <ChartContextMenu
              x={m().x}
              y={m().y}
              onClose={() => setMoveMenu(null)}
              nodes={[
                { kind: "item", id: "new-pane-above", label: "New pane above", disabled: !focusedStudySelection()?.moveAbove,
                  onSelect: () => { const s = focusedStudySelection(); if (s) requestMoveStudy(s.id, "above"); } },
                { kind: "item", id: "new-pane-below", label: "New pane below", disabled: !focusedStudySelection()?.moveBelow,
                  onSelect: () => { const s = focusedStudySelection(); if (s) requestMoveStudy(s.id, "below"); } },
              ]}
            />
          )}
        </Show>
        <Tooltip text="Manage layout drawings" side="bottom">
          <IconButton
            data-name="manage-drawings-button"
            aria-label="Manage layout drawings"
            aria-pressed={manage() || undefined}
            disabled={props.drawings.length === 0 && !manage()}
            onClick={toggleManage}
          >
            <Icon name="ot-header-manage-drawings" size={18} />
          </IconButton>
        </Tooltip>

        {/* Bulk actions over the checked set (manage mode only). */}
        <Show when={manage()}>
          <span class="object-tree-toolbar-count">{checked().size} selected</span>
          <Tooltip text="Hide / show checked" side="bottom">
            <IconButton
              data-name="bulk-hide-button"
              aria-label="Hide or show checked drawings"
              disabled={checked().size === 0}
              onClick={() => bulkSet("hidden")}
            >
              <Icon name="draw-hide" size={18} />
            </IconButton>
          </Tooltip>
          <Tooltip text="Lock / unlock checked" side="bottom">
            <IconButton
              data-name="bulk-lock-button"
              aria-label="Lock or unlock checked drawings"
              disabled={checked().size === 0}
              onClick={() => bulkSet("locked")}
            >
              <Icon name="draw-lock" size={18} />
            </IconButton>
          </Tooltip>
          <Tooltip text="Remove checked" side="bottom">
            <IconButton
              data-name="bulk-remove-button"
              aria-label="Remove checked drawings"
              disabled={checked().size === 0}
              onClick={bulkDelete}
            >
              <Icon name="draw-trash" size={18} />
            </IconButton>
          </Tooltip>
        </Show>
      </div>
      <div class="object-tree-panel-body">
        <Show when={view() === "tree"} fallback={<DataWindow />}>
            {/* Empty hint only when nothing at all is on the chart. */}
            <Show when={paneSegments().every((p) => p.segments.length === 0)}>
              <div class="ot-empty-state object-tree-panel-empty">No objects yet.</div>
            </Show>

            {/* One block per chart pane (a line between two panes): its
                sources and drawings in the pane's drawing order, front first. */}
            <For each={paneSegments()}>
              {(p, k) => (
                <>
                  <Show when={k() > 0}>
                    <div class="object-tree-separator" role="separator" />
                  </Show>
                  <For each={p.segments}>
                    {(seg) =>
                      "source" in seg ? (
                        <Show when={sources().find((x) => x.id === seg.source)} keyed>
                          {sourceRow}
                        </Show>
                      ) : (
                        drawingRows(() => seg.drawings.map((id) => drawingById().get(id)).filter((d): d is Drawing => !!d))
                      )
                    }
                  </For>
                </>
              )}
            </For>
        </Show>
      </div>
    </aside>
  );
}
