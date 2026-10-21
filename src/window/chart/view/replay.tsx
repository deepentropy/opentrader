/*
 * Bar Replay on a chart view: the pane's replay handle (cut the loaded bars at
 * the replay time, reveal them update by update, back to live), the bar
 * selection layer (blue line, scissors, dimmed future, "Re:" time label), the
 * "Replay" watermark and the legend status.
 *
 * The replay cursor and the toolbar state live in data/replay.ts; this part
 * only serves its pane.
 */
import { Show, createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor, type JSX } from "solid-js";
import { CrosshairMode, MismatchDirection, type Time } from "lightweight-charts";
import {
  bumpReplayEpoch,
  isPaneInReplay,
  registerReplayPane,
  replayEnabled,
  replayMode,
  replayPaneReloaded,
  replayPlaying,
  replayPoint,
  replaySelectHoverTime,
  replaySelecting,
  selectBar,
  setReplaySelectHoverTime,
  leavePane,
  setReplayActivePane,
  type ReplayUnavailable,
} from "../../../data/replay";
import { DAILY_ARCHIVE_START, getBars, getBarsBefore, isEconomicSymbol, isIntradayResolution, isSecondResolution, isSupportedResolution } from "../../../data/datafeed";
import { utcToWall, wallTimeToUtc } from "../day-key";
import { cachedSymbolSessions } from "../../../data/session";
import { providerCapabilities } from "../../../data/providers/capabilities";
import { ReplayFeed } from "../replay-feed";
import { ReplayWatermarkPrimitive } from "../replay-watermark";
import { readFontFamily } from "../chart-tokens";
import type { ChartTypeId, OHLC } from "../chart-types";
import { toOHLC } from "./helpers";
import { replayBroker } from "../../../data/trading/replay-broker";
import type { Bar } from "../../../backtester/types";
import { type ChartCx } from "./context";

/** Chart styles Bar Replay does not run on (the reference app: price-based styles and
 *  the profile styles). */
const UNSUPPORTED: ReadonlySet<ChartTypeId> = new Set<ChartTypeId>(["renko", "pb", "kagi", "pnf", "range", "volFootprint", "tpo", "svp"]);

/** Status of the chart in the legend while replay is on. */
export type ReplayLegendStatus = "select" | "pause" | "play" | null;

/** What createReplay adds to the chart context. */
export interface ReplayApi {
  /** The chart shows replayed bars (live bars are not merged). */
  readonly replayActive: boolean;
  /** The apply of loaded bars ended (symbol-load): a chart in replay is cut
   *  again at the replay time; one leaving it goes to the last bar. */
  replayAfterApply: () => void;
  /** Older bars were put in front of the series during the replay. */
  replayOnPrepend: (older: OHLC[]) => void;
  /** Legend status of this chart. */
  replayStatus: Accessor<ReplayLegendStatus>;
  /** The "Replay" watermark is on (the symbol watermark draws it). */
  replayWatermark: Accessor<boolean>;
  ReplaySelectLayer: () => JSX.Element;
}

/** Trading days of sub-bars loaded per request, by update interval. */
function chunkDays(update: string): number {
  if (/S$/.test(update)) return 1;
  const m = Number(update);
  if (m <= 5) return 5;
  if (m < 60) return 20;
  return 60;
}

/** Trading days of chart bars loaded before an old replay time (the
 *  interval's own first window, as the chart loads it). */
function windowDays(iv: string): number {
  if (/S$/.test(iv)) return 2;
  const m = Number(iv);
  if (m <= 1) return 5;
  if (m <= 5) return 10;
  if (m <= 15) return 30;
  if (m <= 30) return 60;
  if (m <= 60) return 90;
  if (m <= 120) return 180;
  return 252;
}

/** Load ahead while fewer sub-bars than this are queued. */
const LOW_WATER = 120;

