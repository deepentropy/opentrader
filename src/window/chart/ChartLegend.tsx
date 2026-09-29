/*
 * ChartLegend — the data window overlaid on the top-left of the main chart
 * pane. Ported to SolidJS from the reference mock.
 *
 * The main source row is ONE flex line (h:24):
 *
 *   [logo] <symbol> · <interval> · <exchange>  [flag link eye more]   O H L C  <change>
 *   └────────── noWrapWrapper (titles + actions) ─────────────┘       └─ valuesWrapper ─┘
 *
 * O/H/L/C + change live on the SAME line as the title. The action buttons are
 * revealed on hover. Values track the crosshair (ChartView feeds the
 * hovered/latest bar in) and are coloured by the bar's direction.
 *
 * Purely presentational: ChartView owns the crosshair subscription and hands
 * down a resolved `LegendValues` (or null while the pane is still loading).
 */
import { Show, type JSX } from "solid-js";
import { Tooltip } from "../../components/Tooltip";

/** Resolved, display-ready values for the legend's values line. Built by
 *  ChartView from the hovered (or latest) bar; see `buildLegend` there. */
export type LegendValues = {
  /** TRUE → show a single value (line/area family); FALSE → full O/H/L/C. */
  single: boolean;
  open: number;
  high: number;
  low: number;
  close: number;
  /** close − previous bar's close (0 when there is no prior bar). */
  changeAbs: number;
  /** changeAbs ÷ previous close, as a percentage. */
  changePct: number;
  /** Bar direction (close ≥ open) — colours the O/H/L/C numbers. */
  barDir: "up" | "down";
  /** Change sign (changeAbs ≥ 0) — colours the single value + change item. */
  changeDir: "up" | "down";
  /** Bar volume (absent when the history path didn't supply it). */
  volume?: number;
  /** Change vs the previous day's close (0 when there's no prior day). */
  lastDayChangeAbs: number;
  lastDayChangePct: number;
  lastDayChangeDir: "up" | "down";
};

type Props = {
  /** Ticker shown as the main title piece (the fresh-install default field). */
  ticker: string;
  /** Interval suffix as it appears in the tab title ("1D", "5", "1H", "10S"). */
  interval: string;
  /** Exchange prefix ("NASDAQ", "FX", "CRYPTOCAP"). */
  exchange: string;
  /** Resolved O/H/L/C + change, or null while the pane is still loading. */
  values: LegendValues | null;
  /** Status line → Title select: "Name" (company name) | "Symbol" | "Symbol
   *  and name" (title source: description / ticker /
   *  ticker-and-description). Undefined = ticker. */
  titleMode?: string;
  /** Company name for the "Name" modes ("" until the ticker-info fetch lands —
   *  the ticker is shown as the fallback). */
  description?: string;
  /** Status-line part visibility (Settings → Status line). Undefined = shown. */
  showLogo?: boolean;
  showTitle?: boolean;
  showChartValues?: boolean;
  showBarChange?: boolean;
  showVolume?: boolean;
  showLastDayChange?: boolean;
  /** US market session now (data/market-session). */
  marketStatus?: "open" | "pre" | "post" | "closed";
  /** Status line → "Open market status": hides only the OPEN icon; pre /
   *  post / closed statuses always show. */
  showOpenStatus?: boolean;
  /** Status line hides bar-change / last-day-change for High-low and
   *  Session volume profile. */
  hideChangeValues?: boolean;
  /** Main series hidden by the legend eye (series `visible` = false):
   *  dimmed titles, no values, "Show" + crossed eye. */
  seriesHidden?: boolean;
  /** Legend eye clicked. */
  onToggleSeries?: () => void;
  /** Symbol title clicked ("Change symbol": symbol search). */
  onChangeSymbol?: () => void;
  /** Interval clicked ("Change interval": the change interval dialog). */
  onChangeInterval?: () => void;
  /** More button clicked (the series menu under the button); gets the button
   *  rect. */
  onMore?: (anchor: DOMRect) => void;
};

/** Exchange full names of the legend exchange piece (its title, e.g.
 *  "Arca — NYSE Arca", as in the symbol search). Other exchanges get no
 *  tooltip. */
const EXCHANGE_TITLES: Record<string, string> = {
  NASDAQ: "NASDAQ — NASDAQ Stock Market",
  NYSE: "NYSE — New York Stock Exchange",
  "NYSE ARCA": "Arca — NYSE Arca",
  ARCA: "Arca — NYSE Arca",
  AMEX: "AMEX — NYSE American",
};

