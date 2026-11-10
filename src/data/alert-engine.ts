/*
 * Alert engine — the window's side of the alerts: it starts the delivery of
 * every fire (./alert-delivery) and evaluates the rules the backend cannot
 * compute.
 *
 * The backend evaluates the rules that compare the price with a value or a
 * drawing's levels (data/alert-backend.ts hands them over and brings their
 * fires back here; the web build runs the same engine in the window). The
 * rules on an indicator, an anchored VWAP or a moving amount are evaluated in
 * this module, with the same evaluation (./alert-eval): it listens to the same
 * live tick stream the watchlist/chart use (data/datafeed-live.ts) and reads
 * each of those rules whose symbol just ticked. A condition on the price reads
 * the quote as the backend does (its price and the range since the previous
 * quote); a condition on a study reads the study's value.
 *
 * It runs in one window (see `whenAlertLeader`).
 *
 * Limitations of the evaluation done here:
 *  • Indicator-operand conditions prefer the charted study values (they honour
 *    the chart's configured inputs); uncharted symbols fall back to a 60s
 *    getBars poll computed with the study's DEFAULT inputs.
 *  • Crossing is sampled between polls (~15s cadence), not tick-exact.
 *  • once_per_bar(_close) buckets are the bars of the rule's interval and
 *    session (intraday: anchored at each regular or extended session
 *    interval; daily+: the trading day / week / month in the exchange zone),
 *    timed by the latest trade when the tick carries it. A tick outside the
 *    rule's session is not evaluated (its bars do not move then). Ticks wait
 *    until the symbol's session is known.
 *  • A rule on regular hours reads the regular-session last, a rule on
 *    extended hours the latest trade (pre- and post-market included).
 */
import { createRoot, createEffect, createSignal, onCleanup } from "solid-js";
import { getBars, isSupportedResolution, onTradeTick, type TradeTick } from "./datafeed";
import { cachedSymbolSessions } from "./session";
import { setSubscription } from "./subscriptions";
import { alertStore, type AlertRule } from "./alert-store";
import { evaluatedByBackend, startAlertBackend } from "./alert-backend";
import {
  conditionRules,
  drawingBand,
  drawingPositionLevels,
  drawingTime,
  isBandOperator,
  isMovingOperator,
  isStrategyOperator,
  operandValue,
  ruleComparedSymbols,
  ruleQuoteSymbol,
  type EvalContext,
} from "./alert-condition";
import { chartLastBarTime, chartResolution, chartSession } from "./chart-state-registry";
import { getIndicatorEntry } from "../window/chart/indicators/registry";
import { outputByKey, outputValue } from "./alert-outputs";
import { pointSample, QuoteRanges, quoteSample, stepRule, type EvalCondition, type EvalRule, type MinuteBar, type RuleReader } from "./alert-eval";
import { ruleRuntimes, ruleSignature } from "./alert-rule-state";
import { barBucket, DEFAULT_SESSION, engineRules, inRuleSession, resolutionMs, ruleSession } from "./alert-bars";
import { clearStudyCaches, fetchedBars, indicatorOperandValue, INDICATOR_POLL_MS, liveBarState, pollDrawingBars, runStudy, studyConditionNow } from "./alert-studies";
import { deliverFire } from "./alert-delivery";
import { evaluateAlertCalls, evaluateStrategy } from "./alert-strategies";
import { replayMissedOnce } from "./alert-replay-missed";

export { onAlertFire } from "./alert-delivery";

/** The latest tick of each symbol (a rule on a compared symbol reads both symbols). */
const lastTicks = new Map<string, TradeTick>();

/** The range each symbol's quotes went through since the previous one, as the backend's engine reads it. */
const ranges = new QuoteRanges();

/** A tick's price on a session: regular hours read the regular-session last, extended hours the latest trade. */
function tickPrice(t: TradeTick, session: string | undefined): number {
  return (session ?? DEFAULT_SESSION) === "ETH" && t.tradePrice != null ? t.tradePrice : t.price;
}

