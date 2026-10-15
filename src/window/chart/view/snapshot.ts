/*
 * Pictures and data of a chart view: the snapshot image (layout-snapshot.ts),
 * the Alt + S actions and the "Download chart data" source.
 */
import { onCleanup, onMount } from "solid-js";
import { readFontFamily } from "../chart-tokens";
import { type PriceSource } from "../../header/chart-settings";
import { priceOf } from "../series-transforms";
import { registerChartExport, type ExportColumn } from "../chart-export";
import {
  layoutSnapshot,
  legendLine,
  registerSnapshotSource,
  snapshotTheme,
  type ChartSnapshot,
  type LegendRun,
  type LegendValue,
} from "../layout-snapshot";
import { compareSource } from "../compare/compare-style";
import { isIntradayInterval, splitSymbol } from "../../../data/datafeed";
import { commands } from "../../../bindings";
import { legendShowsSingleValue, type ChartTypeId, type OHLC } from "../chart-types";
import { type ChartCx } from "./context";

/** What createSnapshot adds to the chart context. */
export interface SnapshotApi {
  takeSnapshot: (action?: "copy" | "download" | "open") => Promise<void>;
}

export function createSnapshot(cx: ChartCx): SnapshotApi {
  const { appearance, currentTokens, indLegend, mainPriceSource, paneId, props, refreshIndicatorLegend, refreshLegend } = cx;
  // "Download chart data" source: time, the main series values, the visible
  // studies' plots, then the compared symbols (chart-export.ts).
  const exportData = (): { times: number[]; columns: ExportColumn[] } => {
    const bars = cx.raw;
    const times = bars.map((b) => b.time as number);
    const col = (title: string, rows: OHLC[], f: (b: OHLC) => number): ExportColumn => ({
      title,
      values: new Map(rows.map((b) => [b.time as number, f(b)])),
    });
    const ohlcColumns = (type: string, src: PriceSource, rows: OHLC[], prefix: string): ExportColumn[] => {
      const t = (s: string) => prefix + s;
      if (type === "hilo") return [col(t("high"), rows, (b) => b.high), col(t("low"), rows, (b) => b.low)];
      if (type === "hlcArea" || type === "hlcBars")
        return [col(t("high"), rows, (b) => b.high), col(t("low"), rows, (b) => b.low), col(t("close"), rows, (b) => b.close)];
      if (legendShowsSingleValue(type as ChartTypeId)) return [col(t(src), rows, (b) => priceOf(b, src))];
      return [
        col(t("open"), rows, (b) => b.open),
        col(t("high"), rows, (b) => b.high),
        col(t("low"), rows, (b) => b.low),
        col(t("close"), rows, (b) => b.close),
      ];
    };
    const columns = ohlcColumns(cx.activeType, mainPriceSource(), bars, "");
    columns.push(...(cx.controller?.exportColumns() ?? []));
    for (const e of cx.compareEntries()) {
      const layer = cx.compareLayers.get(e.id);
      if (!layer || e.hidden) continue;
      columns.push(...ohlcColumns(e.style.style, compareSource(e.style), layer.loadedBars, `${cx.compareTitle(e)}: `));
    }
    return { times, columns };
  };
  onCleanup(
    registerChartExport(paneId, {
      title: () => `${props.symbol ?? ""}, ${props.interval ?? "1D"}`,
      shown: () => props.shown !== false,
      active: () => !!props.active,
      host: () => cx.host,
      timeZone: () => props.timeZone ?? "UTC",
      dwm: () => !isIntradayInterval(props.interval ?? "1D"),
      data: exportData,
    }),
  );

  // ── Snapshot picture (layout-snapshot.ts) ──────────────────────────────
  // The chart canvas (no crosshair, no alert labels), the drawings in front
  // of the series painted over it, the currency label of the price axis,
  // and the legend lines of each pane (values of the latest bar).
  /** Legend lines per pane, read from the legends on screen. */
  function snapshotLegendPanes(leftW: number): ChartSnapshot["panes"] {
    if (!cx.chart) return [];
    const lines = new Map<number, LegendRun[][]>();
    const add = (pane: number, line: LegendRun[]) => lines.set(pane, [...(lines.get(pane) ?? []), line]);
    const valueOf = (el: Element): LegendValue => {
      const item = el.classList.contains("ot-legend-value-item");
      const v = item ? el.querySelector(".ot-legend-value-value") ?? el : el;
      return {
        title: item ? el.querySelector(".ot-legend-value-title")?.textContent?.trim() ?? "" : "",
        value: v.textContent?.trim() ?? "",
        color: getComputedStyle(v).color,
      };
    };
    // Series row: shown when the status line shows its title.
    const item = cx.paneRoot.querySelector(".ot-legend-item");
    if (item && appearance().legendTitle !== false) {
      const title = [...item.querySelectorAll(".ot-legend-titles .ot-legend-title-piece")]
        .map((p) => [...p.childNodes].filter((n) => !(n instanceof Element && n.classList.contains("ot-legend-logo"))).map((n) => n.textContent ?? "").join("").trim())
        .filter(Boolean)
        .join(" · ");
      add(cx.mainPane(), legendLine(title, [...item.querySelectorAll(".ot-legend-values > *")].map(valueOf)));
    }
    // Studies and compared symbols: the shown ones, values without titles.
    for (const row of cx.paneRoot.querySelectorAll<HTMLElement>(".ot-ind-legend-row")) {
      if (row.classList.contains("is-hidden")) continue;
      const pane = indLegend().find((r) => r.id === row.dataset.entityId)?.pane ?? cx.mainPane();
      const title = row.querySelector(".ot-ind-legend-title")?.textContent?.trim() ?? "";
      add(pane, legendLine(title, [...row.querySelectorAll(".ot-ind-legend-val")].map((v) => ({ ...valueOf(v), title: "" }))));
    }
    return cx.paneBoxes().map((b) => ({
      left: leftW,
      width: cx.chart!.paneSize(b.index).width,
      top: b.top,
      height: b.height,
      lines: lines.get(b.index) ?? [],
    }));
  }
  /** The drawings in front of the series (overlay order), each clipped to
   *  its pane; images are loaded by a first pass. */
  async function paintSnapshotDrawings(ctx: CanvasRenderingContext2D, dpr: number, leftW: number) {
    const paint = cx.sunkPainter;
    if (!cx.chart || !paint) return;
    const sunk = cx.sunkIds();
    const byId = new Map((props.drawings ?? []).map((d) => [d.id, d]));
    const order: string[] = [];
    for (const el of cx.paneRoot.querySelectorAll("[data-drawing-id]")) {
      const id = el.getAttribute("data-drawing-id") ?? "";
      if (byId.has(id) && !sunk.has(id) && !order.includes(id)) order.push(id);
    }
    if (order.length === 0) return;
    const frames = cx.drawingPanes();
    const plotW = cx.chart.paneSize(0).width;
    const boxes = cx.paneBoxes();
    const allH = boxes.length ? boxes[boxes.length - 1].top + boxes[boxes.length - 1].height : 0;
    const draw = (c: CanvasRenderingContext2D, onAsyncLoad?: () => void) => {
      for (const id of order) {
        const d = byId.get(id)!;
        const f = frames.find((p) => p.key === (d.owner ?? null));
        if (!f) continue;
        const extended = d.kind === "vertical-line" && d.style.extendLine !== false;
        c.save();
        c.scale(dpr, dpr);
        c.beginPath();
        if (extended) c.rect(leftW, 0, plotW, allH);
        else c.rect(leftW, f.top, plotW, f.height);
        c.clip();
        c.translate(leftW, f.top);
        paint(c, id, f.key, onAsyncLoad);
        c.restore();
      }
    };
    // First pass on a scratch canvas: starts the image loads.
    let loads = 0;
    const scratch = document.createElement("canvas").getContext("2d");
    if (scratch) draw(scratch, () => loads++);
    await new Promise((r) => setTimeout(r, 150));
    if (loads > 0) await new Promise((r) => setTimeout(r, 150));
    draw(ctx);
  }
  /** Currency label at the top of the price axis (4 px margin, 26 px box,
   *  radius 4, divider border, text 13 px from the axis edge). */
  function paintSnapshotCurrency(ctx: CanvasRenderingContext2D, dpr: number, leftW: number) {
    if (!cx.chart || !cx.currency() || (appearance().currencyUnit ?? "visibleOnMouseOver") === "alwaysOff") return;
    const t = currentTokens();
    // At the top of the series' price axis.
    const side = cx.mainSide();
    const left = side === "left";
    const w = cx.chart.priceScale(side).width();
    const x = left ? 0 : leftW + cx.chart.paneSize(0).width;
    const top = cx.paneBoxes().find((b) => b.index === cx.mainPane())?.top ?? 0;
    const css = getComputedStyle(cx.paneRoot);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.beginPath();
    ctx.roundRect(x + 4, top + 4, Math.ceil(w / 2) * 2 - 8, 26, 4);
    ctx.fillStyle = t.bg;
    ctx.strokeStyle = css.getPropertyValue("--color-divider").trim() || "#4A4A4A";
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = css.getPropertyValue("--color-text-primary").trim() || "#DBDBDB";
    ctx.font = `${t.scaleFontSize}px ${readFontFamily()}`;
    ctx.textBaseline = "middle";
    ctx.fillText(cx.currency(), x + 13, top + 17);
    ctx.restore();
  }
  async function snapshotPicture(): Promise<ChartSnapshot | null> {
    if (!cx.chart) return null;
    const dpr = window.devicePixelRatio || 1;
    let leftW = 0;
    try { leftW = cx.chart.options().leftPriceScale.visible ? cx.chart.priceScale("left").width() : 0; } catch { /* not laid out yet */ }
    // The image shows the latest bar's values, whatever the crosshair.
    refreshLegend();
    refreshIndicatorLegend();
    const panes = snapshotLegendPanes(leftW);
    refreshLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
    refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
    for (const p of cx.alertLabelPrims.values()) p.setState({ printing: true });
    let canvas: HTMLCanvasElement;
    try {
      // With the top layer: the last price plate and the event markers are
      // drawn there (the crosshair stays out).
      canvas = cx.chart.takeScreenshot(true);
    } finally {
      for (const p of cx.alertLabelPrims.values()) p.setState({ printing: false });
    }
    const ctx = canvas.getContext("2d");
    if (ctx) {
      await paintSnapshotDrawings(ctx, dpr, leftW);
      paintSnapshotCurrency(ctx, dpr, leftW);
    }
    return {
      rect: cx.paneRoot.getBoundingClientRect(),
      canvas,
      dpr,
      textColor: currentTokens().scaleTextColor,
      fontFamily: readFontFamily(),
      panes,
    };
  }
  onMount(() => onCleanup(registerSnapshotSource(cx.paneRoot, snapshotPicture)));

  // Snapshot (Alt+S): the image of the whole shown layout (layout-snapshot.ts)
  // copied to the clipboard ("Copy image"); fall back to a PNG download
  // where the async clipboard image API isn't available. "open" is the
  // local backing for "Open in new tab": temp page in the default web
  // browser. File name: "<ticker>_<yyyy-MM-dd>_<HH-mm-ss>" (local time).
  const takeSnapshot = async (action: "copy" | "download" | "open" = "copy") => {
    if (!cx.chart) return;
    const grid = cx.paneRoot.closest<HTMLElement>(".chart-grid");
    const canvas = grid ? await layoutSnapshot(grid, snapshotTheme(props.theme ?? "dark"), props.timeZone) : null;
    if (!canvas) return;
    const now = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}_${p2(now.getHours())}-${p2(now.getMinutes())}-${p2(now.getSeconds())}`;
    const ticker = `${splitSymbol(props.symbol ?? "").ticker || "chart"}_${stamp}`;
    if (action === "open") {
      const b64 = canvas.toDataURL("image/png").split(",")[1] ?? "";
      void commands.openSnapshot(b64).then((r) => {
        if (r.status === "error") console.warn("[snapshot] open failed:", r.error);
      });
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      if (action === "copy") {
        try {
          if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
            void navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            return;
          }
        } catch {
          /* fall through to download */
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${ticker.replace(/[\/:*?"<>|]/g, "_")}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  };

  return {
    takeSnapshot,
  };
}
