/*
 * Replay broker: paper trading on the charts in Bar Replay. One account per
 * chart (ReplayAccount); orders go to the focused chart's account, the
 * positions, orders and executions of every chart are shown.
 *
 * The charts report their replayed updates here (window/chart/view/replay.tsx).
 * Lifecycle (reference app): a new start point, or the replay starting or
 * stopping, opens new accounts on every chart; a symbol change opens a new one
 * on that chart; an interval change keeps it. At the end of the session
 * (end of the data, Jump to real-time) the positions are closed and the
 * results shown (SessionResult). The settings ("Trading on historical data")
 * are per chart, dropped when replay closes; "Save as default" keeps them.
 */
import { createEffect, createRoot, createSignal, on } from "solid-js";
import type { BacktestReport, Bar } from "../../backtester/types";
import { DEFAULT_SYMBOL } from "../../backtester/types";
import { getTickerInfo } from "../datafeed";
import { isEconomicSymbol } from "../datafeed";
import * as kv from "../kv";
import {
  isPaneInReplay,
  replayActivePane,
  replayEnabled,
  replayFinished,
  replayStartSeq,
  replayStarted,
  setReplayFinishHook,
} from "../replay";
import { symbolSessions } from "../session";
import { DEFAULT_REPLAY_SETTINGS, ReplayAccount, type ReplaySettings } from "./replay-account";
import type { OrderRequest, TradingEvent, TradingExecution, TradingOrder, TradingPosition, TradingQuote } from "./types";

/** What the order ticket shows instead of the form when trading is off. */
export type Tradability = { ok: boolean; reason: "ok" | "launch" | "symbol" | "loading"; title: string; text: string };

/** End of a session with trades: the "Congrats, trader!" / "Keep training" dialog. */
export type SessionResult = {
  id: number;
  symbol: string;
  description: string;
  iconUrl: string | null;
  currency: string;
  netProfit: number;
  /** Winning / closed trades (0..1); null without a winning trade. */
  winRate: number | null;
  bestTrade: number | null;
};

type SymbolMeta = {
  mintick: number;
  timezone: string;
  currency: string | null;
  description: string;
  iconUrl: string | null;
};

const DEFAULTS_KEY = "ot:replay-trading:defaults";

function readDefaults(): ReplaySettings {
  try {
    const v = JSON.parse(kv.getItem(DEFAULTS_KEY) ?? "null") as Partial<ReplaySettings> | null;
    return { ...DEFAULT_REPLAY_SETTINGS, ...(v ?? {}) };
  } catch {
    return DEFAULT_REPLAY_SETTINGS;
  }
}