/** Market-status pill items (small icons; colours from the dark theme). */
const STATUS_ITEMS: Record<"open" | "pre" | "post" | "closed", { title: string; color: string; overlay: string; path: string }> = {
  open: { title: "Market open", color: "#42bda8", overlay: "#22ab9433", path: "M9 5a4 4 0 1 1 0 8 4 4 0 0 1 0-8" },
  pre: { title: "Pre-market", color: "#ff9100", overlay: "#ff980033", path: "M9 7.2a3.48 3.48 0 0 1 3.22 4.8 7 7 0 0 0-6.44 0A3.47 3.47 0 0 1 9 7.2M4.4 8.59l-.33 1.24L2 9.27l.33-1.24zm11.6.68-2.06.56-.34-1.24 2.07-.56zM7.55 5.94l-1.17.55-.9-1.94L6.64 4zm4.97-1.4-.9 1.94-1.17-.54.9-1.94z" },
  post: { title: "Post-market", color: "#82b1ff", overlay: "#448aff33", path: "M12.57 5.5h-.07a3.5 3.5 0 1 0 .07 7A4.98 4.98 0 0 1 4 9a5 5 0 0 1 8.57-3.5" },
  closed: { title: "Market closed", color: "#b8b8b8", overlay: "#b8b8b833", path: "M12 7a2 2 0 1 1 0 4H6a2 2 0 1 1 0-4z" },
};

