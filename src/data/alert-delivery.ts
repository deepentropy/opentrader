/*
 * Delivery of the alert fires, whoever found them (the backend's engine, the
 * window's evaluation, the replay of the missed bars, a stock screen): the
 * log entry, the sound, the OS notification, the in-app toast and the
 * webhook, with the message's placeholders filled in.
 */
import { getBars, getTickerInfo, isSupportedResolution, tickerOf } from "./datafeed";
import { cachedSymbolSessions } from "./session";
import { alertStore, alertWebhook, type AlertRule, type WebhookOutcome } from "./alert-store";
import { inSchedule } from "./alert-schedule";
import { alertSettings } from "./alert-settings";
import { playAlertSound } from "./alert-sounds";
import { translateWith } from "../i18n/translator";
import { defaultAlertMessage, describeCondition, positionHit, POSITION_LEVEL_NAMES } from "./alert-condition";
import { chartBars, type ChartBar } from "./chart-state-registry";
import { getIndicatorEntry } from "../window/chart/indicators/registry";
import { isStrategyId } from "../window/chart/indicators/strategy-entries";
import { commands } from "../bindings";
import { fillPlaceholders, needsBarData, type PlaceholderValues } from "./alert-placeholders";
import { messageOutputs, outputValue } from "./alert-outputs";
import { DEFAULT_SESSION, resolutionMs } from "./alert-bars";
import { CLOSED_BARS, liveBarState, runStudy } from "./alert-studies";
import { isDailyInterval } from "./interval";

/** True inside the Tauri shell — gates the native webhook route. */
const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Subscribers notified on every fire — App uses this to show a transient toast. */
type FireListener = (fire: { alertId: string; symbol: string; title: string; message: string; time: number; sound: string }) => void;
const fireListeners = new Set<FireListener>();
export function onAlertFire(fn: FireListener): () => void {
  fireListeners.add(fn);
  return () => fireListeners.delete(fn);
}

// ── Message placeholders ──
// A fired message reads the bar of the rule's interval and session the alert
// fired in, and the plots of its source study at that bar: the chart's bars
// when a chart shows them, else fetched (at most once every few seconds per
// series, so the fires of one replay share a fetch).
const MESSAGE_BARS_MS = 5000;
const messageBarsCache = new Map<string, { at: number; bars: Promise<ChartBar[] | null> }>();

function messageBars(rule: AlertRule, fresh = false): Promise<ChartBar[] | null> {
  const session = rule.session ?? DEFAULT_SESSION;
  const charted = chartBars(rule.symbol, rule.resolution, session);
  if (charted) return Promise.resolve(charted);
  if (!isSupportedResolution(rule.resolution)) return Promise.resolve(null);
  const key = `${rule.symbol}|${rule.resolution}|${session}`;
  const now = Date.now();
  const hit = messageBarsCache.get(key);
  if (hit && !fresh && now - hit.at < MESSAGE_BARS_MS) return hit.bars;
  for (const [k, v] of messageBarsCache) if (now - v.at > 60_000) messageBarsCache.delete(k);
  const bars = getBars(rule.symbol, rule.resolution, session).then(
    (r) =>
      r.bars.flatMap((b) =>
        b.time != null && b.open != null && b.high != null && b.low != null && b.close != null
          ? [{ time: b.time as number, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }]
          : [],
      ),
    () => null,
  );
  messageBarsCache.set(key, { at: now, bars });
  return bars;
}

/** Index of the bar that holds `barTime` (UNIX ms; null = the newest bar), or -1 when the bars end before it. */
function fireBarIndex(bars: ChartBar[], resolution: string, barTime: number | null): number {
  if (!bars.length) return -1;
  if (barTime == null) return bars.length - 1;
  let i = bars.length - 1;
  while (i >= 0 && bars[i].time * 1000 > barTime) i--;
  if (i < 0) return -1;
  // The newest bar loaded ends before the fire: the fire's bar is not loaded yet (a month counted as 31 days).
  const span = /M$/.test(resolution) ? (Number(resolution.slice(0, -1)) || 1) * 31 * 86_400_000 : resolutionMs(resolution);
  if (i === bars.length - 1 && bars[i].time * 1000 + span <= barTime) return -1;
  return i;
}