/** The scissors glyph of the selection line (24 x 24). */
const SCISSORS =
  "m15.68 3.72-3.82 5.52-3.83-5.52-.28-.42-.42.3a2.84 2.84 0 0 0-.68 3.92l3.27 4.73-1.16 1.68a3.34 3.34 0 0 0-4.26 3.22 3.34 3.34 0 0 0 3.32 3.35 3.34 3.34 0 0 0 3.08-4.6l1-1.44 1.13 1.62a3.34 3.34 0 0 0 3.15 4.42c1.84 0 3.32-1.5 3.32-3.35a3.34 3.34 0 0 0-4.42-3.17l-1.23-1.78 3.22-4.65a2.86 2.86 0 0 0-.69-3.96l-.41-.29-.29.42ZM7.82 16.27c.47 0 .86.39.86.88 0 .48-.39.87-.86.87a.87.87 0 0 1-.86-.87c0-.5.4-.88.86-.88Zm8.36 0c.47 0 .86.39.86.88 0 .48-.4.87-.86.87a.87.87 0 0 1-.86-.87c0-.5.39-.88.86-.88Z";

const isoDay = (iso: string | null | undefined) => (iso ? Date.parse(`${iso}T00:00:00Z`) / 1000 : -Infinity);

export function createReplay(cx: ChartCx): ReplayApi {
  const { paneId, props } = cx;
  let feed: ReplayFeed | null = null;
  let active = false;
  /** Bumped by every start / stop: async loads of an older one are dropped. */
  let gen = 0;
  let update = "";
  /** Start of the next sub-bar request. */
  let nextFrom = 0;
  /** Start of the next request of newer chart bars (a window around an old
   *  replay time). */
  let fullFrom = 0;
  let loading: Promise<void> | null = null;
  /** Back from a replay: the reload lands on the last bar. */
  let exitScroll = false;
  const [firstDaily, setFirstDaily] = createSignal<number | null>(null);

  const interval = () => props.interval ?? "1D";

  const unavailable = (): ReplayUnavailable => {
    if (UNSUPPORTED.has(props.chartType ?? "candle")) return "chartType";
    if (!isSupportedResolution(interval())) return "interval";
    if (isEconomicSymbol(cx.fullSymbol())) return "symbol";
    return null;
  };

  /** Earliest time the data plan serves an interval at. */
  const depthOf = (id: string): number => {
    const floor = providerCapabilities()?.entitlements?.historyFloor;
    if (/^\d+[DWM]$/.test(id)) return isoDay(DAILY_ARCHIVE_START);
    if (/S$/.test(id)) return isoDay(floor?.second);
    return isoDay(floor?.minute);
  };

  // The symbol's first daily bar: where intraday data can start at the most.
  createEffect(() => {
    const sym = props.symbol;
    setFirstDaily(null);
    if (!replayEnabled() || !sym || isEconomicSymbol(cx.fullSymbol())) return;
    let alive = true;
    getBars(sym, "1D", "RTH")
      .then((r) => {
        if (!alive) return;
        const t0 = r.daily?.[0]?.time ?? r.bars[0]?.time;
        setFirstDaily(t0 != null ? (t0 as number) : null);
        bumpReplayEpoch();
      })
      .catch(() => {});
    onCleanup(() => { alive = false; });
  });

  const firstAvailable = (): number | null => {
    const iv = interval();
    if (/^\d+[DWM]$/.test(iv)) {
      const d = cx.rawDaily[0]?.time as number | undefined;
      return d ?? firstDaily();
    }
    const f = firstDaily();
    return f === null ? null : Math.max(f, depthOf(iv));
  };

  /** Draw `cx.raw` again after a cut. */
  const repaint = () => {
    if (!cx.series) return;
    cx.paintLive(null, true);
  };

  /** Bars per update are shorter than the chart's. */
  const isSub = (upd: string) => {
    const sec = (id: string) => {
      const m = /^(\d+)([SDWM])$/.exec(id);
      if (m) return Number(m[1]) * ({ S: 1, D: 86400, W: 7 * 86400, M: 30 * 86400 } as Record<string, number>)[m[2]];
      return Number(id) * 60;
    };
    return sec(upd) < sec(interval());
  };

  /** Load what the feed needs next: newer chart bars of a window around an
   *  old replay time, or the next window of sub-bars. */
  const loadMore = (): Promise<void> => {
    if (loading) return loading;
    const f = feed;
    const g = gen;
    const need = f?.needs() ?? null;
    if (!f || need === null) return Promise.resolve();
    const sym = props.symbol ?? "";
    const sess = props.session ?? "RTH";
    const now = Date.now() / 1000;
    if (need === "full") {
      const days = chunkDays(interval());
      const from = fullFrom;
      const before = from + days * 86400;
      loading = getBarsBefore(sym, interval(), before, sess, days)
        .then((rows) => {
          if (g !== gen || f !== feed) return;
          f.appendFull(toOHLC(rows).filter((b) => (b.time as number) >= from));
          fullFrom = before;
          if (before > now) f.fullOpen = false;
        })
        .catch(() => {
          // A failed request: the next step tries again.
        })
        .finally(() => {
          loading = null;
        });
      return loading;
    }
    const days = chunkDays(update);
    const from = nextFrom;
    const before = from + days * 86400;
    loading = getBarsBefore(sym, update, before, sess, days)
      .then((rows) => {
        if (g !== gen || f !== feed) return;
        f.push(toOHLC(rows).filter((b) => (b.time as number) >= from));
        nextFrom = before;
        if (before > now) f.subDone = true;
      })
      .catch(() => {
        // A failed request: the next step tries again.
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  /** Cut the chart at `point`. */
  const start = async (point: number, upd: string): Promise<boolean> => {
    if (!cx.chart || !cx.series || unavailable() !== null) return false;
    const g = ++gen;
    // Already in replay: start again from the real bars.
    let open = false;
    if (feed) {
      cx.raw = feed.full;
      open = feed.fullOpen;
    }
    feed = null;
    loading = null;
    active = true;
    update = upd;
    const iv = interval();
    const daily = cx.rawDaily.length > 0;
    // An intraday time outside the loaded bars (before them, or after a
    // window that does not reach today): a window of bars around it (older
    // ones load on scroll-back, newer ones as the replay moves on).
    const lastLoaded = cx.raw.length > 0 ? (cx.raw[cx.raw.length - 1].time as number) : -Infinity;
    if (!daily && (cx.raw.length === 0 || (cx.raw[0].time as number) > point || (open && point > lastLoaded))) {
      const back = windowDays(iv);
      const ahead = chunkDays(iv);
      const before = point + ahead * 86400;
      const rows = await getBarsBefore(props.symbol ?? "", iv, before, props.session ?? "RTH", back + ahead).catch(() => null);
      if (g !== gen) return false;
      if (!rows) {
        active = false;
        return false;
      }
      cx.raw = toOHLC(rows);
      fullFrom = before;
      open = before < Date.now() / 1000;
      cx.historyExhausted = false;
    }
    // No bar at all: nothing to replay. (At the first available time no
    // bar is shown yet; the first update brings it.)
    if (cx.raw.length === 0) {
      active = false;
      return false;
    }
    const sub = isSub(upd);
    const f = new ReplayFeed(cx.raw.slice(), point, sub);
    f.fullOpen = open;
    feed = f;
    cx.raw = f.shown;
    repaint();
    cx.chart.timeScale().scrollToPosition(Math.max(cx.currentTokens().rightOffset, 0), false);
    if (sub) {
      const from = f.subStart;
      if (/^\d+D$/.test(upd)) {
        // Daily sub-bars of a weekly / monthly chart: all loaded already.
        f.seed(toOHLC(cx.rawDaily), point);
        f.subDone = true;
      } else if (from !== null) {
        nextFrom = from;
        const days = chunkDays(upd);
        const before = from + days * 86400;
        const rows = await getBarsBefore(props.symbol ?? "", upd, before, props.session ?? "RTH", days).catch(() => null);
        if (g !== gen || f !== feed) return false;
        f.seed(toOHLC(rows ?? []).filter((b) => (b.time as number) >= from), point);
        nextFrom = before;
        if (before > Date.now() / 1000) f.subDone = true;
      } else {
        f.subDone = true;
      }
      cx.raw = f.shown;
      repaint();
    }
    return true;
  };

  const next = async (): Promise<number | null> => {
    for (let i = 0; i < 400; i++) {
      const f = feed;
      if (!f) return null;
      const n = f.nextTime();
      if (n !== undefined) {
        // Load ahead while the queue runs low.
        if (f.subMode && !f.subDone && f.queueLength < LOW_WATER) void loadMore();
        return n;
      }
      await loadMore();
    }
    return null;
  };

  /** A bar for replay trading. */
  const asBar = (b: OHLC): Bar => ({ time: b.time as number, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 });
  const lastShown = (): Bar | null => {
    const s = feed?.shown;
    return s && s.length ? asBar(s[s.length - 1]) : null;
  };

  const advanceTo = (time: number) => {
    const f = feed;
    if (!f || !cx.series) return;
    const changes = f.advanceTo(time);
    cx.raw = f.shown;
    if (changes.length === 0) return;
    replayBroker.paneUpdates(paneId, changes.map((c) => asBar(c.path)), lastShown());
    cx.controller?.setReplayCutoff(time);
    if (changes.length === 1) cx.paintLive(changes[0].bar, changes[0].appended);
    else cx.paintLive(null, true);
  };

  /** Back to live data: the bars are read again and the view goes to the
   *  last bar. */
  const stop = () => {
    gen++;
    const was = active;
    if (feed) cx.raw = feed.full;
    feed = null;
    active = false;
    loading = null;
    if (was) {
      exitScroll = true;
      cx.setReloadTick((n) => n + 1);
    }
  };

  const unregister = registerReplayPane({
    paneId,
    shown: () => props.shown !== false,
    interval,
    unavailable,
    firstAvailable,
    depthOf,
    start: async (pt, upd) => {
      const ok = await start(pt, upd);
      if (ok) {
        replayBroker.paneStarted(paneId, props.symbol ?? "", lastShown());
        // Studies reading other symbols see them up to the replay time too.
        cx.controller?.setReplayCutoff(pt);
      }
      return ok;
    },
    next,
    advanceTo,
    stop: () => {
      stop();
      replayBroker.paneStopped(paneId);
      cx.controller?.setReplayCutoff(null);
    },
    dateOnly: () => !isIntradayResolution(interval()) && !isSecondResolution(interval()),
    wallToTime: (d, minutes) =>
      !isIntradayResolution(interval()) && !isSecondResolution(interval())
        ? Date.UTC(d.y, d.m, d.d) / 1000
        : wallTimeToUtc(props.timeZone ?? "UTC", d.y, d.m, d.d, Math.floor(minutes / 60), minutes % 60),
    inSession: (sec) => cachedSymbolSessions(props.symbol ?? "")?.spec(props.session ?? "RTH").contains(sec) ?? true,
    timeToWall: (sec) =>
      !isIntradayResolution(interval()) && !isSecondResolution(interval())
        ? { ...utcToWall("UTC", sec + 43200), minutes: 0 }
        : utcToWall(props.timeZone ?? "UTC", sec),
  });
  onCleanup(unregister);
  onCleanup(() => replayBroker.paneStopped(paneId));

  // The focused chart of the shown tab.
  createEffect(() => {
    if (props.active && props.shown !== false) setReplayActivePane(paneId);
  });
  // A style replay does not run on: the chart leaves the replay.
  createEffect(() => {
    if (unavailable() !== null && untrack(() => isPaneInReplay(paneId))) leavePane(paneId);
  });
  // The update interval list follows the chart's interval and data.
  createEffect(() => {
    interval();
    props.symbol;
    bumpReplayEpoch();
  });

  const replayAfterApply = () => {
    if (isPaneInReplay(paneId)) {
      // New real bars (interval / symbol / session / reload): cut them again
      // at the replay time.
      feed = null;
      replayPaneReloaded(paneId);
      return;
    }
    if (exitScroll && cx.chart) {
      exitScroll = false;
      cx.chart.timeScale().scrollToPosition(Math.max(cx.currentTokens().rightOffset, 0), false);
    }
  };

  const replayOnPrepend = (older: OHLC[]) => {
    if (!feed) return;
    feed.prepend(older);
    cx.raw = feed.shown;
  };

  const replayStatus = createMemo<ReplayLegendStatus>(() => {
    if (!replayEnabled() || unavailable() !== null) return null;
    if (isPaneInReplay(paneId)) return replayPlaying() ? "play" : "pause";
    if (replaySelecting()) return "select";
    return null;
  });
  const replayWatermark = createMemo(() => isPaneInReplay(paneId));

  // ── Watermark ─────────────────────────────────────────────────────────────
  const wm = new ReplayWatermarkPrimitive();
  let wmPane: number | null = null;
  createEffect(() => {
    const on = replayWatermark();
    cx.chartReady();
    const pane = cx.mainPane();
    cx.mainPaneEpoch();
    const color = cx.appearance() && cx.currentTokens().watermarkColor;
    const lines = cx.watermarkLines();
    if (!cx.chart) return;
    if (wmPane !== null) {
      try { cx.chart.panes()[wmPane]?.detachPrimitive(wm); } catch { /* pane gone */ }
      wmPane = null;
    }
    if (!on) return;
    wm.set([...lines, { text: "Replay", icon: true }], color, readFontFamily());
    cx.chart.panes()[pane]?.attachPrimitive(wm);
    wmPane = pane;
  });
  onCleanup(() => {
    if (wmPane !== null) {
      try { cx.chart?.panes()[wmPane]?.detachPrimitive(wm); } catch { /* chart gone */ }
    }
  });

  // ── Bar selection ─────────────────────────────────────────────────────────
  const selectingHere = () => replaySelecting() && unavailable() === null && props.shown !== false;
  /** Hidden crosshair while selecting (the line replaces it). */
  let savedCrosshair: CrosshairMode | null = null;
  createEffect(() => {
    const on = selectingHere();
    cx.chartReady();
    if (!cx.chart) return;
    if (on && savedCrosshair === null) {
      savedCrosshair = cx.chart.options().crosshair.mode;
      cx.chart.applyOptions({ crosshair: { mode: CrosshairMode.Hidden } });
    } else if (!on && savedCrosshair !== null) {
      cx.chart.applyOptions({ crosshair: { mode: savedCrosshair } });
      savedCrosshair = null;
    }
  });

  /** Pointer over this chart while selecting. */
  const [hover, setHover] = createSignal<{ time: number; y: number } | null>(null);
  /** Bumped when the view scrolls / zooms while selecting (line position). */
  const [viewEpoch, setViewEpoch] = createSignal(0);
  createEffect(() => {
    if (!selectingHere()) return;
    cx.chartReady();
    const ts = cx.chart?.timeScale();
    if (!ts) return;
    const bump = () => setViewEpoch((n) => n + 1);
    ts.subscribeVisibleLogicalRangeChange(bump);
    onCleanup(() => ts.unsubscribeVisibleLogicalRangeChange(bump));
  });

  /** The bar under `x` (pane coordinates), clamped to the loaded bars. */
  const barAt = (x: number): number | null => {
    if (!cx.chart || !cx.series || cx.raw.length === 0) return null;
    const ts = cx.chart.timeScale();
    // Over the price axes: the nearest plot edge.
    const px = Math.max(0, Math.min(ts.width() - 1, x - cx.leftAxisWidth()));
    const logical = ts.coordinateToLogical(px);
    if (logical === null) return null;
    const first = ts.timeToIndex(cx.raw[0].time, true);
    const last = ts.timeToIndex(cx.raw[cx.raw.length - 1].time, true);
    if (first === null || last === null) return null;
    const idx = Math.max(first, Math.min(last, Math.round(logical)));
    const d = cx.series.dataByIndex(idx, MismatchDirection.NearestLeft);
    return d ? (d.time as number) : null;
  };

  const ReplaySelectLayer = () => {
    // Line position: the bar under the pointer here, else (All charts) the
    // one under the pointer on another chart.
    const lineTime = () => {
      const h = hover();
      if (h) return h.time;
      return replayMode() === "AllCharts" ? replaySelectHoverTime() : null;
    };
    const geom = createMemo(() => {
      const time = lineTime();
      viewEpoch();
      if (time === null || !cx.chart) return null;
      const ts = cx.chart.timeScale();
      const x = ts.timeToCoordinate(time as Time);
      if (x === null) return null;
      const left = cx.leftAxisWidth();
      const plotRight = left + ts.width();
      const axisH = ts.height();
      const h = cx.host.clientHeight - axisH;
      const fmt = cx.chart.options().localization.timeFormatter;
      const label = `Re: ${fmt ? fmt(time as Time) : String(time)}`;
      return { x: left + Math.round(x), plotRight, axisTop: h, axisH, label };
    });
    const dim = () => {
      const bg = cx.studySelectionBg()(0.5);
      return withAlpha(bg, 0.7);
    };
    return (
      <Show when={selectingHere()}>
        <div
          class="ot-replay-select"
          data-name="replay-select-layer"
          onPointerMove={(e) => {
            const r = cx.paneRoot.getBoundingClientRect();
            const time = barAt(e.clientX - r.left);
            if (time === null) { setHover(null); return; }
            setHover({ time, y: e.clientY - r.top });
            setReplaySelectHoverTime(time);
          }}
          onPointerLeave={() => { setHover(null); setReplaySelectHoverTime(null); }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const r = cx.paneRoot.getBoundingClientRect();
            const time = barAt(e.clientX - r.left);
            if (time !== null) selectBar(paneId, time);
          }}
          onWheel={(e) => forwardWheel(e, cx.host)}
        >
          <Show when={geom()}>
            {(g) => (
              <>
                <div class="ot-replay-select__dim" style={{ left: `${g().x}px`, width: `${Math.max(0, g().plotRight - g().x)}px`, height: `${g().axisTop}px`, background: dim() }} />
                <div class="ot-replay-select__line" style={{ left: `${g().x - 1}px`, height: `${g().axisTop}px` }} />
                <Show when={hover()}>
                  {(h) => (
                    <svg
                      class="ot-replay-select__scissors"
                      viewBox="0 0 24 24"
                      width="24"
                      height="24"
                      style={{ left: `${g().x - 12}px`, top: `${Math.max(0, Math.min(g().axisTop - 24, h().y - 12))}px` }}
                    >
                      <path d={SCISSORS} fill="#0f0f0f" stroke="#fff" stroke-width="1" />
                    </svg>
                  )}
                </Show>
                <div class="ot-replay-select__label" style={{ left: `${g().x}px`, top: `${g().axisTop}px`, height: `${g().axisH}px` }}>
                  <span>{g().label}</span>
                </div>
              </>
            )}
          </Show>
        </div>
      </Show>
    );
  };

  createEffect(() => {
    if (!selectingHere()) setHover(null);
  });

  // The point of the replay is gone: nothing in replay here any more.
  createEffect(() => {
    if (replayPoint() === null && active) stop();
  });

  return {
    get replayActive() {
      return active;
    },
    replayAfterApply,
    replayOnPrepend,
    replayStatus,
    replayWatermark,
    ReplaySelectLayer,
  };
}

/** A colour with its alpha multiplied by `a` ("#rrggbb" / "rgb()" / "rgba()"). */
function withAlpha(color: string, a: number): string {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    const base = hex[2] ? parseInt(hex[2], 16) / 255 : 1;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${base * a})`;
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (m) {
    const [r, g, b, al] = m[1].split(",").map((s) => Number(s.trim()));
    return `rgba(${r}, ${g}, ${b}, ${(Number.isFinite(al) ? al : 1) * a})`;
  }
  return color;
}

/** Pass a wheel over the selection layer on to the chart canvas under it
 *  (zoom / scroll keep working while a bar is picked). */
function forwardWheel(e: WheelEvent, host: HTMLElement) {
  const target = document
    .elementsFromPoint(e.clientX, e.clientY)
    .find((el) => host.contains(el) && el instanceof HTMLElement && el.tagName === "TD") ??
    document.elementsFromPoint(e.clientX, e.clientY).find((el) => host.contains(el) && el.tagName === "CANVAS");
  if (!target) return;
  e.preventDefault();
  target.dispatchEvent(new WheelEvent("wheel", e));
}
