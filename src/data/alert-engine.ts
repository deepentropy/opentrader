/*
 * Alert engine — client-side evaluation of the configured alert rules.
 *
 * There is no alert backend, so this module does the evaluation in the
 * frontend: it listens to the same live tick stream the watchlist/chart use
 * (data/datafeed-live.ts), evaluates each enabled rule whose symbol just ticked,
 * respects the rule's trigger frequency, and records a fire (toast + OS
 * notification + sound + log entry) when a condition crosses/holds.
 *
 * Limitations of the frontend-first approach (to be lifted when evaluation
 * moves into the Rust poller):
 *  • Indicator-operand conditions prefer the charted study values (they honour
 *    the chart's configured inputs); uncharted symbols fall back to a 60s
 *    getBars poll computed with the study's DEFAULT inputs.
 *  • Crossing is sampled between polls (~15s cadence), not tick-exact.
 *  • once_per_bar(_close) buckets follow the symbol's own session (intraday:
 *    anchored at each extended-session interval, as the rule stores no
 *    RTH/ETH choice; daily+: the trading day / week / month in the exchange
 *    zone). Ticks wait until the symbol's session is known.
 */
import { createRoot, createEffect, createSignal, onCleanup } from "solid-js";
import { onTradeTick, getBars, isSupportedResolution, tickerOf, type TradeTick } from "./datafeed";
import { cachedSymbolSessions, localToUtc } from "./session";
import { periodStart } from "../window/chart/chart-aggregate";
import { setSubscription } from "./subscriptions";
import { alertStore, type AlertRule } from "./alert-store";
import { alertSettings } from "./alert-settings";
import { playAlertSound } from "./alert-sounds";
import { describeCondition, isPercentOperator, operandValue, type EvalContext } from "./alert-condition";
import { chartLastBarTime, indicatorPlotValue } from "./chart-state-registry";
import { getIndicatorEntry } from "../window/chart/indicators/registry";
import { commands } from "../bindings";
import * as kv from "./kv";

/** True inside the Tauri shell — gates the native webhook route. */
const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Subscribers notified on every fire — App uses this to show a transient toast. */
type FireListener = (fire: { symbol: string; title: string; message: string }) => void;
const fireListeners = new Set<FireListener>();
export function onAlertFire(fn: FireListener): () => void {
  fireListeners.add(fn);
  return () => fireListeners.delete(fn);
}

// ── Per-rule evaluation memory ──
/** Previous (left − right) difference, for crossing detection. */
const prevDiff = new Map<string, number>();
/** Bar bucket of the last fire, for once_per_bar(_close). */
const lastFiredBucket = new Map<string, number>();
/** once_per_bar_close: the forming bar's bucket + the last in-bar sample.
 *  When a tick lands in a NEWER bucket the stored bar has closed — the rule is
 *  then evaluated on that final sample (so crossings compare close-to-close). */
const barCloseState = new Map<string, { bucket: number; ctx: EvalContext }>();

// ── Per-alert webhook URLs ──
// Kept out of alert-store (its AlertRule shape follows the Fire/Alert record
// layout); keyed by rule id and persisted like the other kv maps. The dialog
// writes it, fire() posts to it, the delete paths remove it.
const WEBHOOKS_KEY = "ot:alert-webhooks:v1";
function loadWebhooks(): Record<string, string> {
  try {
    const raw = kv.getItem(WEBHOOKS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
    }
  } catch {
    /* malformed — start empty */
  }
  return {};
}
let webhooks = loadWebhooks();
kv.onExternalChange(WEBHOOKS_KEY, () => {
  webhooks = loadWebhooks();
});

/** The rule's webhook URL, or null when none is configured. */
export function alertWebhook(id: string): string | null {
  return webhooks[id] ?? null;
}

/** Set (or clear, with null/empty) a rule's webhook URL. */
export function setAlertWebhook(id: string, url: string | null): void {
  if (url?.trim()) webhooks[id] = url.trim();
  else if (id in webhooks) delete webhooks[id];
  else return; // nothing changed — skip the write
  try {
    kv.setItem(WEBHOOKS_KEY, JSON.stringify(webhooks));
  } catch {
    /* best-effort */
  }
}

