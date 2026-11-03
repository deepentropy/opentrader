/*
 * Alerts on a stock screen (operators `screen_enter` / `screen_exit`): a symbol enters or leaves the results of a
 * saved screen. They run in the window that runs the alerts, on the screener's market table: while one is active the
 * table loads every 10 s (as when the screener panel is open), and each update scans every watched screen.
 *
 * The first scan of a screen (an alert made or switched on, the app started, the screen's filters edited) is its
 * starting point: nothing fires for the symbols already in it. Up to MAX_SINGLE symbols moving in one update fire one alert
 * each; more fire one alert that lists them.
 */
import { createEffect, createRoot } from "solid-js";
import { alertStore, isScreenRule, type AlertRule } from "./alert-store";
import { deliverScreenFire } from "./alert-engine";
import { onScreenerUpdate, screenerClose, screenerFields, screenerOpen, screenerScan } from "./screener-api";
import { planScreen } from "./screener-query";
import { screenerStore } from "./screener-store";
import type { Screen } from "./screener-catalog";
import { watchlistStore } from "./watchlist-store";

const OWNER = "alerts:screener";
/** Symbols moving in one update that fire one alert each; more fire one alert listing them. */
export const MAX_SINGLE = 5;

/** The symbols that entered and left between two scans of a screen. */
export function screenChanges(before: ReadonlySet<string>, now: ReadonlySet<string>): { entered: string[]; left: string[] } {
  return { entered: [...now].filter((t) => !before.has(t)).sort(), left: [...before].filter((t) => !now.has(t)).sort() };
}

/** The fires of one rule for one update: one per symbol, or one for all of them past MAX_SINGLE. */
export function screenFires(symbols: string[]): string[][] {
  if (!symbols.length) return [];
  return symbols.length <= MAX_SINGLE ? symbols.map((s) => [s]) : [symbols];
}

/** Bare tickers of a watchlist (a screen's scope). */
function watchlistTickers(id: string | null): string[] | null {
  if (!id) return null;
  const l = watchlistStore.lists().find((x) => x.id === id);
  if (!l) return null;
  return [...new Set([...l.groups.flatMap((g) => g.rows), ...l.extras].map((r) => r.ticker.split(":").pop() ?? r.ticker))];
}

/** Each rule's last results, and what they were computed for (a changed screen starts again). */
const last = new Map<string, { key: string; tickers: Set<string> }>();
let started = false;

export function startScreenAlerts(): void {
  if (started) return;
  started = true;
  let known: Set<string> | null = null;
  let open = false;
  let busy = false;

  const evaluate = async () => {
    if (busy) return;
    busy = true;
    try {
      const rules = alertStore.enabledRules().filter(isScreenRule);
      if (!rules.length) return;
      known ??= new Set((await screenerFields()).filter((f) => f.available).map((f) => f.id));
      const has = (f: string) => known!.has(f);
      const now = Date.now();
      for (const rule of rules) {
        if (rule.expiresAt != null && now >= rule.expiresAt) {
          alertStore.setEnabled(rule.id, false, "expired");
          continue;
        }
        if (rule.left.kind !== "screen") continue;
        const screenId = rule.left.screenId;
        const saved = screenerStore.savedScreens().find((s) => s.id === screenId);
        if (!saved) continue;
        await evaluateRule(rule, saved.screen, has);
      }
    } catch (e) {
      console.warn("[screen-alerts] scan failed", e);
    } finally {
      busy = false;
    }
  };

  void onScreenerUpdate((u) => {
    if (!u.error) void evaluate();
  });

  createRoot(() => {
    createEffect(() => {
      const rules = alertStore.enabledRules().filter(isScreenRule);
      const ids = new Set(rules.map((r) => r.id));
      // A rule switched off or deleted starts again from its first scan.
      for (const id of [...last.keys()]) if (!ids.has(id)) last.delete(id);
      if (rules.length && !open) {
        open = true;
        void screenerOpen(OWNER).then(() => evaluate()).catch((e) => console.warn("[screen-alerts] open failed", e));
      } else if (!rules.length && open) {
        open = false;
        void screenerClose(OWNER).catch(() => {});
      }
    });
  });
}

async function evaluateRule(rule: AlertRule, screen: Screen, has: (f: string) => boolean): Promise<void> {
  const plan = planScreen(screen, has, watchlistTickers(screen.watchlistId));
  const res = await screenerScan({ columns: ["close"], filter: plan.filter, sort: null, range: [0, 100_000], tickers: plan.tickers });
  const tickers = new Set(res.rows.map((r) => r.s));
  // A symbol added to the screen's watchlist enters it: only a change of the filters starts again.
  const key = JSON.stringify([rule.op, plan.filter]);
  const before = last.get(rule.id);
  last.set(rule.id, { key, tickers });
  if (!before || before.key !== key) return;
  const { entered, left } = screenChanges(before.tickers, tickers);
  const moved = rule.op === "screen_enter" ? entered : left;
  const close = new Map(res.rows.map((r) => [r.s, typeof r.d[0] === "number" ? r.d[0] : null]));
  for (const group of screenFires(moved)) deliverScreenFire(rule, group, close.get(group[0]) ?? null);
}
