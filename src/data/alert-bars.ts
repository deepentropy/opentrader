/*
 * The bars of an alert rule's interval and session as the window's evaluation
 * counts them (the once-per-bar triggers, the bar a fire is dated in), and
 * the rules it reads: shared by the live evaluation, the studies and the
 * delivery of the fires.
 */
import { cachedSymbolSessions, localToUtc } from "./session";
import { periodStart } from "../window/chart/chart-aggregate";
import { alertStore, isScreenRule, type AlertRule } from "./alert-store";
import { ruleQuoteSymbol } from "./alert-condition";
import type { SessionId } from "./session/symbol-sessions";
import { intervalMs, isDailyInterval, parseInterval } from "./interval";

/** Session of an alert made before alerts kept theirs: a chart's default. */
export const DEFAULT_SESSION: SessionId = "RTH";

/** The enabled rules read here: an alert on a stock screen is read on the screener's table (./screen-alerts). */
export const engineRules = (): AlertRule[] => alertStore.enabledRules().filter((r) => !isScreenRule(r));

/** Bar length of a rule's interval in ms (a month: 30 days); one minute
 *  when the id is not an interval. */
export function resolutionMs(res: string): number {
  return intervalMs(res) ?? 60_000;
}

/** Which bar bucket (its open time, UNIX ms) a timestamp falls into, for
 *  once-per-bar throttling, in the rule's session: intraday bars anchored at
 *  the start of each interval of that session (regular hours: 09:30, 10:30,
 *  ... on a US stock at 1 hour; extended hours: 04:00, 05:00, ...); daily /
 *  weekly / monthly bars by trading day in the exchange zone. Once a session
 *  ends, the time belongs to the next session's first bar, so the last bar
 *  closes at the session end (not at the next tick of the next session). Null
 *  until the symbol's session is known. */
export function barBucket(symbol: string, res: string, session: SessionId, timeMs: number): number | null {
  const sessions = cachedSymbolSessions(symbol);
  if (!sessions) return null;
  const sec = timeMs / 1000;
  const parsed = parseInterval(res);
  if (parsed && isDailyInterval(parsed)) {
    const iv = sessions.regular.currentOrNext(sec);
    if (!iv) return null;
    const day = localToUtc(sessions.timeZone, iv.day, 0);
    const period = parsed.unit as "day" | "week" | "month";
    const key = period === "day" && parsed.count === 1 ? day : periodStart(day, { unit: period, n: parsed.count }, sessions.regular);
    return key * 1000;
  }
  const iv = sessions.spec(session).currentOrNext(sec);
  if (!iv) return null;
  const step = resolutionMs(res) / 1000;
  const t = Math.max(sec, iv.start);
  return (iv.start + Math.floor((t - iv.start) / step) * step) * 1000;
}

/** The rule's session: the chart's when the rule was made, regular hours for
 *  older rules. */
export const ruleSession = (rule: AlertRule): SessionId => rule.session ?? DEFAULT_SESSION;

/** True when a tick at `timeMs` belongs to the rule's session: within its
 *  hours and, for regular hours, not a pre / post-market trade (the regular
 *  bars do not move then). */
export function inRuleSession(rule: AlertRule, timeMs: number, extendedQuote: boolean): boolean {
  const session = ruleSession(rule);
  if (session === "RTH" && extendedQuote) return false;
  return cachedSymbolSessions(ruleQuoteSymbol(rule))?.spec(session).contains(timeMs / 1000) ?? false;
}