/** Parse a resolution id into bar length ms. Bare numbers and "m" are
 *  minutes; "S" seconds, "H" hours, "D" days, "W" weeks, "M" months (~30d).
 *  Case-sensitive so "1M" (month) ≠ "1m" (minute). Defaults to one minute. */
function resolutionMs(res: string): number {
  const m = /^(\d+)\s*([a-zA-Z]?)$/.exec(res.trim());
  if (!m) return 60_000;
  const n = parseInt(m[1], 10) || 1;
  switch (m[2]) {
    case "S":
    case "s": return n * 1_000;
    case "H":
    case "h": return n * 3_600_000;
    case "D":
    case "d": return n * 86_400_000;
    case "W":
    case "w": return n * 604_800_000;
    case "M": return n * 2_592_000_000; // month ≈ 30 days
    case "m": // minutes (lowercase)
    case "": return n * 60_000;
    default: return n * 60_000;
  }
}

/** Which bar bucket (its open time, UNIX ms) a timestamp falls into, for
 *  once-per-bar throttling, in the symbol's own session: intraday bars
 *  anchored at the start of the extended-session interval; daily / weekly /
 *  monthly bars by trading day in the exchange zone. Once a session ends, the
 *  time belongs to the next session's first bar, so the last bar closes at the
 *  session end (not at the next tick of the next session). Null until the
 *  symbol's session is known. */
function barBucket(symbol: string, res: string, timeMs: number): number | null {
  const sessions = cachedSymbolSessions(symbol);
  if (!sessions) return null;
  const sec = timeMs / 1000;
  const m = /^(\d*)\s*([a-zA-Z]?)$/.exec(res.trim());
  const unit = m?.[2] ?? "";
  const n = Number(m?.[1] || 1);
  if (unit === "D" || unit === "d" || unit === "W" || unit === "w" || unit === "M") {
    const iv = sessions.regular.currentOrNext(sec);
    if (!iv) return null;
    const day = localToUtc(sessions.timeZone, iv.day, 0);
    const period = unit === "W" || unit === "w" ? "week" : unit === "M" ? "month" : "day";
    const key = period === "day" && n === 1 ? day : periodStart(day, { unit: period, n }, sessions.regular);
    return key * 1000;
  }
  const iv = sessions.extended.currentOrNext(sec);
  if (!iv) return null;
  const step = resolutionMs(res) / 1000;
  const t = Math.max(sec, iv.start);
  return (iv.start + Math.floor((t - iv.start) / step) * step) * 1000;
}

/** True when the rule's condition is satisfied for the current sample. Updates
 *  prevDiff as a side effect (needed for crossing). */
function conditionMet(rule: AlertRule, ctx: EvalContext): boolean {
  // Moving % : the left operand now against its value `bars` bars back (the
  // reference poll below), in percent of that value.
  if (isPercentOperator(rule.op)) {
    const now = operandValue(rule.symbol, rule.left, ctx);
    const ref = movingRefCache.get(rule.id);
    if (now == null || ref == null || ref === 0) return false;
    const change = ((now - ref) / Math.abs(ref)) * 100;
    const pct = rule.right.kind === "value" ? rule.right.value : 0;
    return rule.op === "moving_up_pct" ? change >= pct : change <= -pct;
  }

  const left = operandValue(rule.symbol, rule.left, ctx);
  const right = operandValue(rule.symbol, rule.right, ctx);
  if (left == null || right == null) return false;

  switch (rule.op) {
    case "greater":
      return left > right;
    case "less":
      return left < right;
    case "crossing":
    case "crossing_up":
    case "crossing_down": {
      const diff = left - right;
      const prev = prevDiff.get(rule.id);
      prevDiff.set(rule.id, diff);
      if (prev == null) return false; // need a baseline sample first
      if (rule.op === "crossing_up") return prev <= 0 && diff > 0;
      if (rule.op === "crossing_down") return prev >= 0 && diff < 0;
      return (prev <= 0 && diff > 0) || (prev >= 0 && diff < 0);
    }
    default:
      return false;
  }
}