export const replayBroker = createRoot(() => {
  /** Bumped on every change readers depend on (accounts, prices, metas). */
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);

  const accounts = new Map<number, ReplayAccount>();
  /** Symbol and last replayed bar of each chart in replay. */
  const panes = new Map<number, { symbol: string; last: Bar | null }>();
  const metas = new Map<string, SymbolMeta | "loading">();
  const settingsByPane = new Map<number, ReplaySettings>();
  const listeners = new Set<(e: TradingEvent) => void>();
  const [results, setResults] = createSignal<SessionResult[]>([]);
  let undoSink: ((paneId: number, before: ReplaySettings, after: ReplaySettings, label: string) => void) | null = null;
  let resultSeq = 0;

  const meta = (symbol: string): SymbolMeta | null => {
    version();
    const m = metas.get(symbol);
    if (m === "loading") return null;
    if (m) return m;
    metas.set(symbol, "loading");
    void Promise.all([getTickerInfo(symbol).catch(() => null), symbolSessions(symbol).catch(() => null)]).then(([info, sess]) => {
      metas.set(symbol, {
        mintick: sess?.mintick ?? 0.01,
        timezone: sess?.timeZone ?? DEFAULT_SYMBOL.timezone,
        // Economic series have no currency: not tradable.
        currency: isEconomicSymbol(symbol) ? null : (info?.currency ?? "").toUpperCase() || null,
        description: info?.name ?? symbol,
        iconUrl: info?.iconUrl ?? null,
      });
      bump();
    });
    return null;
  };

  const clearAll = () => {
    accounts.clear();
    setResults([]);
    bump();
  };

  // A new start point, and the replay starting or stopping: new accounts.
  createEffect(on(replayStartSeq, clearAll, { defer: true }));
  createEffect(on(replayStarted, clearAll, { defer: true }));
  // Replay closed: the settings that were not saved as default go.
  createEffect(
    on(replayEnabled, (on) => {
      if (on) return;
      settingsByPane.clear();
      panes.clear();
      clearAll();
    }),
  );

  const emit = (acc: ReplayAccount) => {
    for (const e of acc.takeEvents()) for (const l of listeners) l(e);
  };

  const settingsOf = (paneId: number): ReplaySettings => settingsByPane.get(paneId) ?? readDefaults();

  const currencyOf = (s: ReplaySettings, m: SymbolMeta | null) => (s.currency !== "NONE" ? s.currency : m?.currency ?? "USD");

  /** The account of a chart, opened at its last replayed bar. */
  const accountOf = (paneId: number, create: boolean): ReplayAccount | null => {
    const p = panes.get(paneId);
    let acc = accounts.get(paneId) ?? null;
    if (acc && p && acc.symbol !== p.symbol) {
      accounts.delete(paneId);
      acc = null;
    }
    if (acc || !create || !p?.last) return acc;
    const m = meta(p.symbol);
    if (!m || !m.currency) return null;
    const s = settingsOf(paneId);
    acc = new ReplayAccount(
      p.symbol,
      { ...DEFAULT_SYMBOL, mintick: m.mintick, timezone: m.timezone, qtyStep: 0.01 },
      s,
      currencyOf(s, m),
      p.last,
    );
    accounts.set(paneId, acc);
    return acc;
  };

  const activeId = () => replayActivePane();

  const tradabilityOf = (paneId: number | null): Tradability => {
    version();
    const launch = { ok: false as const, reason: "launch" as const, title: "Launch replay to start", text: "Select a bar to start replay and get trading." };
    if (!replayEnabled() || paneId === null || !isPaneInReplay(paneId) || replayFinished()) return launch;
    const p = panes.get(paneId);
    if (!p?.last) return launch;
    const m = meta(p.symbol);
    if (!m) return { ok: false, reason: "loading", title: "", text: "" };
    if (!m.currency) {
      return { ok: false, reason: "symbol", title: "", text: `You can’t trade the symbol ${p.symbol} within the Replay session.` };
    }
    return { ok: true, reason: "ok", title: "", text: "" };
  };

  /** Run a command on the focused chart's account. */
  const withActive = <T>(fn: (acc: ReplayAccount) => T, paneId = activeId()): T | null => {
    if (paneId === null || !tradabilityOf(paneId).ok) return null;
    const acc = accountOf(paneId, true);
    if (!acc) return null;
    const out = fn(acc);
    emit(acc);
    bump();
    return out;
  };

  // End of the session: positions closed, results for the end dialog.
  setReplayFinishHook(() => {
    let traded = false;
    const out: SessionResult[] = [];
    for (const [paneId, acc] of accounts) {
      if (!isPaneInReplay(paneId) || !acc.hasExecutions) continue;
      traded = true;
      acc.flatten();
      emit(acc);
      if (acc.netProfit === 0) continue;
      const perf = acc.report().performance.all;
      const m = metas.get(acc.symbol);
      out.push({
        id: ++resultSeq,
        symbol: acc.symbol,
        description: m && m !== "loading" ? m.description : acc.symbol,
        iconUrl: m && m !== "loading" ? m.iconUrl : null,
        currency: acc.currency,
        netProfit: acc.netProfit,
        winRate: perf.largestWinTrade !== null ? perf.percentProfitable : null,
        bestTrade: perf.largestWinTrade,
      });
    }
    bump();
    if (out.length) setResults((r) => [...r, ...out]);
    return traded;
  });

  return {
    version,

    // ── Chart feed (replay.tsx) ──────────────────────────────────────────
    /** A chart was cut at the replay time (start, or its data reloaded). */
    paneStarted(paneId: number, symbol: string, last: Bar | null) {
      panes.set(paneId, { symbol, last });
      void meta(symbol);
      const acc = accounts.get(paneId);
      if (acc && acc.symbol !== symbol) accounts.delete(paneId);
      bump();
    },
    /** Replayed updates of a chart (each one's price path) and its last bar. */
    paneUpdates(paneId: number, paths: Bar[], last: Bar | null) {
      const p = panes.get(paneId);
      if (p) p.last = last;
      const acc = accounts.get(paneId);
      if (acc) {
        for (const b of paths) acc.update(b);
        emit(acc);
      }
      bump();
    },
    paneStopped(paneId: number) {
      panes.delete(paneId);
      bump();
    },

    // ── Reads ────────────────────────────────────────────────────────────
    activePane: activeId,
    tradability: () => tradabilityOf(activeId()),
    /** The focused chart's symbol. */
    symbol: (): string | null => {
      version();
      const id = activeId();
      return id !== null ? panes.get(id)?.symbol ?? null : null;
    },
    description(symbol: string): string {
      return meta(symbol)?.description ?? symbol;
    },
    iconUrl(symbol: string): string | null {
      return meta(symbol)?.iconUrl ?? null;
    },
    /** bid = ask = the last replayed price (no spread). */
    quote: (): TradingQuote | null => {
      version();
      const id = activeId();
      if (id === null) return null;
      const p = panes.get(id);
      if (!p?.last) return null;
      const m = meta(p.symbol);
      const tick = m?.mintick ?? 0.01;
      const acc = accounts.get(id);
      const last = acc && acc.symbol === p.symbol ? acc.last : Math.round(p.last.close / tick) * tick;
      return { symbol: p.symbol, bid: last, ask: last, last, minTick: tick };
    },
    currency: (paneId = activeId()): string => {
      version();
      if (paneId === null) return "USD";
      const acc = accounts.get(paneId);
      if (acc) return acc.currency;
      const p = panes.get(paneId);
      return currencyOf(settingsOf(paneId), p ? meta(p.symbol) : null);
    },
    position(paneId: number): TradingPosition | null {
      version();
      return accountOf(paneId, false)?.position() ?? null;
    },
    orders(paneId: number): TradingOrder[] {
      version();
      return accountOf(paneId, false)?.orders() ?? [];
    },
    executions(paneId: number): TradingExecution[] {
      version();
      return accountOf(paneId, false)?.executions() ?? [];
    },
    /** Report of the focused chart's account (Replay Trading panel). */
    report(): BacktestReport | null {
      version();
      const id = activeId();
      if (id === null) return null;
      const acc = accountOf(id, false);
      return acc && acc.hasExecutions ? acc.report() : null;
    },

    // ── Commands (focused chart unless a chart is given) ─────────────────
    place: (req: OrderRequest) => withActive((a) => a.place(req)),
    modify: (id: string, req: OrderRequest, paneId?: number) => withActive((a) => a.modify(id, req), paneId),
    cancel: (id: string, paneId?: number) => withActive((a) => a.cancel(id), paneId),
    closePosition: (qty: number | null = null, paneId?: number) => withActive((a) => a.closePosition(qty), paneId),
    reverse: (paneId?: number) => withActive((a) => a.reverse(), paneId),
    setPositionBrackets: (tp: number | null, sl: number | null, paneId?: number) => withActive((a) => a.setPositionBrackets(tp, sl), paneId),
    onEvent(fn: (e: TradingEvent) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // ── Settings ─────────────────────────────────────────────────────────
    settings: (paneId = activeId()): ReplaySettings => {
      version();
      return paneId === null ? readDefaults() : settingsOf(paneId);
    },
    setSettings(s: ReplaySettings, paneId = activeId()) {
      if (paneId === null) return;
      settingsByPane.set(paneId, s);
      const acc = accounts.get(paneId);
      if (acc) {
        const p = panes.get(paneId);
        acc.applySettings(s, currencyOf(s, p ? meta(p.symbol) : null));
      }
      bump();
    },
    /** A change made in the settings dialog: an undo step when the window
     *  has an undo history (see setSettingsUndo), else applied directly. */
    changeSettings(s: ReplaySettings, label: string, paneId = activeId()) {
      if (paneId === null) return;
      const before = settingsOf(paneId);
      if (undoSink) undoSink(paneId, before, s, label);
      else this.setSettings(s, paneId);
    },
    /** The window's undo history records the settings changes (App). */
    setSettingsUndo(fn: typeof undoSink) {
      undoSink = fn;
    },
    saveDefaults(s: ReplaySettings) {
      kv.setItem(DEFAULTS_KEY, JSON.stringify(s));
    },
    factoryDefaults: (): ReplaySettings => ({ ...DEFAULT_REPLAY_SETTINGS }),

    // ── End of session ───────────────────────────────────────────────────
    results,
    dismissResult(id: number) {
      setResults((r) => r.filter((x) => x.id !== id));
    },
  };
});
