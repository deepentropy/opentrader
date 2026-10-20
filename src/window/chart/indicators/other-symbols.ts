/*
 * Bars of other symbols for the studies of one chart (PineScript
 * `request.security` of another ticker). A study reads them through the
 * `bars(symbol, timeframe)` / `symbolInfo(symbol)` accessors of its chart
 * context; bars that are not loaded yet answer `undefined`, the study throws
 * a MissingSymbolDataError listing what it needs, and the store loads it and
 * tells the chart which studies to calculate again.
 *
 * - The other symbol's bars come in the regular session (a ticker without a
 *   session is the regular session in a script), on the requested timeframe
 *   ("" = the chart's), daily and longer bars at the session open of their
 *   trading day as the chart bars the studies see.
 * - They cover the chart's loaded history: when the chart pages back, the
 *   older bars of an intraday timeframe follow (daily bars are loaded whole).
 * - Live updates of each symbol in use are merged; a symbol no study reads
 *   any more is dropped with its live subscription.
 * - A symbol that cannot be loaded (unknown, not served) answers no bars,
 *   once: it is not fetched again until the chart reloads.
 * - Lower-timeframe bars of the chart's own symbol (profile studies,
 *   `lowerBars`): the chart's session, raw bar times, loaded back to the
 *   time the study asks for (not limited to the chart's span).
 */
import type { Bar } from "oakscriptjs";
import type { SessionId } from "../../../data/session";
import type { SymbolInfo } from "oakscriptjs/script";
import {
  getBars,
  getBarsBefore,
  getEvents,
  type ChartEvent,
  isIntradayResolution,
  isSecondResolution,
  isSupportedResolution,
  setLiveSymbol,
  subscribeBars,
  type LiveBar,
} from "../../../data/datafeed";
import { cachedSymbolSessions } from "../../../data/session";
import { getFundamentals, type Fundamentals } from "../../../data/fundamentals";
import { scriptBars } from "../../../backtester/oakscript";
import { DEFAULT_SYMBOL } from "../../../backtester/types";
import { scriptChartContext, symbolDetails } from "./script-chart";

/** Session of another symbol's bars. */
const SESSION = "RTH";

type Entry = {
  symbol: string;
  resolution: string;
  /** Session of the bars. */
  session: SessionId;
  /** Lower-timeframe entry: the bars as loaded (no restamp), loaded back to `wantFrom`. */
  lower: boolean;
  wantFrom: number;
  /** Bars as loaded (chart bar times); null while the first load runs. */
  bars: Bar[] | null;
  /** The bars the studies read (daily and longer at the session open); rebuilt on change. */
  seen: Bar[] | null;
  failed: boolean;
  /** No older bars before the first one. */
  exhausted: boolean;
  extending: boolean;
  /** Per-day volume baseline of a forming week / month bar (live). */
  volBase: { barTime: number; dayTime: number; base: number } | null;
  stopLive: (() => void) | null;
};

/** Timeframe of a script (`"D"`, `"60"`, `""`) as a chart interval id (`"1D"`, `"60"`). */
export function resolutionOf(timeframe: string, chartInterval: string): string {
  const tf = timeframe.trim().toUpperCase();
  if (tf === "") return chartInterval;
  if (/^[DWM]$/.test(tf)) return `1${tf}`;
  if (tf === "S") return "1S";
  return tf;
}

const keyOf = (symbol: string, resolution: string) => `${symbol}|${resolution}`;

export class OtherSymbolBars {
  private entries = new Map<string, Entry>();
  /** Dividends / splits of a symbol (`symbol|events`): null while loading. */
  private eventLists = new Map<string, ChartEvent[] | null>();
  /** Fundamentals of a symbol (`symbol|fundamentals`): undefined while loading, null when it has none. */
  private fundamentalSets = new Map<string, Fundamentals | null | undefined>();
  /** First bar time of the chart's loaded bars (seconds): the span the other symbols cover. */
  private chartFirst = Infinity;
  private chartSeconds = 0;
  private disposed = false;

  /** `changed`: keys (`symbol|resolution`) whose bars arrived or moved (`live`: only the newest bar moved).
   *  `slot`: live subscription slot prefix. */
  constructor(
    private readonly changed: (keys: Set<string>, live: boolean) => void,
    private readonly slot: string,
  ) {}

  /** Accessor key of a request, for the studies' usage sets. */
  key(symbol: string, timeframe: string, chartInterval: string): string {
    return keyOf(symbol.trim().toUpperCase(), resolutionOf(timeframe, chartInterval));
  }