/** The latest minute bar a tick carries (its open is not read). */
function minuteBarOf(t: TradeTick): MinuteBar | null {
  const p = t.tradePrice;
  return t.tradeTime != null && p != null ? { time: t.tradeTime, open: p, high: t.tradeHigh ?? p, low: t.tradeLow ?? p, close: p } : null;
}

/** Evaluation contexts of `symbol` from its quote `t` (regular and extended hours). */
function tickContexts(symbol: string, t: TradeTick, now: number): { regular: EvalContext; extended: EvalContext } {
  const regular: EvalContext = {
    price: t.price,
    changePercent: t.changePercent ?? null,
    timeSec: Math.floor(now / 1000),
    indicatorValue: (op, resolution, session) => indicatorOperandValue(symbol, op, resolution, session ?? DEFAULT_SESSION, tickPrice(t, session)),
    conditionTrue: (op, resolution, session) => studyConditionNow(symbol, op, resolution, session ?? DEFAULT_SESSION, tickPrice(t, session)),
    barsFallback: (resolution, session) => fetchedBars(symbol, resolution, session ?? DEFAULT_SESSION),
  };
  return { regular, extended: { ...regular, price: tickPrice(t, "ETH") } };
}

/** A condition as the evaluation reads it: its shape tells what its values hold. */
function evalConditionOf(c: AlertRule): EvalCondition {
  const r = c.right;
  const rectangle = r.kind === "drawing" && r.band === "rectangle";
  const shape =
    c.op === "alert_condition" ? "flag"
    : isMovingOperator(c.op) ? "moving"
    : r.kind === "drawing" && r.band === "time" ? "time"
    : c.op === "hits_level" ? "position"
    : isBandOperator(c.op) || rectangle ? "band"
    : "level";
  return { op: c.op, shape, absentIsOutside: rectangle, ...(shape === "moving" ? { amount: r.kind === "value" ? r.value : 0 } : {}) };
}

/** The rule as the evaluation reads it (an expired rule is stopped before it is read). */
function evalRuleOf(rule: AlertRule): EvalRule {
  const [first, ...more] = conditionRules(rule).map(evalConditionOf);
  return { ...first, id: rule.id, frequency: rule.frequency, expiresAt: null, and: more };
}

/** The values condition `c` compares with at `timeSec` (see EvalCondition); null when it has none now. `ref`: a moving
 *  condition's value N bars back. */
function conditionValues(c: AlertRule, ctx: EvalContext, timeSec: number, ref: number | null | undefined): number[] | null {
  const { symbol, right } = c;
  if (c.op === "alert_condition") {
    const v = c.left.kind === "indicator" ? ctx.conditionTrue?.(c.left, c.resolution, c.session) : null;
    return v == null ? null : [v ? 1 : 0];
  }
  if (isMovingOperator(c.op)) return ref == null ? null : [ref];
  if (right.kind === "drawing" && right.band === "time") {
    const t = drawingTime(symbol, right.drawingId);
    return t == null ? null : [t];
  }
  if (c.op === "hits_level") {
    const lv = right.kind === "drawing" ? drawingPositionLevels(symbol, right.drawingId, timeSec) : null;
    return lv ? [lv.entry, lv.stop, lv.target] : null;
  }
  if (isBandOperator(c.op) || (right.kind === "drawing" && right.band === "rectangle")) {
    if (right.kind === "drawing") {
      // A rectangle's greater / less read its top and bottom; a channel's conditions the levels chosen.
      const band = isBandOperator(c.op) ? drawingBand(symbol, right.drawingId, timeSec, right.level, right.level2) : drawingBand(symbol, right.drawingId, timeSec);
      return band ? [band.lower, band.upper] : null;
    }
    const a = operandValue(symbol, right, ctx, c.resolution, c.session);
    const b = operandValue(symbol, c.right2 ?? right, ctx, c.resolution, c.session);
    return a == null || b == null ? null : [a, b];
  }
  const v = operandValue(symbol, right, ctx, c.resolution, c.session);
  return v == null ? null : [v];
}

