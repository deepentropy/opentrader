/*
 * Rows of the study and compared-symbol menus (legend "More", right click on
 * a plot) that act on the source itself:
 *   "Add this indicator / strategy / symbol to entire layout" (charts of a
 *   multi-chart layout), "Visual order" > (front / back / one step among the
 *   objects of its pane), "Visibility on intervals" > (the four quick
 *   settings of its Visibility tab), "Move to" > (studies: pane above /
 *   below, new pane above / below), "Pin to scale (now …)" > (studies: the
 *   left / right scale of its pane, a new one on a free side, no scale),
 *   "Copy" (Ctrl + C; the chart menu's Paste adds a copy to a chart).
 * Reference rules: study menu actions of the reference chart (Pin to scale
 * labels name the scales "A" (right) / "Z" (left) once the chart has scales
 * on both sides). Not here (missing features): a study calculated on the
 * source ("Add indicator/strategy on …"), financial metrics, symbol info, a
 * second scale on one side, compared symbols moved between panes or pinned.
 */
import { Icon } from "../../../components/Icon";
import { sourcesEdit } from "../../shell/source-edits";
import { emitAppEvent } from "../../../data/app-events";
import { copySource, type ClipboardSource } from "../../drawings/clipboard";
import { splitTitle } from "../IndicatorLegend";
import { getIndicatorEntry } from "../indicators/registry";
import { isStrategyId } from "../indicators/strategy-entries";
import { typeIdOf } from "../indicators/study-id";
import type { StudyScale } from "../indicators/indicator-options";
import { visibilityForMode, type IntervalsVisibilityMode } from "../interval-visibility-mode";
import type { CtxNode } from "../ChartContextMenu";
import type { StudyMoves, ZOrderOp } from "./sources";
import { type ChartCx } from "./context";

/** What createSourceMenu adds to the chart context. */
export interface SourceMenuApi {
  /** Copy a study / compared symbol to the clipboard (menu "Copy", Ctrl+C). */
  copySourceOf: (id: string) => void;
  /** "Add this … to entire layout" row; null in a single-chart layout. */
  sourceLayoutRow: (id: string) => CtxNode | null;
  /** Visual order, Visibility on intervals, Move to, Pin to scale rows. */
  sourceArrangeRows: (id: string) => CtxNode[];
  /** "Copy" row. */
  sourceCopyRow: (id: string) => CtxNode;
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

/** Letter of a scale once the chart has scales on both sides. */
const SCALE_LETTER = { right: "A", left: "Z" } as const;


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
  const sourceTitle = (id: string) => cx.indLegend().find((r) => r.id === id)?.title ?? cx.compareEntry(id)?.symbol ?? "";
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
  /** Scales of a pane: per side, used by a source of the pane; and the
   *  sources there on a side scale. */
  function paneScales(pane: number, except: string) {
    const c = cx.controller!;
    const main = cx.currentTokens().scalesPlacement;
    const used = { left: false, right: false };
    let onSides = 0;
    let others = 0;
    const add = (scale: StudyScale | null) => {
      if (scale === "left" || scale === "right") { used[scale] = true; onSides++; }
    };
    if (pane === cx.mainPane()) { add(cx.mainSide()); others++; }
    for (const r of cx.indLegend()) {
      if (r.pane !== pane || r.id === except) continue;
      others++;
      const cmp = cx.compareEntry(r.id);
      if (cmp) {
        const sid = cx.compareLayers.get(r.id)?.scaleId;
        add(cmp.placement === "pane" ? main : sid === "left" || sid === "right" ? sid : "none");
      } else add(c.scaleOf(r.id));
    }
    return { used, onSides, others };
  }
  /** A side scale anywhere on the chart (another pane may have one). */
  function sideUsedAnywhere(side: "left" | "right"): boolean {
    if (side === cx.currentTokens().scalesPlacement) return true;
    if (cx.controller?.usesSide(side)) return true;
    return [...cx.compareLayers.values()].some((l) => l.scaleId === side);
  }
  function pinTo(id: string, scale: StudyScale) {
    const c = cx.controller;
    if (!c) return;
    const options = c.pinToScale(id, scale);
    if (!options) return;
    props.onIndicatorSettings?.(id, { inputs: c.getInputs(id) ?? {}, styles: c.getStyles(id) ?? {}, options });
    cx.syncSideScales();
    cx.refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
  }
  function pinRow(id: string): CtxNode | null {
    const c = cx.controller;
    const cur = c?.scaleOf(id) ?? null;
    const pane = c?.paneOf(id) ?? null;
    if (!c || !cur || pane === null) return null;
    const { used, onSides, others } = paneScales(pane, id);
    const named = sideUsedAnywhere("left") && sideUsedAnywhere("right");
    const sub: Item[] = [];
    for (const side of ["right", "left"] as const) {
      const here = used[side] || cur === side;
      if (here) {
        const label = named
          ? `${cur === side ? "Pinned" : "Pin"} to scale ${SCALE_LETTER[side]}`
          : `${cur === side ? "Pinned" : "Pin"} to ${side} scale`;
        const undoText = named ? `pin to scale ${SCALE_LETTER[side]}` : `pin to ${side} scale`;
        sub.push({ kind: "item", id: `pin-${side}`, label, checked: cur === side, onSelect: () => { if (cur !== side) sourcesEdit(undoText, () => pinTo(id, side)); } });
      } else if (others > 0 || cur !== side) {
        // A new scale on a free side (named when another pane has one there).
        const label = sideUsedAnywhere(side) ? `Pin to scale ${SCALE_LETTER[side]}` : `Pin to new ${side} scale`;
        sub.push({ kind: "item", id: `pin-new-${side}`, label, onSelect: () => sourcesEdit(`move ${sourceTitle(id)} to new ${side} scale`, () => pinTo(id, side)) });
      }
    }
    // No scale: not for the only source of the pane on a side scale.
    const onSidesWithIt = onSides + (cur === "left" || cur === "right" ? 1 : 0);
    sub.push({
      kind: "item", id: "pin-none", label: "No scale (fullscreen)", checked: cur === "none",
      disabled: !(cur === "none" || onSidesWithIt > 1),
      onSelect: () => { if (cur !== "none") sourcesEdit(`make ${sourceTitle(id)} no scale (Full screen)`, () => pinTo(id, "none")); },
    });
    const now = cur === "none" ? "no scale" : named ? SCALE_LETTER[cur] : cur;
    return { kind: "item", id: "pin-to-scale", label: `Pin to scale (now ${now})`, icon: PIN_ICON(), submenu: sub };
  }

  function sourceArrangeRows(id: string): CtxNode[] {
    const out: CtxNode[] = [];
    const vo = visualOrderRow(id);
    if (vo) out.push(vo);
    out.push(visibilityRow(id));
    if (!cx.compareEntry(id)) {
      const move = moveToRow(id);
      if (move) out.push(move);
      const pin = pinRow(id);
      if (pin) out.push(pin);
    }
    return out;
  }

  const sourceCopyRow = (id: string): CtxNode => ({
    kind: "item", id: "copy", label: "Copy", shortcut: "Ctrl + C", onSelect: () => copySourceOf(id),
  });

  return { copySourceOf, sourceArrangeRows, sourceCopyRow, sourceLayoutRow };
}
