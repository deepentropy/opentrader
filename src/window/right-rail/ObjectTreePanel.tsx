/*
 * ObjectTreePanel — right-rail "object_tree" tab content.
 *
 * Feature 5c (current): real-data drawing rows backed by App's drawings
 * array. Row click selects the drawing on the chart; per-row icons
 * toggle lock / hide / remove. This is the only UI that can unhide an
 * individually-hidden drawing — without it, the per-drawing Hide flag
 * is a one-way trip.
 *
 * Drag-to-reorder: rows are HTML5-draggable; dropping above/below another row
 * moves the drawing's z-order via App's moveDrawing (display order = topmost
 * first = reverse of the array).
 *
 * Rows: a chart-source primary row, then the active indicators (label from the
 * registry; remove via the chart's global indicators list), then the drawings.
 *
 * Header toolbar: copy-clone is wired to App's cloneDrawing (clones the selected
 * drawing). Manage toggles a management mode: per-row checkboxes plus bulk
 * hide / lock / delete over the checked set (each op routed through the same
 * per-item onUpdate/onRemove callbacks the row icons use). Group names the
 * checked drawings (a `group` tag persisted on each drawing via onUpdate) and
 * makes them adjacent, so they render under a shared header with an Ungroup
 * action. Move-to stays disabled pending multi-layout targets.
 *
 * Deferred (vs. the mock):
 *   • move-to action (needs multi-layout targets).
 *   • Per-indicator hide + settings rows.
 *   • Data window tab — depends on indicators; placeholder for now.
 */
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { PanelHeader } from "../../components/PanelHeader";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Icon, type IconName } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Tooltip } from "../../components/Tooltip";
import { labelForKind, iconForKind } from "../drawings/labels";
import { getIndicatorEntry } from "../chart/indicators/registry";
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
  /** Active indicator registry ids — listed below the chart-source row. */
  indicators: string[];
  onRemoveIndicator: (id: string) => void;
  /** Chart-source label (e.g. "INTC, 1D") for the primary top row. */
  chartSource?: string;
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
  const [dragOver, setDragOver] = createSignal<{ index: number; below: boolean } | null>(null);

  function endDrag() {
    setDragId(null);
    setDragOver(null);
  }

  function toggleLocked(d: Drawing) {
    props.onUpdate({ ...d, locked: !d.locked });
  }
  function toggleHidden(d: Drawing) {
    props.onUpdate({ ...d, hidden: !d.hidden });
  }

  // ── Manage mode ── per-row checkboxes + bulk actions over the checked set.
  const [manage, setManage] = createSignal(false);
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
        <Tooltip text="Clone, Copy" side="bottom">
          <IconButton
            data-name="copy-clone-button"
            aria-label="Clone, Copy"
            disabled={!props.selectedId}
            onClick={() => {
              const id = props.selectedId;
              if (id) props.onClone(id);
            }}
          >
            <Icon name="ot-header-copy-clone" size={18} />
          </IconButton>
        </Tooltip>
        <Tooltip text="Move to" side="bottom">
          <IconButton data-name="move-to-button" aria-label="Move to" disabled>
            <Icon name="ot-header-move-to" size={18} />
          </IconButton>
        </Tooltip>
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
            {/* Chart-source primary row — the symbol/interval the chart renders.
                Icon is the symbol's logo badge (the instrument logo), not a
                colour swatch. */}
            <Show when={props.chartSource}>
              {(src) => (
                <div class="object-tree-row primary" data-name="object-tree-row">
                  <span class="object-tree-row-icon" aria-hidden="true">
                    <span class="ot-ticker-logo ot-ticker-logo--sm">
                      {src().trim().charAt(0).toUpperCase()}
                    </span>
                  </span>
                  <span class="object-tree-row-label">{src()}</span>
                </div>
              )}
            </Show>

            {/* Indicator rows — label from the registry; remove via the chart's
                global indicators list. No lock/hide (indicators have no per-row
                hidden state yet). */}
            <For each={props.indicators}>
              {(id) => (
                <div class="object-tree-row" data-name="object-tree-row">
                  <span class="object-tree-row-icon" aria-hidden="true">
                    <Icon name="header-indicators-metrics-and-strategies" size={18} />
                  </span>
                  <span class="object-tree-row-label">{getIndicatorEntry(id)?.name ?? id}</span>
                  <span class="object-tree-row-actions">
                    <button
                      type="button"
                      data-name="remove"
                      aria-label="Remove indicator"
                      class="object-tree-row-action"
                      title="Remove"
                      onClick={() => props.onRemoveIndicator(id)}
                    >
                      <Icon name="draw-trash" size={18} />
                    </button>
                  </span>
                </div>
              )}
            </For>

            {/* Empty hint only when nothing at all is on the chart. */}
            <Show when={!props.chartSource && props.indicators.length === 0 && props.drawings.length === 0}>
              <div class="ot-empty-state object-tree-panel-empty">No objects yet.</div>
            </Show>

            {/* Drawing rows (drag-to-reorder), topmost first. A contiguous run
                of same-`group` drawings renders under a shared group header. */}
            <For each={displayList()}>
              {(d, i) => {
                const isSelected = () => props.selectedId === d.id;
                const over = () => dragOver();
                const grp = () => groupOf(d);
                const headerFor = () => {
                  const g = grp();
                  if (!g) return null;
                  const prev = i() > 0 ? displayList()[i() - 1] : null;
                  return !prev || groupOf(prev) !== g ? g : null;
                };
                const cls = () =>
                  "object-tree-row is-draggable" +
                  (isSelected() ? " selected" : "") +
                  (grp() ? " in-group" : "") +
                  (d.hidden ? " hidden-state" : "") +
                  (d.locked ? " locked-state" : "") +
                  (dragId() === d.id ? " dragging" : "") +
                  (over()?.index === i()
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
                    draggable={!manage()}
                    onClick={() => (manage() ? toggleChecked(d.id) : props.setSelectedId(d.id))}
                    onDragStart={(e) => {
                      setDragId(d.id);
                      e.dataTransfer?.setData("text/plain", d.id);
                      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      if (!dragId() || dragId() === d.id) return;
                      e.preventDefault();
                      const r = e.currentTarget.getBoundingClientRect();
                      setDragOver({ index: i(), below: e.clientY - r.top > r.height / 2 });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragId();
                      const o = dragOver();
                      if (from && o) props.onMove(from, o.below ? o.index + 1 : o.index);
                      endDrag();
                    }}
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
                    <span class="object-tree-row-label">{labelForKind(d.kind)}</span>
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
        </Show>
      </div>
    </aside>
  );
}