/** Apply the trigger-frequency gate. `barRefMs` is the firing bar's open time
 *  (from the chart when available, else wall-clock). Returns true when a fire is
 *  allowed now, and updates the per-rule throttle state. */
function frequencyAllows(rule: AlertRule, barRefMs: number): boolean {
  switch (rule.frequency) {
    case "every_time":
      return true;
    case "only_once":
      return true; // caller disables the rule after firing
    case "once_per_bar":
    // once_per_bar_close never reaches here (onTick fires it from its own
    // bar-close branch); kept so the switch stays exhaustive.
    case "once_per_bar_close": {
      const bucket = barBucket(rule.symbol, rule.resolution, barRefMs);
      if (bucket === null || lastFiredBucket.get(rule.id) === bucket) return false;
      lastFiredBucket.set(rule.id, bucket);
      return true;
    }
  }
}

function fire(rule: AlertRule, ctx: EvalContext, barRefMs: number): void {
  const now = Date.now();
  const condText = describeCondition(rule);
  const message = rule.message?.trim()
    ? rule.message
    : `${tickerOf(rule.symbol)} ${condText} (last ${ctx.price})`;
  const title = rule.name?.trim() ? rule.name : `Alert · ${tickerOf(rule.symbol)}`;

  alertStore.recordFire({
    alertId: rule.id,
    symbol: rule.symbol,
    resolution: rule.resolution,
    name: rule.name?.trim() ? rule.name : null,
    message,
    fireTime: now,
    barTime: barBucket(rule.symbol, rule.resolution, barRefMs) ?? barRefMs,
    soundFile: rule.sound,
    logoUrl: null,
  });

  playAlertSound(rule.sound);

  // Webhook — fire-and-forget; a failing endpoint must not affect local delivery.
  const webhookUrl = alertWebhook(rule.id);
  if (webhookUrl) {
    const payload = JSON.stringify({
      id: rule.id,
      name: title,
      symbol: rule.symbol,
      price: ctx.price,
      condition: condText,
      message,
      time: new Date(now).toISOString(),
    });
    // Native POST in the shell: the webview's fetch originates from
    // tauri.localhost, so most receivers reject its CORS preflight. Plain fetch
    // covers the browser / headless-verify harness (which stubs invoke).
    if (HAS_TAURI) {
      void commands.postWebhook(webhookUrl, payload).then((r) => {
        if (r.status === "error") console.warn("[alerts] webhook post failed", r.error);
      });
    } else {
      try {
        void fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        }).catch((e) => console.warn("[alerts] webhook post failed", e));
      } catch (e) {
        console.warn("[alerts] webhook post failed", e);
      }
    }
  }

  if (rule.popup && alertSettings.systemNotifications()) {
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(title, { body: message });
      }
    } catch {
      /* notifications unavailable — toast/log still cover it */
    }
  }

  for (const fn of fireListeners) {
    try {
      fn({ symbol: rule.symbol, title, message });
    } catch {
      /* a bad listener must not break firing */
    }
  }

  // "Only Once" rules disable themselves after the single fire.
  if (rule.frequency === "only_once") {
    alertStore.setEnabled(rule.id, false);
  }
}

