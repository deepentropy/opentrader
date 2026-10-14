/*
 * Price-axis overlays of a chart view (Scales tab rows): currency label, the
 * A / L scale-mode buttons, the crosshair plus button and the axis corner
 * button, with the scale geometry they are laid out on.
 */
import { Show, createSignal } from "solid-js";
import { typeIdOf } from "../indicators/study-id";
import { PriceScaleMode } from "lightweight-charts";
import { readChartTokens } from "../chart-tokens";
import { isDarkColor } from "../history-end-marker";
import { Tooltip } from "../../../components/Tooltip";
import { type NavButtonsBehavior } from "../../header/chart-settings";
import { splitSymbol } from "../../../data/datafeed";
import { getIndicatorEntry } from "../indicators/registry";
import { type ChartCx } from "./context";
import type { Accessor, JSX, Setter } from "solid-js";

/** What createPriceAxis adds to the chart context. */
export interface PriceAxisApi {
  PriceAxisOverlays: () => JSX.Element;
  currency: Accessor<string>;
  fitPriceScaleOnce: () => void;
  legendLeft: Accessor<number>;
  readonly plusEl: HTMLButtonElement | undefined;
  plusPane: Accessor<number>;
  plusPressed: boolean;
  plusY: Accessor<number | null>;
  refreshScaleOverlays: () => void;
  scaleGeom: Accessor<{
    w: number;
    h: number;
    th: number;
    left: boolean;
  } | null>;
  setAxisHover: Setter<number | null>;
  setChartHovered: Setter<boolean>;
  setCurrency: Setter<string>;
  setPlusPane: Setter<number>;
  setPlusY: Setter<number | null>;
}