/** Compact volume ("1.23 M"), mirroring the studies legend. */
function fmtVolume(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)} B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)} M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)} K`;
  return `${v}`;
}

// Unicode minus (U+2212): negative changes render with it, not the ASCII
// hyphen-minus, so "−8.84" lines up with the digits.
const MINUS = "−";

// Action-button icons of the legend buttonsWrapper. flag is a 12-viewBox
// glyph; the rest are 18-viewBox. Components, not module-level JSX: a JSX
// constant is ONE DOM node, which the next legend (another chart) would take
// away.
const ICON_FLAG = () => (
  <svg viewBox="0 0 12 12" width="14" height="14" fill="none">
    <path fill="currentColor" d="M11.57 0H1a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10.57a.5.5 0 0 0 .41-.78l-3.3-4.94a.5.5 0 0 1 0-.56l3.3-4.94a.5.5 0 0 0-.41-.78z" />
  </svg>
);
const ICON_LINK = () => (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" d="M10.31 4.13 8.3 6.14a.5.5 0 1 1-.7-.7l2.13-2.12a3.5 3.5 0 1 1 4.95 4.95l-2.11 2.11a.51.51 0 1 1-.73-.72l2-2a2.5 2.5 0 0 0-3.53-3.53Zm-2.14 9.3 2.01-2a.5.5 0 0 1 .7.69l-2.13 2.12A3.5 3.5 0 0 1 3.8 9.29l2.11-2.11a.51.51 0 0 1 .72.72l-2 2a2.5 2.5 0 0 0 3.54 3.54ZM11 7.02a.49.49 0 0 0-.69 0L7.47 9.87a.49.49 0 0 0 .68.69l2.86-2.86a.49.49 0 0 0 0-.7Z" />
  </svg>
);
const ICON_EYE = () => (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" fill-rule="evenodd" d="M12 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm-1 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
    <path fill="currentColor" d="M16.91 8.8C15.31 4.99 12.18 3 9 3 5.82 3 2.7 4.98 1.08 8.8L1 9l.08.2C2.7 13.02 5.82 15 9 15c3.18 0 6.3-1.97 7.91-5.8L17 9l-.09-.2ZM9 14c-2.69 0-5.42-1.63-6.91-5 1.49-3.37 4.22-5 6.9-5 2.7 0 5.43 1.63 6.92 5-1.5 3.37-4.23 5-6.91 5Z" />
  </svg>
);
/** Crossed eye (hidden series) — same glyph as the study legend. */
const ICON_EYE_CROSSED = () => (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" d="M3.7 15 15 3.7l-.7-.7L3 14.3l.7.7ZM9 3c1.09 0 2.17.23 3.19.7l-.77.76C10.64 4.16 9.82 4 9 4 6.31 4 3.58 5.63 2.08 9a9.35 9.35 0 0 0 1.93 2.87l-.7.7A10.44 10.44 0 0 1 1.08 9.2L1 9l.08-.2C2.69 4.99 5.82 3 9 3Z" />
    <path fill="currentColor" d="M9 6a3 3 0 0 1 .78.1l-.9.9A2 2 0 0 0 7 8.87l-.9.9A3 3 0 0 1 9 6ZM11.9 8.22l-.9.9A2 2 0 0 1 9.13 11l-.9.9a3 3 0 0 0 3.67-3.68Z" />
    <path fill="currentColor" d="M9 14c-.82 0-1.64-.15-2.43-.45l-.76.76c1.02.46 2.1.7 3.19.7 3.18 0 6.31-1.98 7.92-5.81L17 9l-.08-.2a10.44 10.44 0 0 0-2.23-3.37l-.7.7c.75.76 1.41 1.71 1.93 2.87-1.5 3.37-4.23 5-6.92 5Z" />
  </svg>
);
const ICON_MORE = () => (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" fill-rule="evenodd" d="M3 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm0 1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm6-1a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm0 1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm7-2a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm1 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
  </svg>
);

/** Decimals for a price, picked from its magnitude. The exact value comes
 *  from the instrument's min-tick; we approximate from the value. (GAP: pull
 *  the real precision from the symbol info.) */
function priceDecimals(p: number): number {
  const a = Math.abs(p);
  if (a >= 1) return 2;
  if (a >= 0.01) return 4;
  return 6;
}

/** Format a price with magnitude-derived precision. */
function fmtPrice(p: number): string {
  return p.toFixed(priceDecimals(p));
}

/** Signed value with the Unicode minus for negatives and a leading "+" for
 *  non-negatives — matches the legend's "<±abs> (<±pct>%)" change item. */
function fmtSigned(n: number, decimals: number): string {
  const sign = n < 0 ? MINUS : "+";
  return `${sign}${Math.abs(n).toFixed(decimals)}`;
}

/** One O/H/L/C cell: a dim letter title hugging its coloured value. */
function ValueItem(props: { letter: string; value: string; dir: "up" | "down" }) {
  return (
    <span class="ot-legend-value-item">
      <span class="ot-legend-value-title">{props.letter}</span>
      <span class={`ot-legend-value-value ot-legend-${props.dir}`}>{props.value}</span>
    </span>
  );
}

/** One legend action button (flag / link / eye / more). */
function ActionButton(props: { name: string; title: string; children: JSX.Element; flagged?: boolean; onClick?: (e: MouseEvent) => void }) {
  return (
    <button
      type="button"
      class={`ot-legend-action${props.flagged ? " is-flagged" : ""}`}
      data-action={props.name}
      title={props.title}
      aria-label={props.title}
      onMouseDown={(e) => { if (props.onClick) e.stopPropagation(); }}
      onClick={(e) => { if (!props.onClick) return; e.stopPropagation(); props.onClick(e); }}
    >
      {props.children}
    </button>
  );
}

export function ChartLegend(props: Props) {
  // Title select: "Name" swaps the symbol piece for the company name (ticker
  // until it loads); "Symbol and name" keeps the ticker and appends the name
  // as an extra dotted piece (before interval/exchange).
  const titleText = () =>
    props.titleMode === "Name" ? props.description || props.ticker : props.ticker;
  const showNamePiece = () =>
    (props.showTitle ?? true) && props.titleMode === "Symbol and name" && !!props.description;
  const changeText = () =>
    props.values
      ? `${fmtSigned(props.values.changeAbs, priceDecimals(props.values.close))} (${fmtSigned(props.values.changePct, 2)}%)`
      : "";
  const valueDir = () =>
    props.values ? (props.values.single ? props.values.changeDir : props.values.barDir) : "up";

  return (
    <div class="ot-legend">
      <div class="ot-legend-source">
        {/* item — one flex line: titles + actions, then the values. */}
        <div class={`ot-legend-item${props.seriesHidden ? " is-disabled" : ""}`} data-name="legend-source-item">
          <div class="ot-legend-nowrap">
            <div class="ot-legend-titles">
              {/* Main title "Change symbol" (withAction): opens the symbol search. */}
              <Tooltip text="Change symbol" side="bottom">
                <span
                  class="ot-legend-title-piece ot-legend-main ot-legend-with-action"
                  onMouseDown={(e) => { if (props.onChangeSymbol) e.stopPropagation(); }}
                  onClick={(e) => { if (!props.onChangeSymbol) return; e.stopPropagation(); props.onChangeSymbol(); }}
                >
                  <Show when={props.showLogo ?? true}>
                    <span class="ot-ticker-logo ot-legend-logo" aria-hidden="true">
                      {props.ticker.charAt(0)}
                    </span>
                  </Show>
                  <Show when={props.showTitle ?? true}>
                    <span class="ot-legend-symbol">{titleText()}</span>
                  </Show>
                </span>
              </Tooltip>
              {/* Description field: the same "Change symbol" action. */}
              <Show when={showNamePiece()}>
                <Tooltip text="Change symbol" side="bottom">
                  <span
                    class="ot-legend-title-piece ot-legend-dot ot-legend-with-action"
                    onMouseDown={(e) => { if (props.onChangeSymbol) e.stopPropagation(); }}
                    onClick={(e) => { if (!props.onChangeSymbol) return; e.stopPropagation(); props.onChangeSymbol(); }}
                  >
                    {props.description}
                  </span>
                </Tooltip>
              </Show>
              <Tooltip text="Change interval" side="bottom">
                <span
                  class="ot-legend-title-piece ot-legend-dot ot-legend-with-action"
                  onMouseDown={(e) => { if (props.onChangeInterval) e.stopPropagation(); }}
                  onClick={(e) => { if (!props.onChangeInterval) return; e.stopPropagation(); props.onChangeInterval(); }}
                >
                  {props.interval}
                </span>
              </Tooltip>
              <Show
                when={EXCHANGE_TITLES[props.exchange.toUpperCase()]}
                fallback={<span class="ot-legend-title-piece ot-legend-dot">{props.exchange}</span>}
              >
                {(t) => (
                  <Tooltip text={t()} side="bottom">
                    <span class="ot-legend-title-piece ot-legend-dot">{props.exchange}</span>
                  </Tooltip>
                )}
              </Show>
            </div>
            <div class="ot-legend-actions" data-name="actions">
              <ActionButton name="flag" title="Flag symbol"><ICON_FLAG /></ActionButton>
              <ActionButton name="link" title="Symbol/interval chart syncing"><ICON_LINK /></ActionButton>
              <ActionButton name="eye" title={props.seriesHidden ? "Show" : "Hide"} onClick={props.onToggleSeries}>
                {props.seriesHidden ? <ICON_EYE_CROSSED /> : <ICON_EYE />}
              </ActionButton>
              <ActionButton name="more" title="More"
                onClick={props.onMore && ((e) => props.onMore!((e.currentTarget as HTMLElement).getBoundingClientRect()))}>
                <ICON_MORE />
              </ActionButton>
            </div>
            <Show when={props.marketStatus && (props.marketStatus !== "open" || (props.showOpenStatus ?? true)) ? STATUS_ITEMS[props.marketStatus!] : null}>
              {(st) => (
                <div class="ot-legend-statuses">
                  <span class="ot-legend-status-pill" data-role="statuses-pill" title={st().title} data-qa-id="legend-source-item-status">
                    <span class="ot-legend-status-item" style={{ color: st().color, "--status-overlay": st().overlay }} aria-hidden="true">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path fill="currentColor" d={st().path} /></svg>
                    </span>
                  </span>
                </div>
              )}
            </Show>
          </div>

          <Show when={!props.seriesHidden && props.values}>
            {(v) => (
              <div class="ot-legend-values">
                <Show when={props.showChartValues ?? true}>
                  <Show
                    when={!v().single}
                    fallback={
                      <span class={`ot-legend-value-value ot-legend-${valueDir()}`}>{fmtPrice(v().close)}</span>
                    }
                  >
                    <ValueItem letter="O" value={fmtPrice(v().open)} dir={v().barDir} />
                    <ValueItem letter="H" value={fmtPrice(v().high)} dir={v().barDir} />
                    <ValueItem letter="L" value={fmtPrice(v().low)} dir={v().barDir} />
                    <ValueItem letter="C" value={fmtPrice(v().close)} dir={v().barDir} />
                  </Show>
                </Show>
                <Show when={(props.showBarChange ?? true) && !props.hideChangeValues}>
                  <span class={`ot-legend-change ot-legend-${valueDir()}`}>{changeText()}</span>
                </Show>
                <Show when={(props.showVolume ?? false) && v().volume != null}>
                  <span class="ot-legend-value-item">
                    <span class="ot-legend-value-title">Vol</span>
                    <span class={`ot-legend-value-value ot-legend-${v().barDir}`}>{fmtVolume(v().volume as number)}</span>
                  </span>
                </Show>
                <Show when={(props.showLastDayChange ?? false) && !props.hideChangeValues}>
                  <span class={`ot-legend-change ot-legend-${v().lastDayChangeDir}`}>
                    {`${fmtSigned(v().lastDayChangeAbs, priceDecimals(v().close))} (${fmtSigned(v().lastDayChangePct, 2)}%)`}
                  </span>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