/** Evaluate every enabled rule for the symbol that just ticked. */
function onTick(t: TradeTick): void {
  const symbol = t.symbol.toUpperCase();
  lastTicks.set(symbol, t);
  const now = Date.now();
  const bar = minuteBarOf(t);
  // Every quote moves the range, read or not.
  const range = ranges.take(symbol, bar, now / 1000);
  // The backend evaluates the other rules of the symbol. A rule on a compared
  // symbol is read on the quotes of both symbols (it may compare the compared
  // symbol's price with the chart symbol's price or studies).
  const rules = engineRules().filter((r) => (r.symbol === symbol || ruleComparedSymbols(r).includes(symbol)) && !evaluatedByBackend(r));
  if (rules.length === 0) return;

  // The time of the data: the latest trade's minute when the tick carries it
  // (the quotes are delayed), else the charted bar's open time when the
  // chart's bars are no longer than the rule's (a daily chart's bar does not
  // tell which hour a 60-minute rule is in) and of the rule's session, else
  // the wall clock.
  const tradeMs = t.tradeTime != null ? Math.min(t.tradeTime * 1000, now) : null;
  const chartRef = chartLastBarTime(symbol);
  const chartRes = chartResolution(symbol);
  const chartSes = chartSession(symbol);
  const barRefFor = (rule: AlertRule) =>
    tradeMs ??
    (chartRef != null && chartRes != null && resolutionMs(chartRes) <= resolutionMs(rule.resolution) && (chartSes == null || chartSes === ruleSession(rule))
      ? chartRef
      : now);
  // The latest trade is a pre / post-market one.
  const sessions = cachedSymbolSessions(symbol);
  const extendedQuote = t.tradeTime != null && sessions != null && !sessions.regular.contains(t.tradeTime);
  /** The contexts of a rule's own symbol (its quote: this tick's, else the latest one); null before any. */
  const ctxCache = new Map<string, { regular: EvalContext; extended: EvalContext } | null>();
  const contextsOf = (own: string) => {
    if (ctxCache.has(own)) return ctxCache.get(own)!;
    const q = own === symbol ? t : lastTicks.get(own);
    const out = q ? tickContexts(own, q, now) : null;
    ctxCache.set(own, out);
    return out;
  };

  for (const rule of rules) {
    // Auto-expire.
    if (rule.expiresAt != null && now >= rule.expiresAt) {
      alertStore.setEnabled(rule.id, false, "expired");
      continue;
    }
    // A script's alert() calls: fired as each call allows.
    if (rule.op === "alert_function") {
      evaluateAlertCalls(rule, tickPrice(t, rule.session));
      continue;
    }
    // A strategy: its order fills and / or its alert() calls.
    if (isStrategyOperator(rule.op)) {
      evaluateStrategy(rule, tickPrice(t, rule.session));
      continue;
    }
    const own = contextsOf(rule.symbol);
    if (!own) continue; // the chart symbol's quote is not known yet
    const session = ruleSession(rule);
    const base = session === "ETH" ? own.extended : own.regular;
    // A compared symbol's price: this tick's, else its latest quote.
    const ctx: EvalContext = ruleComparedSymbols(rule).length ? { ...base, symbolPrice: (s) => { const q = s.toUpperCase() === symbol ? t : lastTicks.get(s.toUpperCase()); return q ? tickPrice(q, rule.session) : null; } } : base;

    // A rule on the bar's close is timed by the trade (else the clock), the others by the time of the data above.
    const refMs = rule.frequency === "once_per_bar_close" ? (tradeMs ?? now) : barRefFor(rule);
    const bucket = barBucket(ruleQuoteSymbol(rule), rule.resolution, session, refMs);
    const inSession = inRuleSession(rule, refMs, extendedQuote);
    const conds = conditionRules(rule);
    // A drawing moved since the rules last changed: the rule starts again from this sample, as the backend's do.
    ruleRuntimes.resign(rule.id, ruleSignature(rule));
    const runtime = ruleRuntimes.get(rule.id);
    const reader: RuleReader = {
      bar: () => (bucket == null ? null : bucket / 1000),
      inSession: () => inSession,
      values: (k, time) => (conds[k] ? conditionValues(conds[k], ctx, time, runtime.movingRefs[k]) : null),
      // The price (of the symbol that ticked): the quote; a study, another symbol's price: its value now.
      sample: (k, s) => {
        const c = conds[k];
        if (!c) return null;
        if (c.op === "alert_condition" || ((c.left.kind === "price" || c.left.kind === "symbol") && ruleQuoteSymbol(c) === symbol)) return s;
        const v = operandValue(c.symbol, c.left, ctx, c.resolution, c.session);
        return v == null ? null : pointSample(v, s.time);
      },
    };
    const quote = quoteSample(range, t.price, bar, !extendedQuote, session === "ETH");
    const f = stepRule(evalRuleOf(rule), runtime.eval, quote, reader);
    if (!f) continue;
    // A study fires at the symbol's price; the price (or a position's level) at the price it was met at.
    const first = conds[0];
    const readsPrice = first.op !== "alert_condition" && (first.left.kind === "price" || first.left.kind === "symbol");
    deliverFire(rule, readsPrice ? f.price : ctx.price, f.barTime != null ? f.barTime * 1000 : refMs);
  }
}