/** Outputs of the rule's source study at bar `i` of `bars`, in message order (plots, shapes, characters, arrows in
 *  the script's order); waits (up to `waitMs`) for a study that computes asynchronously. Null when the source is not
 *  a study (a strategy has no plot placeholders) or it cannot be computed. */
async function messagePlots(rule: AlertRule, bars: ChartBar[], i: number, live: boolean, waitMs = 10_000): Promise<PlaceholderValues["plots"]> {
  const op = rule.left;
  if (op.kind !== "indicator" || isStrategyId(op.indicatorId)) return null;
  const entry = getIndicatorEntry(op.indicatorId);
  if (!entry) return null;
  const session = rule.session ?? DEFAULT_SESSION;
  const dense = bars.slice(0, i + 1).map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
  const state = live ? liveBarState(rule.symbol, rule.resolution, session, bars.slice(0, i + 1)) : CLOSED_BARS;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const run = runStudy(entry, dense, op.inputs ?? entry.defaultInputs, rule.symbol, rule.resolution, session, state, `message|${rule.id}`);
      const result = run.result as { plots?: unknown; pending?: boolean } | null;
      if (result?.plots && !result.pending) {
        // The bar's time as the study was given it, and as charted.
        const times = [run.bars[i]?.time as number, bars[i].time];
        return messageOutputs(entry).map((o) => ({ title: o.title, value: outputValue(result, o, times) }));
      }
    } catch (e) {
      console.warn(`[alerts] message plots failed for ${op.indicatorId}`, e);
      return null;
    }
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The bars of a daily, weekly or monthly rule with the trading day in progress: the daily history ends with the day
 *  before, so that day's regular-session minutes are added to the bar of the fire's period (a new bar when the period
 *  starts that day), as a chart adds them to its forming bar. `i`: index of the fire's bar, -1 when it is not loaded. */
async function withTradingDay(rule: AlertRule, bars: ChartBar[], i: number, barTime: number | null, fireTime: number): Promise<{ bars: ChartBar[]; i: number }> {
  const sessions = cachedSymbolSessions(rule.symbol);
  const iv = sessions?.regular.currentOrPrevious(fireTime / 1000);
  if (!sessions || !iv || barTime == null) return { bars, i };
  const daily = rule.resolution === "1D" ? bars : await messageBars({ ...rule, resolution: "1D" });
  // A daily bar is stamped at midnight of its trading day: the day is loaded when the newest one is that late.
  if (!daily?.length || daily[daily.length - 1].time > iv.start - 86_400) return { bars, i };
  const minutes = await messageBars({ ...rule, resolution: "1", session: "RTH" });
  const day = minutes?.filter((b) => b.time >= iv.start && b.time < iv.end) ?? [];
  if (!day.length) return { bars, i };
  const part = {
    open: day[0].open,
    high: Math.max(...day.map((b) => b.high)),
    low: Math.min(...day.map((b) => b.low)),
    volume: day.reduce((v, b) => v + (b.volume ?? 0), 0),
  };
  if (i >= 0 && bars[i].time * 1000 === barTime) {
    const b = bars[i];
    const merged = { ...b, high: Math.max(b.high, part.high), low: Math.min(b.low, part.low), volume: (b.volume ?? 0) + part.volume };
    return { bars: [...bars.slice(0, i), merged, ...bars.slice(i + 1)], i };
  }
  if (i >= 0) return { bars, i };
  return { bars: [...bars, { time: barTime / 1000, ...part, close: day[day.length - 1].close }], i: bars.length };
}

/** Open time (UNIX ms) of a bar as a message gives it: a daily, weekly or monthly bar opens with the regular session
 *  of its first day (13:30Z for a US stock, 00:00Z for a 24-hour market), not at midnight. */
function barOpenTime(rule: AlertRule, ms: number | null): number | null {
  if (ms == null || !isDailyInterval(rule.resolution)) return ms;
  const iv = cachedSymbolSessions(rule.symbol)?.regular.currentOrNext(ms / 1000);
  return iv && iv.start * 1000 - ms < 86_400_000 ? iv.start * 1000 : ms;
}

/** What the placeholders of a fire give besides the bar and the study: the order fill of a strategy alert, the level
 *  a position alert hit. */