/** Evaluate every enabled rule for the symbol that just ticked. */
function onTick(t: TradeTick): void {
  const symbol = t.symbol.toUpperCase();
  const rules = alertStore.enabledRules().filter((r) => r.symbol === symbol);
  if (rules.length === 0) return;

  const now = Date.now();
  // Prefer the charted bar's open time for once-per-bar throttling + the fire's
  // bar_time; falls back to wall-clock for symbols that aren't charted.
  const barRefMs = chartLastBarTime(symbol) ?? now;
  const ctx: EvalContext = {
    price: t.price,
    changePercent: t.changePercent ?? null,
    timeSec: Math.floor(now / 1000),
    indicatorFallback: (indicatorId, plot) =>
      indicatorPollCache.get(pollKey(symbol, indicatorId, plot)) ?? null,
  };

  for (const rule of rules) {
    // Auto-expire.
    if (rule.expiresAt != null && now >= rule.expiresAt) {
      alertStore.setEnabled(rule.id, false);
      continue;
    }

    // Real bar-close semantics: buffer the latest in-bar sample; when a tick
    // lands past the bar's end the buffered bar has closed — evaluate on ITS
    // final values (close-to-close crossings) and fire at most once per bar.
    if (rule.frequency === "once_per_bar_close") {
      const bucket = barBucket(rule.symbol, rule.resolution, now);
      if (bucket === null) continue; // session not known yet
      const st = barCloseState.get(rule.id);
      barCloseState.set(rule.id, { bucket, ctx });
      if (!st || st.bucket === bucket) continue; // still forming — wait for the close
      if (!conditionMet(rule, st.ctx)) continue;
      if (lastFiredBucket.get(rule.id) === st.bucket) continue;
      lastFiredBucket.set(rule.id, st.bucket);
      fire(rule, st.ctx, st.bucket);
      continue;
    }

    if (!conditionMet(rule, ctx)) continue;
    if (!frequencyAllows(rule, barRefMs)) continue;
    fire(rule, ctx, barRefMs);
  }
}

// ── Indicator-operand fallback poll ──
// Indicator values normally come from the charted study (chart-state-registry).
// For rules whose symbol isn't charted (or doesn't carry the study), a 60s poll
// fetches bars via the datafeed and computes the study with its DEFAULT inputs,
// caching the latest plot value for operandValue's ctx.indicatorFallback.
const INDICATOR_POLL_MS = 60_000;
const indicatorPollCache = new Map<string, number | null>();
let indicatorPollTimer: ReturnType<typeof setInterval> | null = null;
let indicatorPollBusy = false;

function pollKey(symbol: string, indicatorId: string, plot: number): string {
  return `${symbol.toUpperCase()}|${indicatorId}|${plot}`;
}

/** Latest finite value of one plot series (index per the entry's plotConfig
 *  order — the same order the dialog's plot-0 convention uses). */
function lastPlotValue(result: unknown, plotId: string): number | null {
  const plots = (result as { plots?: Record<string, Array<{ value: number | null }>> } | null)?.plots;
  const series = plots?.[plotId];
  if (!series) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i]?.value;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

async function pollIndicatorOperands(): Promise<void> {
  if (indicatorPollBusy) return; // a slow fetch must not stack polls
  // Group the wanted (indicator, plot) pairs by symbol+resolution so each poll
  // does one getBars per series, however many rules reference it.
  const jobs = new Map<string, { symbol: string; resolution: string; ops: { indicatorId: string; plot: number }[] }>();
  for (const rule of alertStore.enabledRules()) {
    if (!isSupportedResolution(rule.resolution)) continue;
    for (const o of [rule.left, rule.right]) {
      if (o.kind !== "indicator") continue;
      const plot = o.plot ?? 0;
      // Charted studies already serve live values — no fetch needed.
      if (indicatorPlotValue(rule.symbol, o.indicatorId, plot) != null) continue;
      if (!getIndicatorEntry(o.indicatorId)) continue;
      const key = `${rule.symbol}|${rule.resolution}`;
      let job = jobs.get(key);
      if (!job) jobs.set(key, (job = { symbol: rule.symbol, resolution: rule.resolution, ops: [] }));
      if (!job.ops.some((x) => x.indicatorId === o.indicatorId && x.plot === plot)) {
        job.ops.push({ indicatorId: o.indicatorId, plot });
      }
    }
  }
  if (jobs.size === 0) return;

  indicatorPollBusy = true;
  try {
    for (const job of jobs.values()) {
      try {
        const { bars } = await getBars(job.symbol, job.resolution);
        // The library wants dense numeric OHLC; drop null-field rows.
        const clean = bars.flatMap((b) =>
          b.time != null && b.open != null && b.high != null && b.low != null && b.close != null
            ? [{ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }]
            : [],
        );
        if (clean.length === 0) continue;
        for (const op of job.ops) {
          const entry = getIndicatorEntry(op.indicatorId)!;
          try {
            const result = entry.calculate(clean, entry.defaultInputs);
            const plotId = entry.plotConfig[op.plot]?.id;
            indicatorPollCache.set(
              pollKey(job.symbol, op.indicatorId, op.plot),
              plotId ? lastPlotValue(result, plotId) : null,
            );
          } catch (e) {
            console.warn(`[alerts] indicator poll compute failed for ${op.indicatorId}`, e);
          }
        }
      } catch {
        /* fetch failed — keep any stale cached value rather than clearing it */
      }
    }
  } finally {
    indicatorPollBusy = false;
  }
}

