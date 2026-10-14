/*
 * Panes of a chart view: their boxes, the panes the drawings live in, and the
 * pane controls (move up / down, delete, collapse / restore).
 */
import { For, Show, createMemo, createSignal, untrack } from "solid-js";
import { Tooltip } from "../../../components/Tooltip";
import { studyPaneCoords, type DrawingPane } from "../../drawings/pane-coords";
import { PANE_ICONS } from "./pane-icons";
import { type ChartCx } from "./context";
import type { Accessor, JSX, Setter } from "solid-js";

// ── Pane controls (Canvas → Buttons → Pane) ───────────────────────────
// Pane controls: shown on a pane while the pointer
// is over it (or always / never), only with more than one pane. 24 px
// buttons 4 px apart, 4 px from the pane top and the price axis; a pane
// narrower than 666.65 px shows the single "Manage panes" button (menu),
// narrower than 356 px none. Buttons: move up / down (study panes; the
// price pane stays on top here), delete (study panes), collapse (to
// max(2·4 + 24, 33) px) / restore. "Maximize pane" is not offered: it would
// hide the other panes, and the chart library keeps every pane ≥ ~30 px.
export type PaneBox = { index: number; top: number; height: number };

/** What createPanes adds to the chart context. */
export interface PanesApi {
  PaneControls: () => JSX.Element;
  collapsedPanes: Accessor<Map<number, number>>;
  deletePane: (i: number) => void;
  drawingPanes: Accessor<DrawingPane[]>;
  movePane: (i: number, dir: -1 | 1) => void;
  paneActions: (i: number) => {
    up: boolean;
    down: boolean;
    close: boolean;
    collapse: boolean;
    restore: boolean;
  };
  paneAtY: (y: number) => number | null;
  paneBoxes: Accessor<PaneBox[]>;
  paneEpoch: Accessor<number>;
  refreshPaneBoxes: () => void;
  setCollapsedPanes: Setter<Map<number, number>>;
  setHoverPane: Setter<number | null>;
  setPaneEpoch: Setter<number>;
  toggleCollapse: (i: number) => void;
}

