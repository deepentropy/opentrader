/*
 * Menus of a chart view: the chart context menu, the price / time axis
 * menus, the series / study / compared-symbol "More" menus with their alert
 * rows, the TPO block actions, the plus button and pane menus.
 */
import { promptNewWatchlist } from "../../right-rail/watchlist-prompts";
import { typeIdOf } from "../indicators/study-id";
import { PriceScaleMode } from "lightweight-charts";
import { MAIN_SOURCE_ID } from "../object-tree-sources";
import { statusLineInputs } from "../indicators/indicator-options";
import { crosshairLockTime, setCrosshairLockTime } from "../crosshair-lock";
import { Icon } from "../../../components/Icon";
import { clipboardSource, hasClipboardContent, pasteAsNew } from "../../drawings/clipboard";
import { defaultStyleFor } from "lightweight-charts-drawing/core/specs";
import { chartTemplates } from "../../header/chart-templates";
import { isIntradayInterval, splitSymbol } from "../../../data/datafeed";
import { isTransformType } from "../chart-types";
import { splitTitle } from "../IndicatorLegend";
import { hasAlertFunction, studyConditions } from "../../../data/alert-study-conditions";
import { splitMergeKey, splitMergeMap, type SplitMergeAction } from "../profiles/tpo";
import type { TpoBlockHit } from "../profiles/tpo-primitive";
import { type IndicatorLegendRow } from "../indicators/indicator-controller";
import { getIndicatorEntry } from "../indicators/registry";
import { isStrategyId } from "../indicators/strategy-entries";
import { CtxIcons, type CtxNode } from "../ChartContextMenu";
import { TIMEZONES } from "../../../data/timezones";
import { isDeletedList, watchlistStore } from "../../../data/watchlist-store";
import { isFavoriteIndicator, toggleFavoriteIndicator } from "../../../data/indicator-favorites";
import { menuPrice, roundedPrice } from "./helpers";
import { PANE_MENU_ICONS } from "./pane-icons";
import { type ChartCx } from "./context";
import { emitAppEvent } from "../../../data/app-events";

