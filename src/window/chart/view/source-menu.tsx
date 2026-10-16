/*
 * Rows of the study and compared-symbol menus (legend "More", right click on
 * a plot) that act on the source itself:
 *   "Add this indicator / strategy / symbol to entire layout" (charts of a
 *   multi-chart layout), "Visual order" > (front / back / one step among the
 *   objects of its pane), "Visibility on intervals" > (the four quick
 *   settings of its Visibility tab), "Move to" > (pane above / below, new
 *   pane above / below), "Pin to scale (now …)" > (the left / right scale of
 *   its pane, a new one on a free side, no scale),
 *   "Copy" (Ctrl + C; the chart menu's Paste adds a copy to a chart).
 * Reference rules: study menu actions of the reference chart (Pin to scale
 * rows name the scales A, B... on the right, Z, Y... on the left once the
 * chart has two scales or more). Not here (missing feature): financial
 * metrics.
 */
import { Icon } from "../../../components/Icon";
import { sourcesEdit } from "../../shell/source-edits";
import { splitSymbol } from "../../../data/datafeed";
import { emitAppEvent, type ChildStudyParent } from "../../../data/app-events";
import { canHaveChildren, parseSourceRef, plotChoices, sourceRef } from "../indicators/study-sources";
import { CtxIcons } from "../ChartContextMenu";
import { copySource, type ClipboardSource } from "../../drawings/clipboard";
import { splitTitle } from "../IndicatorLegend";
import { getIndicatorEntry } from "../indicators/registry";
import { isStrategyId } from "../indicators/strategy-entries";
import { typeIdOf } from "../indicators/study-id";
import type { StudyScale } from "../indicators/indicator-options";
import { scaleLetter } from "../scales/scale-layout";
import { visibilityForMode, type IntervalsVisibilityMode } from "../interval-visibility-mode";
import type { CtxNode } from "../ChartContextMenu";
import type { StudyMoves, ZOrderOp } from "./sources";
import { type ChartCx } from "./context";
import { MAIN_SOURCE_ID } from "../object-tree-sources";

/** What createSourceMenu adds to the chart context. */
export interface SourceMenuApi {
  /** Copy a study / compared symbol to the clipboard (menu "Copy", Ctrl+C). */
  copySourceOf: (id: string) => void;
  /** "Add this … to entire layout" row; null in a single-chart layout. */
  sourceLayoutRow: (id: string) => CtxNode | null;
  /** Visual order, Visibility on intervals, Move to, Pin to scale rows. */
  sourceArrangeRows: (id: string) => CtxNode[];
  /** Main series menu: Visual order, Move to, Pin to scale rows. */
  seriesArrangeRows: () => CtxNode[];
  /** "Copy" row. */
  sourceCopyRow: (id: string) => CtxNode;
  /** "Add indicator/strategy on <source>…" row (a study / compared symbol that can be a source), or null. */
  addOnSourceRow: (id: string) => CtxNode | null;
  /** Choices of a study's Source inputs after the price sources: the other sources' outputs. */
  sourceChoicesFor: (id: string) => { value: string; label: string }[];
  /** Name of a source input value naming another source, null for a price source. */
  sourceInputText: (v: string) => string | null;
}

type Item = Extract<CtxNode, { kind: "item" }>;

/** "Pin to scale" icon (an axis with its scale marks and a pin). */
const PIN_ICON = () => (
  <svg viewBox="0 0 28 28" width="18" height="18" fill="none" stroke="currentColor">
    <path d="M19.5 4v20M19.5 8h3M19.5 14h3M19.5 20h3" />
    <path d="M6.5 14h9M12.5 11l3 3-3 3" />
    <circle cx="6.5" cy="14" r="2" />
  </svg>
);



// Undo texts of the source edits (reference undo commands).
const Z_UNDO: Record<ZOrderOp, (title: string) => string> = {
  front: (t) => `bring ${t} to front`,
  back: (t) => `send ${t} to back`,
  forward: (t) => `bring ${t} forward`,
  backward: (t) => `send ${t} backward`,
};
const VISIBILITY_UNDO: Record<IntervalsVisibilityMode, string> = {
  currentAndAbove: "change visibility at current interval and above",
  currentAndBelow: "change visibility at current interval and below",
  current: "change visibility at current interval",
  all: "change visibility at all intervals",
};
const MOVE_UNDO: Record<keyof StudyMoves, string> = {
  mergeUp: "merge up",
  mergeDown: "merge down",
  unmergeUp: "unmerge up",
  unmergeDown: "unmerge down",
};