export function createPanes(cx: ChartCx): PanesApi {
  const { appearance, coords, props, refreshIndicatorLegend } = cx;
  const [paneBoxes, setPaneBoxes] = createSignal<PaneBox[]>([]);
  const [hoverPane, setHoverPane] = createSignal<number | null>(null);
  const [collapsedPanes, setCollapsedPanes] = createSignal<Map<number, number>>(new Map());
  const PANE_COLLAPSED_H = 33;
  function refreshPaneBoxes() {
    if (!cx.chart || !cx.paneRoot) return;
    const root = cx.paneRoot.getBoundingClientRect();
    const boxes: PaneBox[] = cx.chart.panes().map((pn, index) => {
      const el = pn.getHTMLElement();
      const r = el ? el.getBoundingClientRect() : null;
      return { index, top: r ? r.top - root.top : 0, height: r ? r.height : pn.getHeight() };
    });
    setPaneBoxes((prev) => (JSON.stringify(prev) === JSON.stringify(boxes) ? prev : boxes));
  }
  function paneAtY(y: number): number | null {
    for (const b of paneBoxes()) if (y >= b.top && y < b.top + b.height) return b.index;
    return null;
  }
  // Panes the drawings live in (Drawing.owner): pane 0 = the main series, a
  // study pane = its first study, with that pane's price scale. Rebuilt when
  // the pane boxes, the studies or their panes change.
  const [paneEpoch, setPaneEpoch] = createSignal(0);
  /** Studies that own a drawing (Drawing.owner). */
  const drawingOwners = createMemo<string[]>(
    () => [...new Set((props.drawings ?? []).map((d) => d.owner).filter((x): x is string => !!x))].sort(),
    [],
    { equals: (a, b) => a.join(",") === b.join(",") },
  );
  const drawingPanes = createMemo<DrawingPane[]>(() => {
    const main = coords();
    const boxes = paneBoxes();
    void paneEpoch();
    if (!main) return [];
    const out: DrawingPane[] = [];
    for (const b of boxes) {
      if (b.index === 0) {
        out.push({ key: null, top: b.top, height: b.height, coords: main });
        continue;
      }
      const owner = untrack(() => cx.controller?.ownerOfPane(b.index) ?? null);
      if (!owner) continue;
      out.push({
        key: owner,
        top: b.top,
        height: b.height,
        coords: studyPaneCoords(main, () => cx.controller?.studySeries(owner) ?? null, (sec) => cx.controller?.paneValuesAt(owner, sec) ?? []),
      });
    }
    // A study that owns drawings and is not the first of its pane (it was
    // moved to another pane): its drawings follow it, on its own scale.
    for (const id of drawingOwners()) {
      if (out.some((p) => p.key === id)) continue;
      const pane = untrack(() => cx.controller?.paneOf(id) ?? null);
      const b = pane === null ? undefined : boxes.find((x) => x.index === pane);
      if (!b) continue;
      out.push({
        key: id,
        top: b.top,
        height: b.height,
        coords: studyPaneCoords(main, () => cx.controller?.studySeries(id) ?? null, (sec) => cx.controller?.paneValuesAt(id, sec) ?? []),
      });
    }
    return out;
  });
  function movePane(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (!cx.controller || i < 1 || j < 1 || j >= (cx.chart?.panes().length ?? 0)) return;
    const a = cx.controller.idsInPane(i);
    const b = cx.controller.idsInPane(j);
    cx.controller.swapPanes(i, j);
    props.onPaneOrder?.(cx.controller.stackedOrder());
    setPaneEpoch((n) => n + 1);
    refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
    // Persist: stacked panes are claimed in list order, so swap the two
    // panes' studies in the pane's indicator list.
    const list = [...(props.indicators ?? [])];
    const posA = a.map((id) => list.indexOf(id)).filter((k) => k >= 0);
    const posB = b.map((id) => list.indexOf(id)).filter((k) => k >= 0);
    if (posA.length && posB.length) {
      // The combined slots now hold the upper pane's studies first.
      const slots = [...posA, ...posB].sort((x, y) => x - y);
      const ordered = dir > 0 ? [...b, ...a] : [...a, ...b];
      slots.forEach((slot, k) => { list[slot] = ordered[k]; });
      props.onReorderIndicators?.(list);
    }
    setCollapsedPanes(new Map());
    queueMicrotask(refreshPaneBoxes);
  }
  function deletePane(i: number) {
    if (!cx.controller) return;
    for (const id of cx.controller.idsInPane(i)) {
      if (cx.compareEntry(id)) props.onRemoveCompare?.(id);
      else props.onRemoveIndicator?.(id);
    }
  }
  function toggleCollapse(i: number) {
    if (!cx.chart) return;
    const pn = cx.chart.panes()[i];
    if (!pn) return;
    const m = new Map(collapsedPanes());
    if (m.has(i)) { pn.setHeight(m.get(i)!); m.delete(i); }
    else { m.set(i, pn.getHeight()); pn.setHeight(PANE_COLLAPSED_H); }
    setCollapsedPanes(m);
    queueMicrotask(refreshPaneBoxes);
  }
  const paneActions = (i: number) => {
    const n = cx.chart?.panes().length ?? 0;
    const collapsed = collapsedPanes().has(i);
    const othersOpen = paneBoxes().some((b) => b.index !== i && !collapsedPanes().has(b.index));
    return {
      up: i >= 2,
      down: i >= 1 && i < n - 1,
      close: i >= 1,
      collapse: !collapsed && othersOpen,
      restore: collapsed,
    };
  };

  function PaneControls() {
    return (
      <Show when={cx.scaleGeom() && paneBoxes().length > 1 && (cx.host?.clientWidth ?? 0) >= 356}>
        <For each={paneBoxes()}>
          {(b) => {
            const shown = () => {
              const mode = appearance().paneButtons ?? "visibleOnMouseOver";
              return mode === "alwaysOn" || (mode === "visibleOnMouseOver" && hoverPane() === b.index);
            };
            const compact = () => (cx.host?.clientWidth ?? 0) < 666.65;
            const a = () => paneActions(b.index);
            // Pane buttons: common tooltip; collapse / restore carry the
            // "Ctrl + Double click" hint (data-tooltip-hotkey). The tooltip
            // side is not verified.
            const btn = (svg: string, title: string, run: () => void, active = false, hint = false) => (
              <Tooltip text={title} hotkey={hint ? "Ctrl" : undefined} hotkeyText={hint ? "{0} + Double click" : undefined} side="bottom">
                <div class={`ot-pane-btn${active ? " is-active" : ""}`} aria-label={title} onMouseDown={(e) => e.stopPropagation()} onClick={run} innerHTML={svg} />
              </Tooltip>
            );
            return (
              <Show when={shown()}>
                <div class="ot-pane-controls" style={{ top: `${b.top + 4}px`, [cx.scaleGeom()!.left ? "left" : "right"]: `${cx.scaleGeom()!.w + 4}px` }}>
                  <Show
                    when={!compact()}
                    fallback={
                      <Tooltip text="Manage panes" side="bottom">
                        <div class="ot-pane-btn" aria-label="Manage panes" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => cx.openPaneMenu(e, b.index)} innerHTML={PANE_ICONS.more} />
                      </Tooltip>
                    }
                  >
                    <Show when={a().up}>{btn(PANE_ICONS.up, "Move pane up", () => movePane(b.index, -1))}</Show>
                    <Show when={a().down}>{btn(PANE_ICONS.down, "Move pane down", () => movePane(b.index, 1))}</Show>
                    <Show when={a().close}>{btn(PANE_ICONS.close, "Delete pane", () => deletePane(b.index))}</Show>
                    <Show when={a().collapse}>{btn(PANE_ICONS.collapse, "Collapse pane", () => toggleCollapse(b.index), false, true)}</Show>
                    <Show when={a().restore}>{btn(PANE_ICONS.restore, "Restore pane", () => toggleCollapse(b.index), true, true)}</Show>
                  </Show>
                </div>
              </Show>
            );
          }}
        </For>
      </Show>
    );
  }

  return {
    PaneControls,
    collapsedPanes,
    deletePane,
    drawingPanes,
    movePane,
    paneActions,
    paneAtY,
    paneBoxes,
    paneEpoch,
    refreshPaneBoxes,
    setCollapsedPanes,
    setHoverPane,
    setPaneEpoch,
    toggleCollapse,
  };
}