// ── Moving % reference poll ──
// "Moving up / down % … in N bars" compares the left operand now with its
// value N bars back on the rule's interval. The bars come from the datafeed
// (one getBars per symbol + interval per poll); a price operand uses the
// closes, an indicator operand its plot computed with the study's default
// inputs. The value N bars before the last bar is cached per rule.
const movingRefCache = new Map<string, number | null>();
let movingPollBusy = false;

async function pollMovingRefs(): Promise<void> {
  if (movingPollBusy) return;
  const rules = alertStore.enabledRules().filter((r) => isPercentOperator(r.op) && isSupportedResolution(r.resolution));
  if (rules.length === 0) return;
  movingPollBusy = true;
  try {
    const barsBy = new Map<string, { time: number; open: number; high: number; low: number; close: number; volume: number }[]>();
    for (const rule of rules) {
      const key = `${rule.symbol}|${rule.resolution}`;
      let bars = barsBy.get(key);
      if (!bars) {
        try {
          const res = await getBars(rule.symbol, rule.resolution);
          bars = res.bars.flatMap((b) =>
            b.time != null && b.open != null && b.high != null && b.low != null && b.close != null
              ? [{ time: b.time as number, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }]
              : [],
          );
        } catch {
          continue; // fetch failed: keep the cached reference
        }
        barsBy.set(key, bars);
      }
      const n = Math.max(1, Math.min(300, Math.round(rule.bars ?? 1)));
      const at = bars.length - 1 - n;
      if (at < 0) {
        movingRefCache.set(rule.id, null);
        continue;
      }
      if (rule.left.kind === "indicator") {
        const entry = getIndicatorEntry(rule.left.indicatorId);
        const plotId = entry?.plotConfig[rule.left.plot ?? 0]?.id;
        if (!entry || !plotId) continue;
        try {
          const result = entry.calculate(bars, entry.defaultInputs) as { plots?: Record<string, Array<{ value: number | null }>> };
          const v = result.plots?.[plotId]?.[at]?.value;
          movingRefCache.set(rule.id, typeof v === "number" && Number.isFinite(v) ? v : null);
        } catch (e) {
          console.warn(`[alerts] moving reference compute failed for ${rule.left.indicatorId}`, e);
        }
      } else {
        movingRefCache.set(rule.id, bars[at].close);
      }
    }
  } finally {
    movingPollBusy = false;
  }
}

let started = false;
let unlisten: (() => void) | null = null;
/** Bumped when the nearest alert expiry time is reached (re-runs the expiry effect). */
const [expiryTick, setExpiryTick] = createSignal(0);

/** Stop the engine's tick listener (the subscription effect lives in a root and
 *  persists). Mainly for tests / teardown; the app runs the engine for life. */
export function stopAlertEngine(): void {
  unlisten?.();
  unlisten = null;
  if (indicatorPollTimer != null) {
    clearInterval(indicatorPollTimer);
    indicatorPollTimer = null;
  }
  started = false;
}