  /** Bars of `symbol` on `timeframe`; undefined while loading (the load starts), [] when it cannot be loaded. */
  bars(symbol: string, timeframe: string, chartInterval: string): Bar[] | undefined {
    const sym = symbol.trim().toUpperCase();
    const resolution = resolutionOf(timeframe, chartInterval);
    const key = keyOf(sym, resolution);
    let e = this.entries.get(key);
    if (!e) {
      e = { symbol: sym, resolution, session: SESSION, lower: false, wantFrom: Infinity, bars: null, seen: null, failed: false, exhausted: false, extending: false, volBase: null, stopLive: null };
      this.entries.set(key, e);
      this.load(key, e);
    }
    if (e.failed) return [];
    if (!e.bars) return undefined;
    if (!e.seen) e.seen = scriptBars(e.bars, scriptChartContext(e.symbol, e.resolution, SESSION));
    return e.seen;
  }

  /** Accessor key of a lower-timeframe request. */
  lowerKey(symbol: string, resolution: string, session: SessionId): string {
    return `${symbol.trim().toUpperCase()}|${resolution}|${session}`;
  }

  /** Bars of `symbol` on `resolution` in `session` (raw bar times), loaded back to `from` (seconds): undefined
   *  while the first load runs, [] when they cannot be loaded; older bars follow while they load. */
  lowerBars(symbol: string, resolution: string, session: SessionId, from: number): Bar[] | undefined {
    const sym = symbol.trim().toUpperCase();
    const key = this.lowerKey(sym, resolution, session);
    let e = this.entries.get(key);
    if (!e) {
      e = { symbol: sym, resolution, session, lower: true, wantFrom: from, bars: null, seen: null, failed: false, exhausted: false, extending: false, volBase: null, stopLive: null };
      this.entries.set(key, e);
      this.load(key, e);
    } else if (from < e.wantFrom) {
      e.wantFrom = from;
      this.extend(key, e);
    }
    if (e.failed) return [];
    return e.bars ?? undefined;
  }

  /** Accessor key of a symbol's dividends / splits. */
  eventsKey(symbol: string): string {
    return `${symbol.trim().toUpperCase()}|events`;
  }

  /** Dividends and splits of `symbol`, time-ascending; undefined while they load (the studies that read them
   *  calculate again when they arrive), [] when there are none or they cannot be loaded. */
  events(symbol: string): ChartEvent[] | undefined {
    const key = this.eventsKey(symbol);
    if (!this.eventLists.has(key)) {
      this.eventLists.set(key, null);
      getEvents(symbol.trim().toUpperCase())
        .catch(() => [] as ChartEvent[])
        .then((list) => {
          if (this.disposed || !this.eventLists.has(key)) return;
          this.eventLists.set(key, list);
          this.changed(new Set([key]), false);
        });
    }
    return this.eventLists.get(key) ?? undefined;
  }

  /** Accessor key of a symbol's fundamentals. */
  fundamentalsKey(symbol: string): string {
    return `${symbol.trim().toUpperCase()}|fundamentals`;
  }

  /** Financial statement items and earnings of `symbol`: undefined while they load (the studies that read them
   *  calculate again when they arrive), null when the symbol has none or they cannot be loaded. */
  fundamentals(symbol: string): Fundamentals | null | undefined {
    const key = this.fundamentalsKey(symbol);
    if (!this.fundamentalSets.has(key)) {
      this.fundamentalSets.set(key, undefined);
      getFundamentals(symbol).then((f) => {
        if (this.disposed || !this.fundamentalSets.has(key)) return;
        this.fundamentalSets.set(key, f);
        this.changed(new Set([key]), false);
      });
    }
    return this.fundamentalSets.get(key);
  }

  /** The bars of a key (`symbol|interval`) could not be loaded (unknown symbol, not served). */
  failed(key: string): boolean {
    return this.entries.get(key)?.failed ?? false;
  }

  /** Time zone, session and price grid of `symbol` (undefined until its session is known). */
  symbolInfo(symbol: string): SymbolInfo | undefined {
    const s = cachedSymbolSessions(symbol.trim().toUpperCase());
    if (!s) return undefined;
    const details = symbolDetails(symbol);
    return {
      symbolType: details?.symbolType,
      currency: details?.currency,
      timezone: s.timeZone,
      session: s.regularSpec,
      regularSession: s.regularSpec,
      mintick: s.mintick,
      minmove: s.minmove,
      pricescale: s.pricescale,
      pointvalue: DEFAULT_SYMBOL.pointValue,
      mincontract: DEFAULT_SYMBOL.qtyStep,
    };
  }

  /** The chart's loaded bars changed: the other symbols cover them back to their first bar. */
  setChartSpan(firstTime: number | undefined, chartSeconds: number): void {
    this.chartFirst = firstTime ?? Infinity;
    this.chartSeconds = chartSeconds;
    for (const [key, e] of this.entries) this.extend(key, e);
  }

  /** Drop the symbols no study read in the last calculations (`used`: keys in use). */
  retain(used: Set<string>): void {
    for (const [key, e] of [...this.entries]) {
      if (used.has(key) || !e.bars) continue;
      e.stopLive?.();
      this.entries.delete(key);
    }
  }