// ── Moving reference poll ──
// "Moving Up / Down (%) … in N bars" compares the left operand now with its
// value N bars back on the rule's interval and session. The bars come from
// the datafeed (one getBars per symbol + interval + session per poll); a price operand uses the
// closes, an indicator operand its plot computed with the inputs saved on
// the alert. The value N bars before the last bar is kept in the rule's memory.
let movingPollBusy = false;

async function pollMovingRefs(): Promise<void> {
  if (movingPollBusy) return;
  const jobs = engineRules().flatMap((parent) => conditionRules(parent).flatMap((rule, k) => (isMovingOperator(rule.op) && isSupportedResolution(rule.resolution) ? [{ parent, rule, k }] : [])));
  if (jobs.length === 0) return;
  movingPollBusy = true;
  try {
    const barsBy = new Map<string, { time: number; open: number; high: number; low: number; close: number; volume: number }[]>();
    for (const { parent, rule, k } of jobs) {
      const session = rule.session ?? DEFAULT_SESSION;
      // A compared symbol's price: its own bars.
      const sym = ruleQuoteSymbol(rule);
      const key = `${sym}|${rule.resolution}|${session}`;
      let bars = barsBy.get(key);
      if (!bars) {
        try {
          const res = await getBars(sym, rule.resolution, session);
          bars = res.bars.flatMap((b) =>
            b.time != null && b.open != null && b.high != null && b.low != null && b.close != null
              ? [{ time: b.time as number, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }]
              : [],
          );
        } catch {
          continue; // fetch failed: keep the reference held
        }
        barsBy.set(key, bars);
      }
      const refs = ruleRuntimes.get(parent.id).movingRefs;
      const n = Math.max(1, Math.min(300, Math.round(rule.bars ?? 1)));
      const at = bars.length - 1 - n;
      if (at < 0) {
        refs[k] = null;
        continue;
      }
      if (rule.left.kind === "indicator") {
        const entry = getIndicatorEntry(rule.left.indicatorId);
        const plotId = entry?.plotConfig[rule.left.plot ?? 0]?.id;
        const out = rule.left.output ? outputByKey(entry, rule.left.output) : undefined;
        if (!entry || (rule.left.output ? !out : !plotId)) continue;
        try {
          const run = runStudy(entry, bars, rule.left.inputs ?? entry.defaultInputs, rule.symbol, rule.resolution, session, liveBarState(rule.symbol, rule.resolution, session, bars));
          const result = run.result as { plots?: Record<string, Array<{ value: number | null }>> };
          const v = out ? outputValue(run.result, out, [run.bars[at]?.time ?? bars[at].time, bars[at].time]) : result.plots?.[plotId!]?.[at]?.value;
          refs[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
        } catch (e) {
          console.warn(`[alerts] moving reference compute failed for ${rule.left.indicatorId}`, e);
        }
      } else {
        refs[k] = bars[at].close;
      }
    }
  } finally {
    movingPollBusy = false;
  }
}

let started = false;
let unlisten: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Bumped when the nearest alert expiry time is reached (re-runs the expiry effect). */
const [expiryTick, setExpiryTick] = createSignal(0);

/** Stop the engine's tick listener (the subscription effect lives in a root and
 *  persists). Mainly for tests / teardown; the app runs the engine for life. */
export function stopAlertEngine(): void {
  unlisten?.();
  unlisten = null;
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  started = false;
}

/** Start the engine: wire the tick listener, hand the backend its rules and
 *  keep it subscribed to the union of enabled-rule symbols. Idempotent.
 *  `windowLabel`: the window it runs in (the fires addressed to it). */
export function startAlertEngine(windowLabel = "main"): void {
  if (started) return;
  started = true;

  startAlertBackend(
    (f) => deliverFire(f.rule, f.price, f.barTime, f.offline ? { fireTime: f.fireTime } : undefined),
    windowLabel,
  );

  onTradeTick(onTick).then((u) => {
    unlisten = u;
  });

  // Once per run of the app (a visit on the web build): the fires missed while it was not running.
  replayMissedOnce();

  // Bars of the uncharted operands: prime once, then refresh every minute.
  void pollMovingRefs();
  void pollDrawingBars();
  pollTimer = setInterval(() => {
    void pollMovingRefs();
    void pollDrawingBars();
  }, INDICATOR_POLL_MS);

  createRoot(() => {
    // Keep the alert symbol-subscription in sync with the enabled rules so ticks
    // arrive even for symbols that aren't charted or in any watchlist. Contributes
    // to the shared watchlist feed via the subscription coordinator.
    createEffect(() => {
      // A rule on a compared symbol needs that symbol's quotes.
      const symbols = [...new Set(engineRules().flatMap((r) => [r.symbol, ...ruleComparedSymbols(r)]))];
      setSubscription("alerts", symbols);
    });

    // Expiry: stop each rule at its expiration time, whether or not its
    // symbol trades. One timer for the nearest expiry, re-armed on changes
    // (delay capped: setTimeout overflows past ~24.8 days).
    createEffect(() => {
      const now = Date.now();
      let next = Infinity;
      for (const r of engineRules()) {
        if (r.expiresAt == null) continue;
        if (r.expiresAt <= now) alertStore.setEnabled(r.id, false, "expired");
        else next = Math.min(next, r.expiresAt);
      }
      if (next === Infinity) return;
      const timer = setTimeout(() => setExpiryTick((n) => n + 1), Math.min(next - now, 86_400_000) + 50);
      expiryTick();
      onCleanup(() => clearTimeout(timer));
    });

    // The rules' memory follows the rules (which also sync in from other
    // windows via the store's kv onExternalChange): a rule edited, restarted,
    // paused or deleted (here or in another window) loses it, so a stale
    // crossing baseline or bar-close buffer cannot fire on old data. The
    // computed study values are dropped too: the rules that are left compute
    // theirs again; a new rule on an anchored VWAP, a study or a moving amount
    // gets its bars now, not at the next poll.
    createEffect(() => {
      ruleRuntimes.sync(new Map(engineRules().map((r) => [r.id, ruleSignature(r)])));
      clearStudyCaches();
      void pollDrawingBars(true);
      void pollMovingRefs();
    });
  });
}