/** Start the engine: wire the tick listener and keep the backend subscribed to
 *  the union of enabled-rule symbols. Idempotent. */
export function startAlertEngine(): void {
  if (started) return;
  started = true;

  onTradeTick(onTick).then((u) => {
    unlisten = u;
  });

  // Uncharted indicator operands: prime once, then refresh every minute.
  void pollIndicatorOperands();
  void pollMovingRefs();
  indicatorPollTimer = setInterval(() => {
    void pollIndicatorOperands();
    void pollMovingRefs();
  }, INDICATOR_POLL_MS);

  // Keep the alert symbol-subscription in sync with the enabled rules so ticks
  // arrive even for symbols that aren't charted or in any watchlist. Contributes
  // to the shared watchlist feed via the subscription coordinator.
  createRoot(() => {
    createEffect(() => {
      const symbols = [...new Set(alertStore.enabledRules().map((r) => r.symbol))];
      setSubscription("alerts", symbols);
    });

    // Expiry: stop each rule at its expiration time, whether or not its
    // symbol trades. One timer for the nearest expiry, re-armed on changes
    // (delay capped: setTimeout overflows past ~24.8 days).
    createEffect(() => {
      const now = Date.now();
      let next = Infinity;
      for (const r of alertStore.enabledRules()) {
        if (r.expiresAt == null) continue;
        if (r.expiresAt <= now) alertStore.setEnabled(r.id, false);
        else next = Math.min(next, r.expiresAt);
      }
      if (next === Infinity) return;
      const timer = setTimeout(() => setExpiryTick((n) => n + 1), Math.min(next - now, 86_400_000) + 50);
      expiryTick();
      onCleanup(() => clearTimeout(timer));
    });

    // Eval-state hygiene, tracking the rules list (which also syncs in from
    // other windows via the store's kv onExternalChange):
    //  • disabled → enabled: drop the rule's pre-disable memory — a stale
    //    once_per_bar_close buffer would otherwise fire on old data, and a
    //    stale crossing baseline can manufacture a spurious cross.
    //  • deleted (here or in another window): prune the per-rule maps so ids
    //    that no longer exist can't leak entries.
    //  • indicator poll cache: keyed by (symbol, indicator, plot), so drop
    //    entries no remaining rule references.
    let prevEnabledIds = new Set<string>();
    createEffect(() => {
      const rules = alertStore.rules();
      const ids = new Set(rules.map((r) => r.id));
      const enabledIds = new Set(rules.filter((r) => r.enabled).map((r) => r.id));
      for (const id of enabledIds) {
        if (!prevEnabledIds.has(id)) resetRuleEvalState(id);
      }
      prevEnabledIds = enabledIds;
      for (const m of [prevDiff, lastFiredBucket, barCloseState]) {
        for (const id of m.keys()) if (!ids.has(id)) m.delete(id);
      }
      const wantedPolls = new Set<string>();
      for (const r of rules) {
        for (const o of [r.left, r.right]) {
          if (o.kind === "indicator") wantedPolls.add(pollKey(r.symbol, o.indicatorId, o.plot ?? 0));
        }
      }
      for (const k of indicatorPollCache.keys()) {
        if (!wantedPolls.has(k)) indicatorPollCache.delete(k);
      }
    });
  });
}

/** Forget a rule's per-evaluation memory (crossing baseline + bar throttle).
 *  Call when a rule's condition changes (edit) so a stale baseline can't
 *  manufacture a spurious cross, and on delete to avoid leaking map entries. */
export function resetRuleEvalState(id: string): void {
  prevDiff.delete(id);
  lastFiredBucket.delete(id);
  barCloseState.delete(id);
  // A changed Moving % rule needs its reference now, not at the next poll.
  movingRefCache.delete(id);
  if (started) void pollMovingRefs();
}

/** Request OS-notification permission (call from a user gesture, e.g. saving a
 *  popup alert in the dialog). */
export function ensureNotificationPermission(): void {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  } catch {
    /* unsupported context */
  }
}