export function createSourceMenu(cx: ChartCx): SourceMenuApi {
  /** A source's title as its legend shows it (the undo texts name it). */
  const sourceTitle = (id: string) =>
    id === MAIN_SOURCE_ID ? splitSymbol(props.symbol ?? "").ticker : cx.indLegend().find((r) => r.id === id)?.title ?? cx.compareEntry(id)?.symbol ?? "";
  const { props } = cx;

  /** The clipboard / layout payload of a source. */
  function sourceOf(id: string): ClipboardSource | null {
    const cmp = cx.compareEntry(id);
    if (cmp) return { kind: "compare", title: cx.compareTitle(cmp), entry: JSON.parse(JSON.stringify(cmp)) };
    const c = cx.controller;
    const row = cx.indLegend().find((r) => r.id === id);
    if (!c || !row) return null;
    return {
      kind: "study",
      typeId: typeIdOf(id),
      title: splitTitle(row.title).name || getIndicatorEntry(id)?.name || id,
      settings: {
        inputs: { ...(c.getInputs(id) ?? {}) },
        styles: JSON.parse(JSON.stringify(c.getStyles(id) ?? {})),
        options: c.getOptions(id),
        ...(c.isHidden(id) ? { hidden: true } : {}),
      },
    };
  }

  function copySourceOf(id: string) {
    const src = sourceOf(id);
    if (src) copySource(src);
  }

  function sourceLayoutRow(id: string): CtxNode | null {
    if ((props.layoutCount ?? 1) < 2) return null;
    // Not for a study calculated on another source (reference).
    if (cx.controller?.parentsOfStudy(id).length) return null;
    const cmp = cx.compareEntry(id);
    const label = cmp ? "Add this symbol to entire layout" : isStrategyId(id) ? "Add this strategy to entire layout" : "Add this indicator to entire layout";
    return {
      kind: "item", id: "entire-layout", label,
      onSelect: () => {
        const source = sourceOf(id);
        if (!source) return;
        if (cmp) {
          const pane = cmp.placement === "pane" ? cx.compareLayers.get(id)?.paneIndex ?? 1 : 0;
          emitAppEvent("chart-add-to-layout", { source, place: { main: pane === cx.mainPane(), paneIndex: pane, asCompare: cmp.placement === "percent" } });
          return;
        }
        const pane = cx.controller?.paneOf(id) ?? 0;
        emitAppEvent("chart-add-to-layout", { source, place: { main: pane === cx.mainPane(), paneIndex: pane } });
      },
    };
  }

  // ── Visual order ───────────────────────────────────────────────────────
  function visualOrderRow(id: string): CtxNode | null {
    const steps = cx.zOrderSteps(id);
    if (!steps) return null;
    const row = (op: ZOrderOp, label: string, enabled: boolean): CtxNode => ({
      kind: "item", id: `z-${op}`, label, disabled: !enabled, onSelect: () => sourcesEdit(Z_UNDO[op](sourceTitle(id)), () => cx.moveZ(id, op)),
    });
    return {
      kind: "item", id: "visual-order", label: "Visual order", icon: <Icon name="dt-cm-visual-order" size={18} />,
      submenu: [
        row("front", "Bring to front", steps.front),
        row("back", "Send to back", steps.back),
        row("forward", "Bring forward", steps.front),
        row("backward", "Send backward", steps.back),
      ],
    };
  }

  // ── Visibility on intervals ────────────────────────────────────────────
  function setVisibility(id: string, mode: IntervalsVisibilityMode) {
    const visibility = visibilityForMode(props.interval ?? "1D", mode);
    const cmp = cx.compareEntry(id);
    if (cmp) {
      props.onCompareChange?.(id, { style: { ...cmp.style, visibility } });
      return;
    }
    const c = cx.controller;
    if (!c) return;
    const inputs = c.getInputs(id) ?? {};
    const styles = c.getStyles(id) ?? {};
    const options = { ...c.getOptions(id), visibility };
    c.applySettings(id, inputs, styles, options);
    props.onIndicatorSettings?.(id, { inputs, styles, options });
    cx.refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
  }
  function visibilityRow(id: string): CtxNode {
    const row = (mode: IntervalsVisibilityMode, label: string): CtxNode => ({
      kind: "item", id: `vis-${mode}`, label, onSelect: () => sourcesEdit(VISIBILITY_UNDO[mode], () => setVisibility(id, mode)),
    });
    return {
      kind: "item", id: "visibility-intervals", label: "Visibility on intervals",
      submenu: [
        row("currentAndAbove", "Current interval and above"),
        row("currentAndBelow", "Current interval and below"),
        row("current", "Current interval only"),
        row("all", "All intervals"),
      ],
    };
  }

  // ── Move to ────────────────────────────────────────────────────────────
  function moveToRow(id: string): CtxNode | null {
    const moves = cx.studyMoves(id);
    if (!moves) return null;
    const rows: [keyof StudyMoves, string][] = [
      ["mergeUp", "Existing pane above"],
      ["unmergeUp", "New pane above"],
      ["mergeDown", "Existing pane below"],
      ["unmergeDown", "New pane below"],
    ];
    const submenu = rows.filter(([k]) => moves[k]).map(([k, label]): CtxNode => ({
      kind: "item", id: `move-${k}`, label, onSelect: () => sourcesEdit(MOVE_UNDO[k], () => cx.moveStudy(id, k)),
    }));
    if (!submenu.length) return null;
    return { kind: "item", id: "move-to", label: "Move to", icon: <Icon name="ot-header-move-to" size={18} />, submenu };
  }

  // ── Pin to scale ───────────────────────────────────────────────────────
  // Reference rules (its source menu): the right scales of the pane, then a
  // new right scale, a separator, the left scales, a new left scale, a
  // separator, "No scale (fullscreen)". Scales are named by letter once the
  // chart has two scales or more ("Pin to scale B"), else by side. A new
  // scale is offered while the pane has room (8 scales) and the source shares
  // its scale or is on the other side; it is named when another pane already
  // has a scale at that place. No scale: off for the last source on a scale.
  function pinTo(id: string, scale: StudyScale) {
    const c = cx.controller;
    if (!c) return;
    const options = c.pinToScale(id, scale);
    if (!options) return;
    props.onIndicatorSettings?.(id, { inputs: c.getInputs(id) ?? {}, styles: c.getStyles(id) ?? {}, options });
    cx.syncSideScales();
    cx.syncScaleLayout();
    cx.refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
  }
  function pinRow(id: string): CtxNode | null {
    const c = cx.controller;
    const cur = c?.scaleOf(id) ?? null;
    const pane = c?.paneOf(id) ?? null;
    if (!c || !cur || pane === null) return null;
    return pinRowFor(id, cur, pane, (scale) => pinTo(id, scale));
  }
  /** The "Pin to scale" row of a source on scale `cur` of pane `pane`; `pin` moves it. */
  function pinRowFor(id: string, cur: StudyScale, pane: number, pin: (scale: StudyScale) => void): CtxNode {
    const lay = cx.scaleLayout();
    const counts = lay.slotCounts();
    const named = counts.total > 1;
    const right = lay.scales(pane, "right");
    const left = lay.scales(pane, "left");
    const curSlot = cur === "none" ? null : lay.slotOf(pane, cur);
    const title = sourceTitle(id);
    // Other sources on its scale (it can leave it for a new one).
    const shares = cur !== "none" && lay.sourcesOn(pane, cur).some((s) => s !== id);
    const newRow = (side: "left" | "right"): Item | null => {
      if (!lay.canCreate(pane)) return null;
      if (!shares && curSlot?.side === side) return null;
      const at = (side === "left" ? left : right).length;
      const label = counts[side] > at ? `Pin to scale ${scaleLetter(side, at)}` : `Pin to new ${side} scale`;
      return {
        kind: "item", id: `pin-new-${side}`, label,
        onSelect: () => {
          const key = cx.scaleLayout().newKeyFor(pane, side);
          if (key) sourcesEdit(`move ${title} to new ${side} scale`, () => pin(key));
        },
      };
    };
    const scaleRow = (side: "left" | "right", key: string, index: number): Item => {
      const checked = key === cur;
      const letter = scaleLetter(side, index);
      const label = named ? `${checked ? "Pinned" : "Pin"} to scale ${letter}` : `${checked ? "Pinned" : "Pin"} to ${side} scale`;
      const undoText = named ? `pin to scale ${letter}` : `pin to ${side} scale`;
      return { kind: "item", id: `pin-${key}`, label, checked, onSelect: () => { if (!checked) sourcesEdit(undoText, () => pin(key)); } };
    };
    const newRight = newRow("right");
    const newLeft = newRow("left");
    const separated = right.length + left.length + (newRight ? 1 : 0) + (newLeft ? 1 : 0) > 2;
    const sub: CtxNode[] = right.map((k, i) => scaleRow("right", k, i));
    if (newRight) sub.push(newRight);
    if (separated && (right.length > 0 || newRight)) sub.push({ kind: "separator" });
    sub.push(...left.map((k, i) => scaleRow("left", k, i)));
    if (newLeft) sub.push(newLeft);
    if (separated && (left.length > 0 || newLeft)) sub.push({ kind: "separator" });
    // No scale: not for the last source of the pane on a scale.
    const onScales = lay.keysIn(pane).reduce((n, k) => n + lay.sourcesOn(pane, k).length, 0);
    sub.push({
      kind: "item", id: "pin-none", label: "No scale (fullscreen)", checked: cur === "none",
      disabled: !(cur === "none" || onScales > 1),
      onSelect: () => { if (cur !== "none") sourcesEdit(`make ${title} no scale (Full screen)`, () => pin("none")); },
    });
    const now = cur === "none" || !curSlot ? "no scale" : named ? scaleLetter(curSlot.side, curSlot.index) : curSlot.side;
    return { kind: "item", id: "pin-to-scale", label: `Pin to scale (now ${now})`, icon: PIN_ICON(), submenu: sub };
  }

  // ── Compared symbols: Move to, Pin to scale ─────────────────────────────
  // A compared symbol is placed like a study: over the series on the
  // series' scale ("Same % scale"), on a scale of its own, without a scale,
  // or in a pane (its own or one it joined).
  /** Pane a compared symbol is drawn in. */
  function comparePane(id: string): number | null {
    const e = cx.compareEntry(id);
    const layer = cx.compareLayers.get(id);
    if (!e || !layer) return null;
    return e.placement === "pane" ? layer.paneIndex : cx.mainPane();
  }
  function compareMoves(id: string): StudyMoves | null {
    const c = cx.controller;
    const pane = comparePane(id);
    if (!c || pane === null) return null;
    const last = (cx.chart?.panes().length ?? 1) - 1;
    const shared = pane === cx.mainPane() || c.idsInPane(pane).length > 1;
    return { mergeUp: pane > 0, unmergeUp: shared, mergeDown: pane < last, unmergeDown: shared };
  }
  function moveCompare(id: string, move: keyof StudyMoves) {
    const c = cx.controller;
    const pane = comparePane(id);
    if (!c || pane === null || !compareMoves(id)?.[move]) return;
    if (move === "mergeUp" || move === "mergeDown") {
      const target = move === "mergeUp" ? pane - 1 : pane + 1;
      // Into the price pane: over the series on a scale of its own; else the pane's group.
      if (target === cx.mainPane()) { props.onCompareChange?.(id, { placement: "scale", group: undefined, paneScale: undefined, scale: undefined }); return; }
      const group = c.groupOfPane(target);
      if (!group) return;
      props.onCompareChange?.(id, { placement: "pane", group, paneScale: undefined });
      return;
    }
    // A new pane right above / below the panes it shares.
    const before = c.stackedOrder().filter((x) => x !== id);
    const mates = [...c.idsInPane(pane).filter((x) => x !== id), ...(pane === cx.mainPane() ? [MAIN_SOURCE_ID] : [])];
    const first = before.findIndex((x) => mates.includes(x));
    let lastMate = first;
    before.forEach((x, k) => { if (mates.includes(x)) lastMate = k; });
    const at = first < 0 ? (move === "unmergeUp" ? 0 : before.length) : move === "unmergeUp" ? first : lastMate + 1;
    const order = [...before.slice(0, at), id, ...before.slice(at)];
    c.setPaneOrder(order);
    props.onPaneOrder?.(order);
    props.onCompareChange?.(id, { placement: "pane", group: undefined, paneScale: undefined });
  }
  function compareMoveRow(id: string): CtxNode | null {
    const moves = compareMoves(id);
    if (!moves) return null;
    const rows: [keyof StudyMoves, string][] = [
      ["mergeUp", "Existing pane above"],
      ["unmergeUp", "New pane above"],
      ["mergeDown", "Existing pane below"],
      ["unmergeDown", "New pane below"],
    ];
    const submenu = rows.filter(([k]) => moves[k]).map(([k, label]): CtxNode => ({
      kind: "item", id: `move-${k}`, label, onSelect: () => sourcesEdit(MOVE_UNDO[k], () => moveCompare(id, k)),
    }));
    if (!submenu.length) return null;
    return { kind: "item", id: "move-to", label: "Move to", icon: <Icon name="ot-header-move-to" size={18} />, submenu };
  }
  function comparePinRow(id: string): CtxNode | null {
    const e = cx.compareEntry(id);
    const layer = cx.compareLayers.get(id);
    const pane = comparePane(id);
    if (!e || !layer || pane === null) return null;
    const main = cx.seriesKey();
    const cur: StudyScale = e.placement === "none" || (e.placement === "pane" && e.paneScale === "none")
      ? "none"
      : cx.scaleLayout().sourceScale(id)?.key ?? "none";
    return pinRowFor(id, cur, pane, (scale) => {
      if (e.placement === "pane") props.onCompareChange?.(id, { paneScale: scale });
      // On the series' scale: "Same % scale"; else a scale of its own or none.
      else if (scale === "none") props.onCompareChange?.(id, { placement: "none" });
      else if (scale === main && pane === cx.mainPane()) props.onCompareChange?.(id, { placement: "percent" });
      else props.onCompareChange?.(id, { placement: "scale", scale });
      cx.syncScaleLayout();
    });
  }

  function sourceArrangeRows(id: string): CtxNode[] {
    const out: CtxNode[] = [];
    const vo = visualOrderRow(id);
    if (vo) out.push(vo);
    out.push(visibilityRow(id));
    const compared = !!cx.compareEntry(id);
    const move = compared ? compareMoveRow(id) : moveToRow(id);
    if (move) out.push(move);
    const pin = compared ? comparePinRow(id) : pinRow(id);
    if (pin) out.push(pin);
    return out;
  }

  // ── Study on study (indicators/study-sources.ts) ───────────────────────
  // ── Main series: Visual order, Move to, Pin to scale ──────────────────
  /** Pin the series to a scale: the sources on its former scale stay there (reference: a source keeps its
   *  scale object), as pinned studies / a compared symbol on that scale. */
  function pinSeries(scale: StudyScale) {
    const old = cx.seriesKey();
    if (scale === old) return;
    const c = cx.controller;
    const pane = cx.mainPane();
    if (old !== "none" && c) {
      for (const src of cx.scaleLayout().sourcesOn(pane, old)) {
        if (src === MAIN_SOURCE_ID) continue;
        const cmp = cx.compareEntry(src);
        if (cmp) {
          if (cmp.placement === "percent") props.onCompareChange?.(src, { placement: "scale", scale: old });
          continue;
        }
        if (c.getOptions(src).scale) continue;
        const options = c.setScaleKey(src, old);
        if (options) props.onIndicatorSettings?.(src, { inputs: c.getInputs(src) ?? {}, styles: c.getStyles(src) ?? {}, options });
      }
    }
    props.onSeriesScale?.(scale === cx.mainSide() ? null : scale);
  }
  function seriesArrangeRows(): CtxNode[] {
    const out: CtxNode[] = [];
    const vo = visualOrderRow(MAIN_SOURCE_ID);
    if (vo) out.push(vo);
    const moves = cx.seriesMoves();
    if (moves) {
      const rows: [keyof StudyMoves, string][] = [
        ["mergeUp", "Existing pane above"],
        ["unmergeUp", "New pane above"],
        ["mergeDown", "Existing pane below"],
        ["unmergeDown", "New pane below"],
      ];
      const submenu = rows.filter(([k]) => moves[k]).map(([k, label]): CtxNode => ({
        kind: "item", id: `move-${k}`, label, onSelect: () => sourcesEdit(MOVE_UNDO[k], () => cx.moveSeries(k)),
      }));
      if (submenu.length) out.push({ kind: "item", id: "move-to", label: "Move to", icon: <Icon name="ot-header-move-to" size={18} />, submenu });
    }
    out.push(pinRowFor(MAIN_SOURCE_ID, cx.seriesKey() as StudyScale, cx.mainPane(), pinSeries));
    return out;
  }

  /** Short title of a source (its menus and the Source lists), null when it cannot be a source. */
  function sourceShortTitle(id: string): string | null {
    const cmp = cx.compareEntry(id);
    if (cmp) return cx.compareSources().find((x) => x.id === id)?.label ?? cmp.symbol;
    const entry = getIndicatorEntry(id);
    if (!canHaveChildren(id, entry) || cx.controller?.paneOf(id) == null) return null;
    return entry!.shortName ?? entry!.name;
  }
  /** Where a study drawn over source `id` goes: its pane group and scale. */
  function childParentOf(id: string): ChildStudyParent | null {
    const title = sourceShortTitle(id);
    const c = cx.controller;
    if (title === null || !c) return null;
    const cmp = cx.compareEntry(id);
    const pane = cmp ? comparePane(id) : c.paneOf(id);
    if (pane === null) return null;
    const paneGroup = pane === cx.mainPane() ? undefined : c.groupOfPane(pane) ?? undefined;
    const scale = cmp
      ? (cmp.placement === "none" || (cmp.placement === "pane" && cmp.paneScale === "none") ? "none" : cx.scaleLayout().sourceScale(id)?.key ?? "none")
      : c.scaleOf(id) ?? undefined;
    const menuTitle = cmp ? cx.compareTitle(cmp) : title;
    return { id, title: menuTitle, ...(paneGroup ? { paneGroup } : {}), ...(scale ? { scale } : {}) };
  }
  function addOnSourceRow(id: string): CtxNode | null {
    const parent = childParentOf(id);
    if (!parent) return null;
    return {
      kind: "item", id: "add-on-source", label: `Add indicator/strategy on ${parent.title}…`, icon: CtxIcons.addIndicator,
      onSelect: () => emitAppEvent("chart-open-indicators", { parent }),
    };
  }
  function sourceChoicesFor(id: string): { value: string; label: string }[] {
    const skip = new Set([id, ...(cx.controller?.descendantsOf(id) ?? [])]);
    const out: { value: string; label: string }[] = [];
    for (const r of cx.indLegend()) {
      if (skip.has(r.id)) continue;
      const title = sourceShortTitle(r.id);
      if (title === null) continue;
      if (cx.compareEntry(r.id)) { out.push({ value: sourceRef(r.id, 0), label: title }); continue; }
      out.push(...plotChoices(r.id, title, getIndicatorEntry(r.id)!));
    }
    return out;
  }
  function sourceInputText(v: string): string | null {
    const r = parseSourceRef(v);
    if (!r) return null;
    const title = sourceShortTitle(r.id);
    if (title === null) return null;
    if (cx.compareEntry(r.id)) return title;
    return plotChoices(r.id, title, getIndicatorEntry(r.id)!).find((c) => c.value === v)?.label ?? title;
  }

  const sourceCopyRow = (id: string): CtxNode => ({
    kind: "item", id: "copy", label: "Copy", shortcut: "Ctrl + C", onSelect: () => copySourceOf(id),
  });

  return { addOnSourceRow, copySourceOf, seriesArrangeRows, sourceArrangeRows, sourceChoicesFor, sourceCopyRow, sourceInputText, sourceLayoutRow };
}