export type FireDetails = Pick<PlaceholderValues, "strategy" | "position">;

/** What the placeholders of `text` give for a fire of `rule` at `price`, in the bar opened at `barTime`. */
async function placeholderValues(rule: AlertRule, text: string, price: number, barTime: number | null, fireTime: number, live: boolean, details?: FireDetails): Promise<PlaceholderValues> {
  const values: PlaceholderValues = { symbol: rule.symbol, interval: rule.resolution, barTime, fireTime, bar: null, currency: null, baseCurrency: null, plots: null, ...details };
  if (/\{\{syminfo\./.test(text)) {
    try {
      const info = await getTickerInfo(rule.symbol);
      values.currency = info.currency?.toUpperCase() ?? null;
      // A security (stock, fund, receipt, warrant) has no base currency: empty, as the reference gives it.
      if (info.symbolType) values.baseCurrency = "";
    } catch {
      /* reference data unavailable: the placeholder stays as written */
    }
  }
  values.barTime = barOpenTime(rule, barTime);
  // A strategy's alert writes prices in the symbol's price format.
  const sessions = details?.strategy ? cachedSymbolSessions(rule.symbol) : null;
  if (sessions) values.priceText = (v) => sessions.formatPrice(v);
  if (!needsBarData(text)) return values;
  let bars = await messageBars(rule);
  let i = bars ? fireBarIndex(bars, rule.resolution, barTime) : -1;
  // The fire's bar is newer than the fetched bars: fetch them again once.
  if (bars && i < 0 && !chartBars(rule.symbol, rule.resolution, rule.session ?? DEFAULT_SESSION)) {
    bars = await messageBars(rule, true);
    i = bars ? fireBarIndex(bars, rule.resolution, barTime) : -1;
  }
  // A live fire on a daily, weekly or monthly interval read from fetched bars: the day in progress is not in them.
  if (bars && live && isDailyInterval(rule.resolution) && !chartBars(rule.symbol, rule.resolution, rule.session ?? DEFAULT_SESSION)) {
    ({ bars, i } = await withTradingDay(rule, bars, i, barTime, fireTime));
  }
  // Still newer for a live fire: the bar time follows the clock while the data are delayed; the fire's price belongs
  // to the newest bar loaded.
  if (bars?.length && i < 0 && live && barTime != null && barTime > bars[bars.length - 1].time * 1000) i = bars.length - 1;
  if (!bars || i < 0) return values;
  // The bar as it stood at the fire: its close is the fire's price.
  const b = bars[i];
  const bar = { time: b.time, open: b.open, high: Math.max(b.high, price), low: Math.min(b.low, price), close: price, volume: b.volume ?? 0 };
  values.bar = bar;
  values.barTime = barOpenTime(rule, b.time * 1000);
  values.plots = await messagePlots(rule, [...bars.slice(0, i), bar], i, live);
  return values;
}

/** Deliver a fire of `rule` at `price`, in the bar opened at `barTime`
 *  (epoch ms). `offline`: the time it happened, for a fire found in the bars
 *  missed while the app was not running; it goes to the log and the rule's
 *  webhook only (no sound, notification or toast). The message is sent once
 *  its placeholders are filled in. `callMessage`: the message of a script's
 *  alert() call, sent as it is. `details`: the order fill of a strategy alert,
 *  the level a position alert hit, for their placeholders. */
export function deliverFire(rule: AlertRule, price: number, barTime: number | null, offline?: { fireTime: number }, callMessage?: string, details?: FireDetails): void {
  if (callMessage !== undefined) {
    sendFire(rule, price, barTime, callMessage, offline);
    return;
  }
  const fireTime = offline ? offline.fireTime : Date.now();
  const text = rule.message?.trim() ? rule.message : defaultAlertMessage(rule);
  if (rule.op === "hits_level" && rule.right.kind === "drawing") {
    // A long / short position: the level it hit; its stop or profit level ends the alert (the entry does not).
    const hit = positionHit(rule.symbol, rule.right.drawingId, price);
    details = { ...details, position: hit };
    if (!offline && hit && hit.level !== POSITION_LEVEL_NAMES.entry) alertStore.setEnabled(rule.id, false, "triggered");
  } else if (rule.frequency === "only_once") {
    // "Only Once" rules disable themselves after the single fire.
    alertStore.setEnabled(rule.id, false, "triggered");
  }
  void placeholderValues(rule, text, price, barTime, fireTime, !offline, details)
    .then(
      (values) => fillPlaceholders(text, values),
      (e) => {
        console.warn("[alerts] message placeholders not filled", e);
        return text;
      },
    )
    .then((message) => sendFire(rule, price, barTime, message, offline));
}

/** Symbols entered or left the results of a stock screen the rule watches (./screen-alerts): one fire, delivered like
 *  the others (log, sound, notification, toast, webhook), for one symbol (its price) or for several (listed in the
 *  message unless the rule has its own). */
export function deliverScreenFire(rule: AlertRule, symbols: string[], price: number | null): void {
  if (!symbols.length) return;
  const title = rule.left.kind === "screen" ? rule.left.title : "";
  const several = rule.op === "screen_enter" ? "{0} entered {1}" : "{0} left {1}";
  const message = rule.message?.trim() || (symbols.length > 1 ? translateWith(several, symbols.join(", "), title) : "");
  deliverFire({ ...rule, symbol: symbols[0], message }, symbols.length > 1 ? NaN : (price ?? NaN), null);
}

function sendFire(rule: AlertRule, price: number, barTime: number | null, message: string, offline?: { fireTime: number }): void {
  const now = Date.now();
  const condText = describeCondition(rule);
  // An alert on a script's alert() calls is known by its condition (its fires carry the calls' messages).
  const title = rule.name?.trim() ? rule.name : rule.op === "alert_function" || rule.op === "strategy_alerts" ? condText : translateWith("Alert · {0}", tickerOf(rule.symbol));

  const fire = alertStore.recordFire({
    alertId: rule.id,
    symbol: rule.symbol,
    resolution: rule.resolution,
    name: rule.name?.trim() ? rule.name : null,
    message,
    fireTime: offline ? offline.fireTime : now,
    barTime,
    soundFile: rule.sound,
    logoUrl: null,
    ...(offline ? { offline: true, receivedAt: now } : {}),
  });

  // Outside the notification schedule the fire is logged, nothing else (reference: notifications are muted).
  if (!inSchedule(rule.schedule, offline ? offline.fireTime : now)) return;

  if (!offline) playAlertSound(rule.sound, { duration: rule.soundDuration ?? 0 });

  // Webhook — not waited on; a failing endpoint must not affect local delivery.
  // Its outcome is written on the event. An offline fire is posted too, with
  // the time it happened and `offline`.
  const webhookUrl = alertWebhook(rule.id);
  if (webhookUrl) {
    const payload = JSON.stringify({
      id: rule.id,
      name: title,
      symbol: rule.symbol,
      price,
      condition: condText,
      message,
      time: new Date(offline ? offline.fireTime : now).toISOString(),
      ...(offline ? { offline: true } : {}),
    });
    // Native POST in the shell: the webview's fetch originates from
    // tauri.localhost, so most receivers reject its CORS preflight. Plain fetch
    // covers the browser / headless-verify harness (which stubs invoke).
    const done = (r: WebhookOutcome) => {
      alertStore.setFireWebhook(fire.fireId, r);
      if (r.error || (r.httpCode != null && (r.httpCode < 200 || r.httpCode >= 300))) console.warn("[alerts] webhook post failed", r.httpCode, r.error);
    };
    if (HAS_TAURI) {
      void commands.postWebhook(webhookUrl, payload).then(done, (e) => done({ httpCode: null, error: String(e) }));
    } else {
      void fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }).then((res) => done({ httpCode: res.status, error: null }), (e) => done({ httpCode: null, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  if (offline) return;

  if (rule.popup && alertSettings.systemNotifications()) {
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(title, { body: message });
      }
    } catch {
      /* notifications unavailable — toast/log still cover it */
    }
  }

  // The in-app toast ("Show toast notification", on unless switched off).
  if (rule.toast === false) return;
  for (const fn of fireListeners) {
    try {
      fn({ alertId: rule.id, symbol: rule.symbol, title, message, time: now, sound: rule.sound });
    } catch {
      /* a bad listener must not break firing */
    }
  }
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