// Context for the right-click menu's dynamic pieces (price/symbol/counts).
type ChartMenuCtx = {
  symbol: string;
  price: string;
  /** Right click in a study pane: the study title (the alert is on it, the
   *  trading rows are the price pane's only). */
  study?: string | null;
  /** The alert row's label when it is the study's (studyAlertRow rules). */
  alertLabel?: string;
  drawingCount: number;
  indicatorCount: number;
  cursorLockByTime: boolean;
  /** FALSE grays "Paste" (nothing on the clipboard). */
  canPaste: boolean;
  /** "Move chart" (a chart of a multi-chart layout). */
  canMoveChart: boolean;
  /** "Apply these indicators to entire layout" (a multi-chart layout). */
  canApplyToLayout: boolean;
};
type ChartMenuActions = {
  resetView: () => void;
  copyPrice: () => void;
  paste: () => void;
  addAlert: () => void;
  buy: () => void;
  sell: () => void;
  addOrder: () => void;
  toggleCursorLock: () => void;
  moveChart: (back: boolean) => void;
  applyToLayout: () => void;
  tableView: () => void;
  objectTree: () => void;
  saveTemplateAs: () => void;
  removeDrawings: () => void;
  removeIndicators: () => void;
  settings: () => void;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Build the chart context-menu node list: static order/separators/
 *  shortcuts/icons; the price/symbol/counts are interpolated from the live
 *  chart. */
function buildChartContextMenu(ctx: ChartMenuCtx, a: ChartMenuActions): CtxNode[] {
  const sym = ctx.symbol;
  const p = ctx.price;
  const nodes: CtxNode[] = [
    { kind: "item", id: "reset", label: "Reset chart view", shortcut: "Alt + R", icon: CtxIcons.reset, onSelect: a.resetView },
    { kind: "separator" },
    { kind: "item", id: "copy-price", label: `Copy price ${p}`, onSelect: a.copyPrice },
    { kind: "item", id: "paste", label: "Paste", shortcut: "Ctrl + V", disabled: !ctx.canPaste, onSelect: a.paste },
    { kind: "separator" },
    { kind: "item", id: "alert", label: ctx.alertLabel ?? `Add alert on ${ctx.study ?? sym} at ${p}…`, shortcut: "Alt + A", icon: CtxIcons.alert, onSelect: a.addAlert },
    ...(ctx.study ? [] : [
      { kind: "item", id: "buy", label: `Buy 1 ${sym} @ ${p} limit`, shortcut: "Alt + Shift + B", icon: CtxIcons.buy, onSelect: a.buy },
      { kind: "item", id: "sell", label: `Sell 1 ${sym} @ ${p} stop`, icon: CtxIcons.sell, onSelect: a.sell },
      { kind: "item", id: "order", label: `Add order on ${sym} at ${p}…`, shortcut: "Shift + T", icon: CtxIcons.order, onSelect: a.addOrder },
    ] as CtxNode[]),
    { kind: "separator" },
    // The focused chart swaps its place with the next / previous chart.
    ...(ctx.canMoveChart ? [
      { kind: "item", id: "move-chart", label: "Move chart", submenu: [
        { kind: "item", id: "move-chart-forward", label: "Forward", onSelect: () => a.moveChart(false) },
        { kind: "item", id: "move-chart-back", label: "Back", onSelect: () => a.moveChart(true) },
      ] },
      { kind: "separator" },
    ] as CtxNode[] : []),
    { kind: "item", id: "lock-cursor", label: "Lock vertical cursor line by time", checked: ctx.cursorLockByTime, onSelect: a.toggleCursorLock },
    { kind: "separator" },
    { kind: "item", id: "table-view", label: "Table view", onSelect: a.tableView },
    { kind: "item", id: "object-tree", label: "Object tree", onSelect: a.objectTree },
    // Chart template: "Save as…", then the saved chart templates (a row
    // applies it to this chart, its trash removes it).
    {
      kind: "item", id: "chart-template", label: "Chart template",
      submenu: [
        { kind: "item", id: "template-save-as", label: "Save as…", onSelect: a.saveTemplateAs },
        ...(chartTemplates().length ? [{ kind: "separator" } as CtxNode] : []),
        ...chartTemplates().map((tpl): CtxNode => ({
          kind: "item", id: `template:${tpl.name}`, label: tpl.name,
          onSelect: () => emitAppEvent("chart-apply-template", { name: tpl.name }),
          onRemove: () => emitAppEvent("chart-remove-template", { name: tpl.name }),
        })),
      ],
    },
  ];
  if (ctx.canApplyToLayout) {
    nodes.push({ kind: "separator" }, { kind: "item", id: "apply-to-layout", label: "Apply these indicators to entire layout", onSelect: a.applyToLayout });
  }
  const removeRows: CtxNode[] = [];
  if (ctx.drawingCount > 0) removeRows.push({ kind: "item", id: "remove-drawings", label: `Remove ${plural(ctx.drawingCount, "drawing")}`, onSelect: a.removeDrawings });
  if (ctx.indicatorCount > 0) removeRows.push({ kind: "item", id: "remove-indicators", label: `Remove ${plural(ctx.indicatorCount, "indicator")}`, onSelect: a.removeIndicators });
  if (removeRows.length) nodes.push({ kind: "separator" }, ...removeRows);
  nodes.push(
    { kind: "separator" },
    { kind: "item", id: "settings", label: "Settings…", icon: CtxIcons.settings, onSelect: a.settings },
  );
  return nodes;
}


/** What createMenus adds to the chart context. */
export interface MenusApi {
  alertTarget: () => {
    indicatorId?: string;
    price?: number;
  };
  openCompareMoreMenu: (id: string, anchor: DOMRect, price?: number | null) => void;
  openContextMenu: (e: MouseEvent) => void;
  openIndicatorMoreMenu: (id: string, anchor: DOMRect) => void;
  openPaneMenu: (e: MouseEvent, i: number) => void;
  openPlusMenu: (r: DOMRect, yAbs: number) => void;
  openPriceScaleMenu: (e: MouseEvent, corner?: DOMRect) => void;
  openSeriesMoreMenu: (anchor: DOMRect) => void;
}

export function createMenus(cx: ChartCx): MenusApi {
  const { appearance, coords, currentTokens, indLegend, props, selectStudy, selectedStudy, setCompareSettingsFor, setCtxMenu, setSettingsForId, toggleSourceHidden } = cx;
  /** Right-click on the PRICE AXIS → the price-scale menu (Auto, Lock ratio,
   *  Scale price chart only, Invert, the four mode radios, Move scale,
   *  Labels/Lines submenus, Plus button, Session on intraday, More
   *  settings…). Rows we have no surface for (bid-ask
   *  labels+lines, no-overlapping-labels) are omitted. */
  function openPriceScaleMenu(e: MouseEvent, corner?: DOMRect) {
    if (!cx.chart) return;
    const t = currentTokens();
    // The axis of a study pane: its items act on that pane's own scale (the
    // study's), and "Lock price to bar ratio" is the main axis' only. The
    // axis corner button acts on the main pane's scale.
    const yRel = cx.host ? e.clientY - cx.host.getBoundingClientRect().top : 0;
    const paneIdx = corner ? 0 : cx.paneAtY(yRel) ?? 0;
    const owner = paneIdx > 0 ? cx.controller?.ownerOfPane(paneIdx) ?? null : null;
    const studySeries = owner ? cx.controller?.studySeries(owner) ?? null : null;
    const ps = studySeries ? studySeries.priceScale() : cx.chart.priceScale(t.scalesPlacement);
    const cur = ps.options();
    const setMode = (mode: PriceScaleMode) => () => ps.applyOptions({ mode });
    const patch = (p: Record<string, unknown>) =>
      emitAppEvent("chart-patch-scale-settings", { patch: p });
    // Ratio: bar spacing × price range ÷ pane height.
    const ratio = cx.liveScaleRatio() ?? null;
    const nodes: CtxNode[] = [
      { kind: "item", id: "auto", label: "Auto (fits data to screen)", checked: cur.autoScale,
        onSelect: () => ps.applyOptions({ autoScale: !cur.autoScale }) },
      // Locking stores the current ratio in the Scales row (the lock keeps
      // the ratio in effect when it is turned on).
      ...(studySeries ? [] : [{ kind: "item", id: "lock-ratio", label: "Lock price to bar ratio", checked: t.lockRatio,
        // Shown with 4 decimals, on a regular scale only.
        shortcut: ratio != null && cur.mode === PriceScaleMode.Normal
          ? ratio.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })
          : undefined,
        onSelect: () => patch(t.lockRatio ? { lockRatio: false } : { lockRatio: true, lockRatioValue: ratio ?? undefined }) } as CtxNode]),
      // Auto-scale of the main series' scale on the series alone (chart
      // setting, saved like the lock ratio).
      { kind: "item", id: "series-only", label: "Scale price chart only",
        checked: t.scaleSeriesOnly, onSelect: () => patch({ scaleSeriesOnly: !t.scaleSeriesOnly }) },
      { kind: "item", id: "invert", label: "Invert scale", shortcut: "Alt + I",
        checked: cur.invertScale, onSelect: () => ps.applyOptions({ invertScale: !cur.invertScale }) },
      { kind: "separator" },
      { kind: "item", id: "mode-regular", label: "Regular",
        checked: cur.mode === PriceScaleMode.Normal, onSelect: setMode(PriceScaleMode.Normal) },
      { kind: "item", id: "mode-percent", label: "Percent", shortcut: "Alt + P",
        checked: cur.mode === PriceScaleMode.Percentage, onSelect: setMode(PriceScaleMode.Percentage) },
      { kind: "item", id: "mode-indexed", label: "Indexed to 100",
        checked: cur.mode === PriceScaleMode.IndexedTo100, onSelect: setMode(PriceScaleMode.IndexedTo100) },
      { kind: "item", id: "mode-log", label: "Logarithmic", shortcut: "Alt + L",
        checked: cur.mode === PriceScaleMode.Logarithmic, onSelect: setMode(PriceScaleMode.Logarithmic) },
      { kind: "separator" },
      { kind: "item", id: "move-scale",
        label: t.scalesPlacement === "right" ? "Move scale to left" : "Move scale to right",
        onSelect: () => patch({ scalesPlacement: t.scalesPlacement === "right" ? "left" : "right" }) },
      { kind: "separator" },
      { kind: "item", id: "labels", label: "Labels", submenu: [
        { kind: "item", id: "lbl-symname", label: "Symbol name label",
          checked: t.symbolNameLabel, onSelect: () => patch({ symbolNameLabel: !t.symbolNameLabel }) },
        { kind: "item", id: "lbl-symbol", label: "Symbol last price label",
          checked: t.symbolLastValue, onSelect: () => patch({ symbolLastValue: !t.symbolLastValue }) },
        { kind: "item", id: "lbl-prevclose", label: "Previous day close price label",
          checked: t.prevCloseLabel, onSelect: () => patch({ prevCloseLabel: !t.prevCloseLabel }) },
        { kind: "item", id: "lbl-prepost", label: "Pre/post market price label",
          checked: t.prePostLabel, onSelect: () => patch({ prePostLabel: !t.prePostLabel }) },
        { kind: "item", id: "lbl-hilo", label: "High and low price labels",
          checked: t.highLowLabels, onSelect: () => patch({ highLowLabels: !t.highLowLabels }) },
        { kind: "item", id: "lbl-ind", label: "Indicators and financials value labels",
          checked: t.indLastValue, onSelect: () => patch({ indLastValue: !t.indLastValue }) },
        { kind: "item", id: "lbl-ind-name", label: "Indicators and financials name labels",
          checked: t.indNameLabel, onSelect: () => patch({ indNameLabel: !t.indNameLabel }) },
        { kind: "item", id: "lbl-countdown", label: "Countdown to bar close",
          checked: t.countdownVisible, onSelect: () => patch({ countdown: !t.countdownVisible }) },
      ] },
      { kind: "item", id: "lines", label: "Lines", submenu: [
        { kind: "item", id: "line-price", label: "Price line",
          checked: t.symbolPriceLine, onSelect: () => patch({ symbolPriceLine: !t.symbolPriceLine }) },
        { kind: "item", id: "line-prevclose", label: "Previous day close price line",
          checked: t.prevCloseLine, onSelect: () => patch({ prevCloseLine: !t.prevCloseLine }) },
        { kind: "item", id: "line-prepost", label: "Pre/post market price line",
          checked: t.prePostLine, onSelect: () => patch({ prePostLine: !t.prePostLine }) },
        { kind: "item", id: "line-hilo", label: "High and low price lines",
          checked: t.highLowLines, onSelect: () => patch({ highLowLines: !t.highLowLines }) },
      ] },
      { kind: "item", id: "plus-button", label: "Plus button", checked: t.plusButton,
        onSelect: () => patch({ plusButton: !t.plusButton }) },
    ];
    if (isIntradayInterval(props.interval ?? "1D")) {
      nodes.push({ kind: "separator" });
      nodes.push({ kind: "item", id: "session", label: "Session", submenu: [
        { kind: "item", id: "session-rth", label: "Regular", checked: (props.session ?? "RTH") === "RTH",
          onSelect: () => emitAppEvent("chart-set-session", { id: "RTH" }) },
        { kind: "item", id: "session-eth", label: "Extended", checked: props.session === "ETH",
          onSelect: () => emitAppEvent("chart-set-session", { id: "ETH" }) },
      ] });
    }
    nodes.push({ kind: "separator" });
    nodes.push(moreScaleSettingsNode());
    // Corner button: the menu opens above the button, flush with its outer
    // edge (right edge on a right scale, left edge on a left one).
    if (corner) {
      const left = t.scalesPlacement === "left";
      setCtxMenu({ x: left ? corner.left : corner.right, y: corner.top, endX: !left, endY: true, corner: true, nodes });
      return;
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, nodes });
  }

  /** Scale properties action (both axis menus): Settings on the Scales tab. */
  const moreScaleSettingsNode = (): CtxNode => ({
    kind: "item", id: "more-settings", label: "More settings…", icon: CtxIcons.settings,
    onSelect: () => emitAppEvent("chart-open-settings", { tab: "scales" }),
  });

  /** Right-click on the TIME AXIS → the time-axis menu: "Reset time scale" +
   *  separator only when the time scale is off default, "Time zone"
   *  submenu (the bottom-bar list), "Session breaks" (checkable, disabled on
   *  D/W/M), "Session" submenu on intraday, separator, "More settings…". */
  function openTimeScaleMenu(e: MouseEvent) {
    const t = currentTokens();
    const intraday = isIntradayInterval(props.interval ?? "1D");
    const tzLabel = props.timeZoneLabel ?? "Exchange";
    const nodes: CtxNode[] = [];
    if (cx.timeScaleOffDefault()) {
      nodes.push({ kind: "item", id: "reset-time-scale", label: "Reset time scale", shortcut: "Ctrl + Alt + Q",
        icon: CtxIcons.reset, onSelect: () => cx.resetTimeScale() });
      nodes.push({ kind: "separator" });
    }
    nodes.push({ kind: "item", id: "time-zone", label: "Time zone", submenu: TIMEZONES.map((z) => ({
      kind: "item" as const, id: `tz-${z.label}`, label: z.label, checked: z.label === tzLabel,
      onSelect: () => emitAppEvent("chart-set-timezone", { label: z.label }),
    })) });
    nodes.push({ kind: "item", id: "session-breaks", label: "Session breaks", checked: t.sessionBreaksVisible,
      disabled: !intraday,
      onSelect: () => emitAppEvent("chart-patch-scale-settings", { patch: { sessionBreaks: !t.sessionBreaksVisible } }) });
    if (intraday) {
      nodes.push({ kind: "item", id: "session", label: "Session", submenu: [
        { kind: "item", id: "session-rth", label: "Regular", checked: (props.session ?? "RTH") === "RTH",
          onSelect: () => emitAppEvent("chart-set-session", { id: "RTH" }) },
        { kind: "item", id: "session-eth", label: "Extended", checked: props.session === "ETH",
          onSelect: () => emitAppEvent("chart-set-session", { id: "ETH" }) },
      ] });
    }
    nodes.push({ kind: "separator" });
    nodes.push(moreScaleSettingsNode());
    setCtxMenu({ x: e.clientX, y: e.clientY, nodes });
  }



  /** Legend series "More" → the series actions menu, opened under the button
   *  (button left, bottom + 3). No cursor price here, so the prices are the
   *  last close. Rows with no OT
   *  feature are left out: Add order, Add financial metric, Symbol info,
   *  Metrics, Table view, Visual order, Move to, Pin to scale, Add text note. */
  function openSeriesMoreMenu(anchor: DOMRect) {
    const full = props.symbol ?? "";
    const sym = splitSymbol(full).ticker;
    const last = cx.raw.length ? cx.raw[cx.raw.length - 1].close : null;
    const p = last == null ? "—" : menuPrice(last);
    const hidden = !!props.seriesHidden;
    const row = { ticker: full, short: full.split(":").pop() || full, last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null };
    // Watchlist submenu: the active list first (Alt + W),
    // then the other lists by name; a row adds or removes the symbol and the
    // menu stays open; separator; "Create new list…".
    const activeId = watchlistStore.activeId();
    const offered = watchlistStore.shownLists().filter((l) => !isDeletedList(l.id));
    const lists = [
      ...offered.filter((l) => l.id === activeId),
      ...offered.filter((l) => l.id !== activeId)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    ];
    const listRows: CtxNode[] = lists.map((l) => ({
      kind: "item" as const, id: `wl-${l.id}`, label: l.name,
      shortcut: l.id === activeId ? "Alt + W" : undefined,
      checked: () => watchlistStore.listHas(l.id, full),
      keepOpen: true,
      onSelect: () => {
        if (watchlistStore.listHas(l.id, full)) watchlistStore.removeRowFrom(l.id, full);
        else if (l.id === activeId) watchlistStore.addSymbols([row], null);
        else watchlistStore.addRowTo(l.id, row);
      },
    }));
    const nodes: CtxNode[] = [
      { kind: "item", id: "alert", label: `Add alert on ${sym} at ${p}…`, shortcut: "Alt + A", icon: CtxIcons.alert,
        onSelect: () => emitAppEvent("chart-open-alert-dialog", { symbol: full, price: last ?? undefined }) },
      { kind: "item", id: "add-indicator", label: `Add indicator/strategy on ${sym}…`, icon: CtxIcons.addIndicator,
        onSelect: () => emitAppEvent("chart-open-indicators") },
      { kind: "separator" },
      { kind: "item", id: "copy-price", label: `Copy price ${p}`,
        onSelect: () => { if (last != null) void navigator.clipboard?.writeText(p); } },
      { kind: "item", id: "paste", label: "Paste", shortcut: "Ctrl + V", disabled: !hasClipboardContent(), onSelect: pasteClipboard },
      { kind: "separator" },
      { kind: "item", id: "hide", label: hidden ? "Show" : "Hide", icon: hidden ? CtxIcons.show : CtxIcons.hide,
        onSelect: () => props.onToggleSeries?.() },
      { kind: "separator" },
      { kind: "item", id: "watchlist", label: `Add ${sym} to watchlist`, submenu: [
        ...listRows,
        { kind: "separator" },
        { kind: "item", id: "wl-create", label: "Create new list…", onSelect: () => promptNewWatchlist((name) => watchlistStore.createListWith(row, name)) },
      ] },
      { kind: "separator" },
      { kind: "item", id: "settings", label: "Settings…", icon: CtxIcons.settings,
        onSelect: () => emitAppEvent("chart-open-settings") },
    ];
    setCtxMenu({ x: anchor.left, y: anchor.bottom + 3, nodes });
  }

  /** Legend study "More" → the study actions menu. Rows with no OT feature
   *  are left out: Add indicator/strategy on the study (a study calculated on
   *  its output). */
  function openIndicatorMoreMenu(id: string, anchor: DOMRect) {
    const nodes = studyMenuNodes(id);
    if (nodes) setCtxMenu({ x: anchor.left, y: anchor.bottom + 3, nodes });
  }

  // ── Alerts on the chart's sources (menus) ──────────────────────────────
  // Reference rules: the "+" menu lists one row per visible source on the
  // scale of its side in the pane under the pointer (main series first, a
  // source on a percent / indexed scale has none), labelled "Add alert on
  // <short title> at <price at the pointer>" (a source without plots, e.g. a
  // strategy: "Add alert on <title>"). The study menu (legend More, right
  // click on a plot) starts with "Add alert on <title> at <price>…": the
  // price at the pointer, else the study's last value; no price for a
  // strategy or a study with conditions / alert() calls (the dialog opens on
  // them). Every row opens the alert dialog on that source at the price.

  /** A study the alert dialog takes as a source: a strategy (its order fills), a study with plots, conditions or
   *  alert() calls. */
  function studyAlertable(id: string, row?: IndicatorLegendRow): boolean {
    const entry = getIndicatorEntry(id);
    if (!entry) return false;
    if (isStrategyId(id)) return true;
    return (entry.plotConfig?.length ?? 0) > 0 || studyConditions(entry, row?.inputValues).length > 0 || hasAlertFunction(entry);
  }

  /** Price of a study at `y` (pixels from the top of its pane) on its own scale. */
  function studyPriceAt(id: string, y: number): number | null {
    const s = cx.controller?.studySeries(id);
    const p = s ? s.coordinateToPrice(y) : null;
    return p == null ? null : (p as number);
  }
  /** Status-line title of a study for the study menu: with its inputs when the legend shows them. */
  function studyMenuTitle(row: IndicatorLegendRow): string {
    const { name, inputs } = splitTitle(row.title);
    if (!(appearance().legendIndInputs ?? true) || !row.showInputs) return name;
    if (inputs) return `${name} ${inputs}`;
    const entry = getIndicatorEntry(row.id);
    const list = entry && row.inputValues ? statusLineInputs(entry, row.inputValues, ", ") : "";
    return list ? `${name} (${list})` : name;
  }
  /** "Add alert on <study>…" row of the study menu; `price` = at the pointer (right click), else its last value. */
  function studyAlertRow(id: string, price?: number | null): Extract<CtxNode, { kind: "item" }> | null {
    const row = (cx.controller?.getLegend() ?? []).find((r) => r.id === id);
    if (!row || !studyAlertable(id, row)) return null;
    const entry = getIndicatorEntry(id);
    const fmt = cx.controller?.studySeries(id)?.priceFormatter();
    let value = price ?? null;
    if (value == null) {
      const plot = row.plots.find((p) => p.index === 0 && Number.isFinite(p.value)) ?? row.plots.find((p) => Number.isFinite(p.value));
      value = plot && typeof plot.value === "number" ? plot.value : null;
    }
    if (value != null && fmt) value = roundedPrice(value, (n) => fmt.format(n));
    const plain = !isStrategyId(id) && !hasAlertFunction(entry) && studyConditions(entry, row.inputValues).length === 0;
    const title = studyMenuTitle(row);
    const label = value != null && plain && fmt ? `Add alert on ${title} at ${fmt.format(value)}…` : `Add alert on ${title}…`;
    return {
      kind: "item", id: "alert", label, shortcut: "Alt + A", icon: CtxIcons.alert,
      onSelect: () => emitAppEvent("chart-open-alert-dialog", { symbol: props.symbol ?? "", price: value ?? undefined, indicatorId: id }),
    };
  }
  /** The "+" menu's alert rows for pane `paneIdx` at `y` (pixels from the pane top), main series first. */
  function plusAlertRows(paneIdx: number, y: number): CtxNode[] {
    const out: CtxNode[] = [];
    const side = currentTokens().scalesPlacement;
    const plainScale = (mode: PriceScaleMode | undefined) => mode !== PriceScaleMode.Percentage && mode !== PriceScaleMode.IndexedTo100;
    const row = (id: string, label: string, detail: Record<string, unknown>): CtxNode => ({
      kind: "item", id: `plus-alert-${id}`, label, shortcut: "Alt + A", icon: CtxIcons.alert,
      onSelect: () => emitAppEvent("chart-open-alert-dialog", detail),
    });
    if (paneIdx === 0 && cx.series && !props.seriesHidden && plainScale(cx.series.priceScale().options().mode)) {
      const p = cx.series.coordinateToPrice(y);
      if (p != null) {
        const fmt = cx.series.priceFormatter();
        const v = roundedPrice(p as number, (n) => fmt.format(n));
        out.push(row(MAIN_SOURCE_ID, `Add alert on ${splitSymbol(props.symbol ?? "").ticker} at ${fmt.format(v)}`, { symbol: props.symbol ?? "", price: v }));
      }
    }
    for (const r of cx.controller?.getLegend() ?? []) {
      if (r.hidden || !studyAlertable(r.id, r)) continue;
      const s = cx.controller?.studySeries(r.id);
      // No scale id = the chart's visible default scale (the side one).
      if (!s || s.getPane().paneIndex() !== paneIdx || (s.options().priceScaleId || side) !== side) continue;
      if (!plainScale(s.priceScale().options().mode)) continue;
      const p = s.coordinateToPrice(y);
      if (p == null) continue;
      const fmt = s.priceFormatter();
      const v = roundedPrice(p as number, (n) => fmt.format(n));
      const name = splitTitle(r.title).name;
      // Price in the label for a study with plots (not a strategy).
      const usual = !isStrategyId(r.id) && (getIndicatorEntry(r.id)?.plotConfig?.length ?? 0) > 0;
      out.push(row(r.id, usual ? `Add alert on ${name} at ${fmt.format(v)}` : `Add alert on ${name}`,
        { symbol: props.symbol ?? "", price: v, indicatorId: r.id }));
    }
    // The compared symbols on that scale (not on a % / indexed scale).
    for (const c of cx.compareSources()) {
      const s = cx.compareLayers.get(c.id)?.firstSeries();
      if (c.hidden || !s || s.getPane().paneIndex() !== paneIdx || (s.options().priceScaleId || side) !== side) continue;
      if (!plainScale(s.priceScale().options().mode)) continue;
      const p = s.coordinateToPrice(y);
      if (p == null) continue;
      const v = roundedPrice(p as number, c.format);
      out.push(row(c.id, `Add alert on ${c.description} at ${c.format(v)}`, { symbol: props.symbol ?? "", price: v, compareSymbol: c.symbol }));
    }
    return out;
  }

  /** "Add alert on <description> at <price>…" row of a compared symbol's menu; `price` = at the pointer (right
   *  click on its line), else its last value. */
  function compareAlertRow(id: string, price?: number | null): CtxNode | null {
    const c = cx.compareSources().find((x) => x.id === id);
    if (!c) return null;
    const v = price ?? c.last;
    const value = v == null ? null : roundedPrice(v, c.format);
    return {
      kind: "item", id: "alert", label: value != null ? `Add alert on ${c.description} at ${c.format(value)}…` : `Add alert on ${c.description}…`,
      shortcut: "Alt + A", icon: CtxIcons.alert,
      onSelect: () => emitAppEvent("chart-open-alert-dialog", { symbol: props.symbol ?? "", price: value ?? undefined, compareSymbol: c.symbol }),
    };
  }

  /** A study's actions menu (legend "More", right click on its drawing); null when it is not in the legend.
   *  `price`: the price at the pointer for its alert row (right click), else its last value. */
  function studyMenuNodes(id: string, price?: number | null): CtxNode[] | null {
    const row = indLegend().find((r) => r.id === id);
    if (!row) return null;
    const nodes: CtxNode[] = [];
    const alert = studyAlertRow(id, price);
    if (alert) nodes.push(alert);
    const layout = cx.sourceLayoutRow(id);
    if (layout) nodes.push(layout);
    // No favorites row for studies that cannot be starred (compare/overlay).
    if (getIndicatorEntry(id)) {
      const fav = isFavoriteIndicator(typeIdOf(id));
      nodes.push(
        { kind: "item", id: "favorite", label: fav ? "Remove this indicator from favorites" : "Add this indicator to favorites",
          icon: CtxIcons.favorite, onSelect: () => toggleFavoriteIndicator(typeIdOf(id)) },
      );
    }
    if (nodes.length) nodes.push({ kind: "separator" });
    const arrange = cx.sourceArrangeRows(id);
    if (arrange.length) nodes.push(...arrange, { kind: "separator" });
    nodes.push(
      cx.sourceCopyRow(id),
      { kind: "item", id: "hide", label: row.eyeHidden ? "Show" : "Hide", icon: row.eyeHidden ? CtxIcons.show : CtxIcons.hide,
        onSelect: () => toggleSourceHidden(id) },
      { kind: "item", id: "remove", label: "Remove", shortcut: "Del", icon: CtxIcons.remove,
        onSelect: () => props.onRemoveIndicator?.(id) },
      { kind: "separator" },
      { kind: "item", id: "object-tree", label: "Object tree",
        onSelect: () => emitAppEvent("chart-open-panel", { id: "object_tree" }) },
      { kind: "separator" },
      { kind: "item", id: "settings", label: "Settings…", icon: CtxIcons.settings, onSelect: () => setSettingsForId(id) },
    );
    return nodes;
  }


  /** Alt + A (reference rule): the alert is on the selected study when it is a
   *  source, at the price under the crosshair while the pointer is on the chart. */
  function alertTarget(): { indicatorId?: string; compareSymbol?: string; price?: number } {
    const id = selectedStudy();
    const row = id && !cx.compareEntry(id) ? (cx.controller?.getLegend() ?? []).find((r) => r.id === id) : undefined;
    // A selected compared symbol is a source too.
    const cmp = id ? cx.compareEntry(id) : undefined;
    return {
      ...(row && studyAlertable(row.id, row) ? { indicatorId: row.id } : {}),
      ...(cmp ? { compareSymbol: cmp.symbol } : {}),
      ...(cx.crosshairPrice != null ? { price: cx.crosshairPrice } : {}),
    };
  }

  /** Right click on a TPO block: the study's menu, then the reference block actions (after the study's actions):
   *  split the profile at the block (not on its first block), merge it with the previous profile (not the first
   *  profile), reset all splits and merges; disabled on charts without time-based bars. Kept per symbol and
   *  period settings in the study's `mergePoints` input. */

  function openTpoBlockMenu(id: string, hit: TpoBlockHit, x: number, y: number) {
    const nodes = studyMenuNodes(id);
    if (!nodes) return;
    const timeBased = !isTransformType(cx.activeType);
    const entry = getIndicatorEntry(id);
    const update = (fn: (list: SplitMergeAction[]) => SplitMergeAction[]) => {
      const inputs = { ...(cx.controller?.getInputs(id) ?? {}) };
      const key = splitMergeKey(props.symbol ?? "", inputs, id.startsWith("tpo-sessions"));
      const map = splitMergeMap(inputs);
      const list = fn(map[key] ?? []);
      if (list.length) map[key] = list;
      else delete map[key];
      inputs.mergePoints = JSON.stringify(map);
      const styles = cx.controller?.getStyles(id) ?? {};
      const options = cx.controller?.getOptions(id);
      cx.controller?.applySettings(id, inputs, styles, options);
      if (options) props.onIndicatorSettings?.(id, { inputs, styles, options });
    };
    if (!entry) return;
    nodes.push(
      { kind: "separator" },
      { kind: "item", id: "tpo-split", label: "Split profile at this letter", disabled: !timeBased || hit.block === 0,
        onSelect: () => update((l) => [...l, { action: "split", time: hit.blockTime * 1000 }]) },
      { kind: "item", id: "tpo-merge", label: "Merge with previous profile", disabled: !timeBased || !hit.hasPrevious,
        onSelect: () => update((l) => [...l, { action: "merge", time: hit.profileStart * 1000 }]) },
      { kind: "item", id: "tpo-reset", label: "Reset all merges and splits", disabled: !timeBased,
        onSelect: () => update(() => []) },
    );
    setCtxMenu({ x, y, nodes });
  }

  /** Legend compared-symbol "More" → its actions menu. Rows with no OT
   *  feature are left out (same rule as the study menu): Add indicator /
   *  financial metric on the symbol, Symbol info, Move to, Pin to scale. */
  function openCompareMoreMenu(id: string, anchor: DOMRect, price?: number | null) {
    const e = cx.compareEntry(id);
    if (!e) return;
    // Rows on the symbol (reference order: alert, add to entire layout).
    const top: CtxNode[] = [];
    const alert = compareAlertRow(id, price);
    if (alert) top.push(alert);
    const layout = cx.sourceLayoutRow(id);
    if (layout) top.push(layout);
    const arrange = cx.sourceArrangeRows(id);
    const nodes: CtxNode[] = [
      ...(top.length ? [...top, { kind: "separator" } as CtxNode] : []),
      ...(arrange.length ? [...arrange, { kind: "separator" } as CtxNode] : []),
      cx.sourceCopyRow(id),
      { kind: "item", id: "hide", label: e.hidden ? "Show" : "Hide", icon: e.hidden ? CtxIcons.show : CtxIcons.hide,
        onSelect: () => props.onCompareChange?.(id, { hidden: !e.hidden }) },
      { kind: "item", id: "remove", label: "Remove", shortcut: "Del", icon: CtxIcons.remove,
        onSelect: () => props.onRemoveCompare?.(id) },
      { kind: "separator" },
      { kind: "item", id: "object-tree", label: "Object tree",
        onSelect: () => emitAppEvent("chart-open-panel", { id: "object_tree" }) },
      { kind: "separator" },
      { kind: "item", id: "settings", label: "Settings…", icon: CtxIcons.settings, onSelect: () => setCompareSettingsFor(id) },
    ];
    setCtxMenu({ x: anchor.left, y: anchor.bottom + 3, nodes });
  }

  /** Paste the in-app clipboard (same as Ctrl+V): a copied drawing is placed
   *  at its data coords and selected; a copied study / compared symbol is
   *  added to this chart. */
  function pasteClipboard() {
    const nd = pasteAsNew();
    if (nd) {
      const id = props.onPlace?.(nd);
      if (id) props.setSelectedDrawingId?.(id);
      return;
    }
    if (clipboardSource()) emitAppEvent("chart-paste-source");
  }

  /** Right-click → open the chart context menu at the cursor. "Copy price" /
   *  "Buy …@ price" use the price under the cursor (yToPrice via the coord
   *  bridge); the counts come from the live drawings + indicators. */
  function openContextMenu(e: MouseEvent) {
    e.preventDefault();
    // On an alert label (its line or label): the label is selected and its menu opens.
    const alertAt = cx.alertLabelAt(e.clientX, e.clientY);
    if (alertAt && alertAt.hit.area !== "axis") {
      cx.setAlertSelected({ id: alertAt.hit.id, level: alertAt.hit.level });
      cx.openAlertLabelMenu(alertAt.hit.id, e.clientX, e.clientY);
      return;
    }
    // Over the price-axis strip → the price-scale menu, not the pane menu.
    if (cx.chart && cx.host) {
      const placement = currentTokens().scalesPlacement;
      const sw = cx.chart.priceScale(placement).width();
      const xRel = e.clientX - cx.host.getBoundingClientRect().left;
      const overScale = placement === "right" ? xRel >= cx.host.clientWidth - sw : xRel <= sw;
      if (overScale) { openPriceScaleMenu(e); return; }
      // Over the time-axis strip (the bottom of the chart host) → the time-axis menu.
      const yFromBottom = cx.host.getBoundingClientRect().bottom - e.clientY;
      if (yFromBottom <= cx.chart.timeScale().height()) { openTimeScaleMenu(e); return; }
    }
    const yRel = cx.host ? e.clientY - cx.host.getBoundingClientRect().top : 0;
    // On a TPO block: the study's menu with the block actions.
    if (cx.chart && cx.host && (cx.paneAtY(yRel) ?? 0) === 0) {
      const left = currentTokens().scalesPlacement === "left" ? cx.chart.priceScale("left").width() : 0;
      const tpoHit = cx.controller?.tpoBlockAt(e.clientX - cx.host.getBoundingClientRect().left - left, yRel);
      if (tpoHit) { openTpoBlockMenu(tpoHit.id, tpoHit.hit, e.clientX, e.clientY); return; }
    }
    // On a study's plot: the study is selected and its menu opens at the
    // pointer, its alert row at the price there (on the study's scale).
    if (cx.hoveredStudy && cx.compareEntry(cx.hoveredStudy)) {
      const id = cx.hoveredStudy;
      selectStudy(id);
      // Its alert row at the price under the pointer, on its scale.
      const s = cx.compareLayers.get(id)?.firstSeries();
      const box = s ? cx.paneBoxes().find((b) => b.index === s.getPane().paneIndex()) : undefined;
      const at = s ? s.coordinateToPrice(yRel - (box?.top ?? 0)) : null;
      openCompareMoreMenu(id, new DOMRect(e.clientX, e.clientY - 3, 0, 0), at as number | null);
      return;
    }
    if (cx.hoveredStudy && indLegend().some((r) => r.id === cx.hoveredStudy)) {
      const id = cx.hoveredStudy;
      const pane = cx.controller?.paneOf(id) ?? 0;
      const box = cx.paneBoxes().find((b) => b.index === pane);
      const nodes = studyMenuNodes(id, studyPriceAt(id, yRel - (box?.top ?? 0)));
      if (nodes) {
        selectStudy(id);
        setCtxMenu({ x: e.clientX, y: e.clientY, nodes });
        return;
      }
    }
    // In a study pane the price is that pane's (its study's scale) and the
    // alert is on the study (the reference pane menu's main source).
    const paneIdx = cx.paneAtY(yRel) ?? 0;
    const studyPane = paneIdx > 0 ? cx.drawingPanes().find((p) => p.key && yRel >= p.top && yRel < p.top + p.height) : undefined;
    const studyId = studyPane?.key ?? null;
    const studyTitle = studyId ? cx.controller?.getLegend().find((r) => r.id === studyId)?.title ?? null : null;
    const rawPrice = (studyPane ? studyPane.coords.yToPrice(yRel - studyPane.top) : coords()?.yToPrice(yRel)) ?? null;
    const a = Math.abs(rawPrice ?? 0);
    const decimals = a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
    const priceStr = rawPrice == null ? "—" : rawPrice.toFixed(decimals);
    const openPanel = (id: string) => emitAppEvent("chart-open-panel", { id });
    const noop = () => {};
    const ds = props.drawings ?? [];
    const nodes = buildChartContextMenu(
      {
        symbol: splitSymbol(props.symbol ?? "").ticker,
        price: priceStr,
        study: studyTitle,
        alertLabel: studyId && rawPrice != null ? studyAlertRow(studyId, rawPrice)?.label : undefined,
        drawingCount: ds.length,
        indicatorCount: (props.indicators ?? []).length,
        cursorLockByTime: crosshairLockTime() !== null,
        canPaste: hasClipboardContent(),
        canMoveChart: (props.layoutCount ?? 1) > 1,
        canApplyToLayout: (props.layoutCount ?? 1) > 1,
      },
      {
        resetView: () => cx.resetChartView(),
        copyPrice: () => { if (rawPrice != null) void navigator.clipboard?.writeText(priceStr); },
        paste: pasteClipboard,
        addAlert: () =>
          emitAppEvent("chart-open-alert-dialog", { symbol: props.symbol ?? "", price: rawPrice ?? undefined, indicatorId: studyId ?? undefined }),
        // Accepted no-ops: Buy / Sell / Add order / Table view need a trading
        // backend + table view this port doesn't have.
        buy: noop,
        sell: noop,
        addOrder: noop,
        // Lock: the bar under the right click (its time); again = unlock.
        toggleCursorLock: () => {
          if (crosshairLockTime() !== null) { setCrosshairLockTime(null); return; }
          const xRel = cx.host ? e.clientX - cx.host.getBoundingClientRect().left : null;
          const t = xRel != null ? cx.chart?.timeScale().coordinateToTime(xRel) : null;
          if (t != null) setCrosshairLockTime(t as number);
        },
        tableView: noop,
        moveChart: (back) => emitAppEvent("chart-move-in-layout", { back }),
        applyToLayout: () => emitAppEvent("chart-apply-studies-to-layout"),
        objectTree: () => openPanel("object_tree"),
        saveTemplateAs: () => emitAppEvent("chart-save-template"),
        // Bulk path when available — one undo entry for the whole set.
        removeDrawings: () => {
          if (ds.length > 1 && props.removeDrawings) props.removeDrawings(ds.map((d) => d.id));
          else for (const d of ds) props.removeDrawing?.(d.id);
        },
        removeIndicators: () => emitAppEvent("chart-clear-indicators"),
        settings: () => emitAppEvent("chart-open-settings"),
      },
    );
    setCtxMenu({ x: e.clientX, y: e.clientY, nodes });
  }

  /** Plus button → crosshair menu of the pane under it: an "Add alert on
   *  SOURCE at PRICE" row per source on that scale (plusAlertRows), then (no
   *  trading items: no broker) "Draw horizontal line at PRICE" on the pane's
   *  main source (the series, else the pane's first study). */
  function openPlusMenu(r: DOMRect, yAbs: number) {
    const paneIdx = cx.plusPane();
    const box = cx.paneBoxes().find((b) => b.index === paneIdx);
    const y = yAbs - (box?.top ?? 0);
    const owner = paneIdx > 0 ? cx.controller?.ownerOfPane(paneIdx) ?? null : null;
    const main = paneIdx > 0 ? (owner ? cx.controller?.studySeries(owner) ?? null : null) : cx.series;
    if (!main) return;
    const price = main.coordinateToPrice(y);
    if (price == null) return;
    const p = price as number;
    const priceStr = main.priceFormatter().format(p);
    const alerts = plusAlertRows(paneIdx, y);
    const nodes: CtxNode[] = [
      ...alerts,
      ...(alerts.length ? [{ kind: "separator" } as CtxNode] : []),
      { kind: "item", id: "plus-hline", label: `Draw horizontal line at ${priceStr}`, shortcut: "Alt + H", icon: <Icon name="draw-horizontal-line" size={18} />,
        onSelect: () => {
          const last = cx.raw.length > 0 ? cx.raw[cx.raw.length - 1] : null;
          if (!last) return;
          const id = props.onPlace?.({ kind: "horizontal-line", points: [{ time: last.time as number, price: p }], style: defaultStyleFor("horizontal-line"), ...(owner ? { owner } : {}) } as never);
          if (id) props.setSelectedDrawingId?.(id);
        } },
    ];
    setCtxMenu({ x: r.left, y: r.top, nodes });
  }

  function openPaneMenu(e: MouseEvent, i: number) {
    const a = cx.paneActions(i);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const nodes: CtxNode[] = [];
    const ico = (svg: string) => <span class="ot-pane-menu-icon" innerHTML={svg} />;
    if (a.collapse) nodes.push({ kind: "item", id: "pane-collapse", label: "Collapse pane", shortcut: "Ctrl + Double click", icon: ico(PANE_MENU_ICONS.collapse), onSelect: () => cx.toggleCollapse(i) });
    if (a.restore) nodes.push({ kind: "item", id: "pane-restore", label: "Restore pane", shortcut: "Ctrl + Double click", icon: ico(PANE_MENU_ICONS.restore), onSelect: () => cx.toggleCollapse(i) });
    if (a.up) nodes.push({ kind: "item", id: "pane-up", label: "Move pane up", icon: ico(PANE_MENU_ICONS.up), onSelect: () => cx.movePane(i, -1) });
    if (a.down) nodes.push({ kind: "item", id: "pane-down", label: "Move pane down", icon: ico(PANE_MENU_ICONS.down), onSelect: () => cx.movePane(i, 1) });
    if (a.close) nodes.push({ kind: "item", id: "pane-delete", label: "Delete pane", icon: ico(PANE_MENU_ICONS.del), onSelect: () => cx.deletePane(i) });
    // The menu attaches under the button, right-aligned (clientX = right).
    setCtxMenu({ x: r.right, y: r.bottom + 3, nodes });
  }

  return {
    alertTarget,
    openCompareMoreMenu,
    openContextMenu,
    openIndicatorMoreMenu,
    openPaneMenu,
    openPlusMenu,
    openPriceScaleMenu,
    openSeriesMoreMenu,
  };
}