export function createPriceAxis(cx: ChartCx): PriceAxisApi {
  const { appearance, ctxMenu, currentTokens, props } = cx;
  // ── Price-axis overlays (Scales tab rows) ────────────────────────────
  // These are DOM on the price axis: the currency label at its top
  // ("Currency and Unit"), the A / L buttons at its bottom ("Scale modes (A
  // and L)"), both "Visible on mouse over" by default = while the pointer is
  // over the chart; and the crosshair "+" button (Scales → "Plus button").
  // Pane index whose price axis is under the pointer (A / L buttons
  // "Visible on mouse over" = that axis hovered; currency label = any price
  // axis of the chart hovered).
  const [axisHover, setAxisHover] = createSignal<number | null>(null);
  // th: height of the time axis (the axis corner button's height).
  const [scaleGeom, setScaleGeom] = createSignal<{ w: number; h: number; th: number; left: boolean } | null>(null);
  const [scaleModes, setScaleModes] = createSignal({ auto: true, log: false });
  // Axis corner button (the time axis' corner under the price axis): a gear
  // drawn while this chart is the active or the hovered one; hovered (or its
  // menu open) it is filled and the main pane's price axis is tinted with half
  // the fill; click = the main price scale's menu above it; tooltip = the
  // sources on that scale (the series, then its studies, top-most first).
  const [chartHovered, setChartHovered] = createSignal(false);
  const [cornerHover, setCornerHover] = createSignal(false);
  let cornerMenuWasOpen = false;
  const cornerLit = () => cornerHover() || !!ctxMenu()?.corner;
  const cornerTitles = () => {
    const { ticker, exchange } = splitSymbol(props.symbol ?? "");
    const out = [`${exchange ? `${ticker} · ${exchange}` : ticker}, ${props.interval ?? "1D"}`];
    for (const id of [...(cx.controller?.mainScaleIds() ?? [])].reverse()) {
      const entry = getIndicatorEntry(typeIdOf(id));
      if (entry) out.push(entry.shortName ?? entry.name);
    }
    for (const e of cx.compareEntries()) if (e.placement === "percent") out.push(cx.compareTitle(e));
    return out.join("\n");
  };
  const [plusY, setPlusY] = createSignal<number | null>(null);
  /** Pane under the plus button (its y is from the top of the first pane). */
  const [plusPane, setPlusPane] = createSignal(0);
  // The plus is drawn inside the pane and hit-tested there, so the button
  // takes no pointer events (the crosshair keeps tracking under it) and the
  // host hit-tests its rect in the capture phase.
  let plusEl: HTMLButtonElement | undefined;
  let plusPressed = false;
  const [currency, setCurrency] = createSignal("");
  /** Width of a visible left price scale: the legends start right of it. */
  const [legendLeft, setLegendLeft] = createSignal(0);
  function refreshScaleOverlays() {
    if (!cx.chart) return;
    let lw = 0;
    // The scale widget is not built before the first layout (width throws).
    try { lw = cx.chart.options().leftPriceScale.visible ? cx.chart.priceScale("left").width() : 0; } catch { /* not laid out yet */ }
    setLegendLeft((v) => (v === lw ? v : lw));
    const side = currentTokens().scalesPlacement;
    const ps = cx.chart.priceScale(side);
    const w = ps.width();
    const h = cx.chart.paneSize(0).height;
    const th = cx.chart.options().timeScale.visible === false ? 0 : cx.chart.timeScale().height();
    setScaleGeom((g) => (g && g.w === w && g.h === h && g.th === th && g.left === (side === "left") ? g : { w, h, th, left: side === "left" }));
    const o = ps.options();
    const next = { auto: !!o.autoScale, log: o.mode === PriceScaleMode.Logarithmic };
    setScaleModes((m) => (m.auto === next.auto && m.log === next.log ? m : next));
  }
  const overlayVisible = (b: NavButtonsBehavior, hovered: boolean) => b === "alwaysOn" || (b === "visibleOnMouseOver" && hovered);
  /** Symbol change with auto scale off: the price scale is fitted to the new
   *  symbol's visible bars once, then stays manual (the old symbol's price
   *  range would leave the new candles out of view). */
  function fitPriceScaleOnce() {
    if (!cx.chart) return;
    const ps = cx.chart.priceScale(currentTokens().scalesPlacement);
    if (ps.options().autoScale) return;
    ps.applyOptions({ autoScale: true });
    // The fitted range exists after the next paint; freezing keeps it.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!cx.chart) return;
      cx.chart.priceScale(currentTokens().scalesPlacement).applyOptions({ autoScale: false });
      refreshScaleOverlays();
    }));
  }
  function toggleAutoScale() {
    if (!cx.chart) return;
    const ps = cx.chart.priceScale(currentTokens().scalesPlacement);
    ps.applyOptions({ autoScale: !ps.options().autoScale });
    refreshScaleOverlays();
  }
  function toggleLogScale() {
    if (!cx.chart) return;
    const ps = cx.chart.priceScale(currentTokens().scalesPlacement);
    const log = ps.options().mode === PriceScaleMode.Logarithmic;
    ps.applyOptions({ mode: log ? PriceScaleMode.Normal : PriceScaleMode.Logarithmic });
    refreshScaleOverlays();
  }

  function PriceAxisOverlays() {
    return (
      <Show when={scaleGeom()}>
        {(g) => (
          <>
            {/* Currency label (12 px row). */}
            <Show when={currency() && overlayVisible(appearance().currencyUnit ?? "visibleOnMouseOver", axisHover() !== null)}>
              <div class="ot-price-currency" style={{ [g().left ? "left" : "right"]: "0px", width: `${g().w}px` }}>
                <div class="ot-price-currency-box" style={{ "background-color": readChartTokens(appearance()).bg }}>
                  <div class="ot-price-currency-row" style={{ "font-size": `${readChartTokens(appearance()).scaleFontSize}px` }} title="Currency">
                    {/* No dropdown arrow: the reference menu converts the chart to
                        another currency, which needs intraday exchange rates
                        the data plan does not serve. */}
                    <span>{currency()}</span>
                  </div>
                </div>
              </div>
            </Show>
            {/* Auto / Log buttons (price-scale mode buttons). */}
            <Show when={overlayVisible(appearance().scaleModes ?? "visibleOnMouseOver", axisHover() === 0)}>
              <div class="ot-price-modes" style={{ [g().left ? "left" : "right"]: "0px", top: `${g().h - 30}px`, width: `${g().w}px` }}>
                <div class="ot-price-mode-wrap">
                  <button type="button" class={`ot-price-mode${scaleModes().auto ? " is-on" : ""}`} title="Auto (fits data to screen)" aria-label="Toggle auto scale" onClick={toggleAutoScale}>A</button>
                </div>
                <div class="ot-price-mode-wrap">
                  <button type="button" class={`ot-price-mode${scaleModes().log ? " is-on" : ""}`} title="Logarithmic" aria-label="Toggle log scale" onClick={toggleLogScale}>L</button>
                </div>
              </div>
            </Show>
            {/* Crosshair plus button (on the pane side of
                the crosshair price label). */}
            <Show when={appearance().plusButton !== false && plusY() !== null ? plusY() : null}>
              {(y) => {
                const size = () => readChartTokens(appearance()).scaleFontSize + 10;
                return (
                  <button
                    ref={plusEl}
                    type="button"
                    tabIndex={-1}
                    class={`ot-price-plus${g().left ? " is-left" : ""}`}
                    style={{
                      [g().left ? "left" : "right"]: `${g().w}px`,
                      top: `${Math.round(y() - size() / 2)}px`,
                      width: `${size()}px`,
                      height: `${size()}px`,
                      background: readChartTokens(appearance()).crosshairLabelBg,
                    }}
                    aria-label="Plus"
                  >
                    <svg viewBox="0 0 22 22" width={size()} height={size()} aria-hidden="true">
                      <path fill="currentColor" d="M10.5 7h1v8h-1zM7 10.5h8v1H7z" />
                      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1" />
                    </svg>
                  </button>
                );
              }}
            </Show>
            {/* Axis corner button: fill #2E2E2E dark / #EBEBEB light; the
                axis tint is that colour at 50 % (blended under the labels). */}
            <Show when={g().th > 0}>
              {(_) => {
                const dark = () => isDarkColor(readChartTokens(appearance()).bg);
                const side = () => (g().left ? "left" : "right");
                return (
                  <>
                    <Show when={cornerLit()}>
                      <div
                        class="ot-axis-corner-tint"
                        style={{
                          [side()]: "0px",
                          top: "0px",
                          width: `${g().w}px`,
                          height: `${g().h}px`,
                          background: dark() ? "rgba(46, 46, 46, 0.5)" : "rgba(235, 235, 235, 0.5)",
                          "mix-blend-mode": dark() ? "lighten" : "darken",
                        }}
                      />
                    </Show>
                    <Tooltip text={cornerTitles()} side="top">
                      <div
                        class="ot-axis-corner"
                        data-name="axis-corner"
                        style={{
                          [side()]: "0px",
                          width: `${g().w}px`,
                          height: `${g().th}px`,
                          background: cornerLit() ? (dark() ? "#2E2E2E" : "#EBEBEB") : undefined,
                          color: dark() ? "#DBDBDB" : "#0F0F0F",
                        }}
                        onMouseEnter={() => setCornerHover(true)}
                        onMouseLeave={() => setCornerHover(false)}
                        // The menu closes on any press (capture): a press on the
                        // button while its menu is open only closes it.
                        onPointerDown={() => { cornerMenuWasOpen = !!ctxMenu()?.corner; }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onDblClick={(e) => e.stopPropagation()}
                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (cornerMenuWasOpen) { cornerMenuWasOpen = false; return; }
                          cx.openPriceScaleMenu(e, (e.currentTarget as HTMLElement).getBoundingClientRect());
                        }}
                      >
                        <Show when={props.active || chartHovered()}>
                          <svg viewBox="0 0 15 13" width="15" height="13" aria-hidden="true">
                            <path fill="currentColor" fill-rule="evenodd" d="M4.1 1 1.14 6.5 4.1 12h6.8l2.96-5.5L10.9 1H4.1ZM15 6.5 11.5 0h-8L0 6.5 3.5 13h8L15 6.5ZM7.5 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
                          </svg>
                        </Show>
                      </div>
                    </Tooltip>
                  </>
                );
              }}
            </Show>
          </>
        )}
      </Show>
    );
  }

  return {
    PriceAxisOverlays,
    currency,
    fitPriceScaleOnce,
    legendLeft,
    get plusEl() {
      return plusEl;
    },
    plusPane,
    get plusPressed() {
      return plusPressed;
    },
    set plusPressed(v: typeof plusPressed) {
      plusPressed = v;
    },
    plusY,
    refreshScaleOverlays,
    scaleGeom,
    setAxisHover,
    setChartHovered,
    setCurrency,
    setPlusPane,
    setPlusY,
  };
}