  /** Symbol, interval or session of the chart changed, or the chart reloads: everything is fetched again. */
  clear(): void {
    for (const e of this.entries.values()) e.stopLive?.();
    this.entries.clear();
    this.eventLists.clear();
    this.fundamentalSets.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private alive(key: string, e: Entry): boolean {
    return !this.disposed && this.entries.get(key) === e;
  }

  private load(key: string, e: Entry): void {
    if (!isSupportedResolution(e.resolution)) {
      e.failed = true;
      return;
    }
    getBars(e.symbol, e.resolution, e.session)
      .then((r) => {
        if (!this.alive(key, e)) return;
        e.bars = r.bars
          .filter((c) => c.time != null && c.open != null && c.high != null && c.low != null && c.close != null)
          .map((c) => ({ time: c.time!, open: c.open!, high: c.high!, low: c.low!, close: c.close!, volume: c.volume ?? 0 }));
        e.seen = null;
        this.startLive(key, e);
        this.extend(key, e);
        this.changed(new Set([key]), false);
      })
      .catch((err) => {
        if (!this.alive(key, e)) return;
        console.warn(`[indicators] bars of ${e.symbol} (${e.resolution}) could not be loaded`, err);
        e.failed = true;
        this.changed(new Set([key]), false);
      });
  }

  /** Older bars of an intraday timeframe back to the chart's first bar (a lower-timeframe entry: back to the time
   *  its study asks for). A timeframe below the chart's is not extended (its whole history under a long chart would
   *  be far too many bars). */
  private extend(key: string, e: Entry): void {
    const target = e.lower ? e.wantFrom : this.chartFirst;
    if (!e.bars || e.failed || e.exhausted || e.extending || !Number.isFinite(target)) return;
    if (!isIntradayResolution(e.resolution) && !isSecondResolution(e.resolution)) return;
    const first = e.bars.length ? (e.bars[0].time as number) : Infinity;
    if (first <= target || !Number.isFinite(first)) return;
    const seconds = Number(e.resolution) * 60 || 0;
    if (!e.lower && seconds && this.chartSeconds && seconds < this.chartSeconds) return;
    e.extending = true;
    const spanDays = Math.ceil((first - target) / 86400) + 1;
    getBarsBefore(e.symbol, e.resolution, first, e.session, spanDays)
      .then((rows) => {
        if (!this.alive(key, e) || !e.bars) return;
        const older = rows
          .filter((c) => c.time != null && c.close != null && (c.time as number) < first)
          .map((c) => ({ time: c.time!, open: c.open!, high: c.high!, low: c.low!, close: c.close!, volume: c.volume ?? 0 }));
        if (older.length === 0) e.exhausted = true;
        else {
          e.bars = [...older, ...e.bars];
          e.seen = null;
          this.changed(new Set([key]), false);
        }
      })
      .catch(() => {
        e.exhausted = true;
      })
      .finally(() => {
        e.extending = false;
        if (this.alive(key, e)) this.extend(key, e);
      });
  }

  private startLive(key: string, e: Entry): void {
    const slot = `${this.slot}:sym:${key}`;
    setLiveSymbol(e.symbol, slot).catch(() => {});
    let off: (() => void) | null = null;
    let dead = false;
    subscribeBars(() => e.symbol, () => e.resolution, (bar) => {
      if (!this.alive(key, e) || !e.bars) return;
      if (this.mergeLive(e, bar)) {
        e.seen = null;
        this.changed(new Set([key]), true);
      }
    }, () => e.session).then((u) => {
      if (dead) u();
      else off = u;
    });
    e.stopLive = () => {
      dead = true;
      off?.();
      setLiveSymbol(null, slot).catch(() => {});
    };
  }

  /** A live bar into the loaded bars, with the chart's volume rules per source. False = nothing moved. */
  private mergeLive(e: Entry, bar: LiveBar): boolean {
    const bars = e.bars!;
    const last = bars[bars.length - 1];
    const lastTime = last ? (last.time as number) : -1;
    if (bar.time < lastTime) return false;
    if (!last || bar.time > lastTime) {
      bars.push({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
      return true;
    }
    const iv = e.resolution;
    let volume: number;
    if (bar.volumeIsIncrement) volume = (last.volume ?? 0) + bar.volume;
    else if (iv === "1" || iv === "1D" || isSecondResolution(iv)) volume = bar.volume;
    else if (!isIntradayResolution(iv)) {
      const day = bar.dayTime ?? 0;
      if (!e.volBase || e.volBase.barTime !== bar.time || e.volBase.dayTime !== day) {
        e.volBase = { barTime: bar.time, dayTime: day, base: last.volume ?? 0 };
      }
      volume = e.volBase.base + bar.volume;
    } else volume = Math.max(last.volume ?? 0, bar.volume);
    const next = { time: last.time, open: last.open, high: Math.max(last.high, bar.high), low: Math.min(last.low, bar.low), close: bar.close, volume };
    if (next.high === last.high && next.low === last.low && next.close === last.close && next.volume === last.volume) return false;
    bars[bars.length - 1] = next;
    return true;
  }
}
