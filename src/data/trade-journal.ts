/*
 * Trade journal: imported lists of trades (kv persisted), their values read
 * on the bars (trade-journal-calc.ts), and the trade shown on the chart.
 *
 * Import resolves each symbol to its full name and exchange zone, turns the
 * file's wall-clock times into UTC, then reads the values of every trade in
 * the background (a few requests at a time); a trade whose symbol is unknown
 * or whose bars cannot be read is kept and flagged.
 */
import { createRoot, createSignal } from "solid-js";
import * as kv from "./kv";
import { getBarsBefore, toFullSymbol } from "./datafeed";
import { localToUtc, symbolSessions } from "./session";
import type { ParsedTrade, Stamp } from "./trade-journal-csv";
import {
  chartInterval,
  intervalSec,
  metricsInterval,
  tradeMetrics,
  tradingDays,
  type Bar,
  type GroupBy,
  type TradeCalc,
  type TradeInput,
} from "./trade-journal-calc";

export type TradeStatus = "pending" | "ok" | "unknown" | "nodata";

export type JournalTrade = TradeInput & {
  id: string;
  /** As written in the file ("AAPL"). */
  symbol: string;
  /** Full name ("NASDAQ:AAPL"); null when the symbol is unknown. */
  fullSymbol: string | null;
  /** Exchange time zone (date-only trades are read there). */
  zone: string;
  notes?: string;
  calc?: TradeCalc | null;
  status: TradeStatus;
};

export type Journal = { id: string; name: string; created: number; trades: JournalTrade[] };

export type SortCol = "entry" | "exit" | "symbol" | "pnl" | "pnlPct" | "drawdownPct" | "runUpPct" | "duration";
export type JournalPrefs = {
  groupBy: GroupBy;
  /** "auto": the chart takes the interval that fits the trade; "keep": its own. */
  interval: "auto" | "keep";
  sort: { col: SortCol; desc: boolean };
};

/** What the chart is asked to show for a trade. */
export type ShowRequest = {
  symbol: string;
  /** Interval to switch to; null keeps the chart's. */
  interval: string | null;
  /** The trade's span (UTC s): the chart frames it with a margin (chartFrame). */
  entryTime: number;
  exitTime: number;
  /** Start Bar Replay at this time once framed. */
  replayAt?: number;
  /** Called once the chart is framed on it. */
  onFramed?: () => void;
};

const LISTS_KEY = "ot:journal:lists";
const ACTIVE_KEY = "ot:journal:active";
const PREFS_KEY = "ot:journal:prefs";
const OPEN_KEY = "ot:journal:open";
const DEFAULT_ZONE = "America/New_York";
const DEFAULT_PREFS: JournalPrefs = { groupBy: "none", interval: "auto", sort: { col: "entry", desc: true } };
/** Bar requests running at once while values are read. */
const CONCURRENCY = 4;
/** A chart that has not framed a trade by then (no chart shown, bars not loading) is not waited for. */
const FRAME_TIMEOUT_MS = 15_000;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = kv.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

let seq = 0;
const newId = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/** UTC seconds of a stamp; wall-clock stamps read in `zone`. */
export function stampToUtc(st: Stamp, zone: string): number {
  if (st.kind === "utc") return st.sec;
  const day = Date.UTC(st.y, st.m, st.d) / 86400000;
  return localToUtc(zone, day, st.h * 60 + st.mi) + st.s;
}

export const tradeJournal = createRoot(() => {
  const [journals, setJournals] = createSignal<Journal[]>(readJson(LISTS_KEY, []));
  const [activeId, setActiveIdRaw] = createSignal<string | null>(kv.getItem(ACTIVE_KEY));
  const [prefs, setPrefsRaw] = createSignal<JournalPrefs>({ ...DEFAULT_PREFS, ...readJson<Partial<JournalPrefs>>(PREFS_KEY, {}) });
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [open, setOpenRaw] = createSignal(kv.getItem(OPEN_KEY) === "1");
  function setOpen(v: boolean) {
    setOpenRaw(v);
    kv.setItem(OPEN_KEY, v ? "1" : "0");
  }

  const save = () => kv.setItem(LISTS_KEY, JSON.stringify(journals()));
  const active = () => journals().find((j) => j.id === activeId()) ?? journals()[0] ?? null;

  function setActiveId(id: string | null) {
    setActiveIdRaw(id);
    setSelectedId(null);
    if (id) kv.setItem(ACTIVE_KEY, id);
    else kv.removeItem(ACTIVE_KEY);
  }
  function setPrefs(patch: Partial<JournalPrefs>) {
    setPrefsRaw({ ...prefs(), ...patch });
    kv.setItem(PREFS_KEY, JSON.stringify(prefs()));
  }

  function patchTrade(jid: string, tid: string, patch: Partial<JournalTrade>) {
    setJournals((js) => js.map((j) => (j.id !== jid ? j : { ...j, trades: j.trades.map((t) => (t.id === tid ? { ...t, ...patch } : t)) })));
  }

  // ── Values from the bars ─────────────────────────────────────────────
  const queue: { jid: string; tid: string }[] = [];
  let running = 0;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const barCache = new Map<string, Promise<Bar[]>>();

  function bars(symbol: string, interval: string, beforeSec: number, days: number): Promise<Bar[]> {
    const key = `${symbol}|${interval}|${beforeSec}|${days}`;
    let p = barCache.get(key);
    if (!p) {
      p = getBarsBefore(symbol, interval, beforeSec, "ETH", days).then((rows) =>
        rows
          .filter((r) => r.time !== null && r.open !== null && r.high !== null && r.low !== null && r.close !== null)
          .map((r) => ({ time: r.time!, open: r.open!, high: r.high!, low: r.low!, close: r.close! })),
      );
      p.catch(() => barCache.delete(key));
      barCache.set(key, p);
    }
    return p;
  }

  /** A trade's values: on its own interval, else on daily bars (minute
   *  history may not reach an old trade). */
  async function compute(t: JournalTrade): Promise<Partial<JournalTrade>> {
    if (!t.fullSymbol) return { status: "unknown", calc: null };
    const tries = [...new Set([metricsInterval(t), "1D"])];
    for (const iv of tries) {
      const sec = intervalSec(iv);
      const before = t.exitTime + sec;
      try {
        const rows = await bars(t.fullSymbol, iv, before, tradingDays(t.entryTime, before) + 1);
        const calc = tradeMetrics(t, rows, sec, iv);
        if (calc) return { status: "ok", calc };
      } catch {
        /* this interval cannot be read: the next one */
      }
    }
    return { status: "nodata", calc: null };
  }

  function pump() {
    while (running < CONCURRENCY && queue.length > 0) {
      const { jid, tid } = queue.shift()!;
      const t = journals()
        .find((j) => j.id === jid)
        ?.trades.find((x) => x.id === tid);
      if (!t || t.status !== "pending") continue;
      running++;
      void compute(t)
        .then((patch) => patchTrade(jid, tid, patch))
        .finally(() => {
          running--;
          clearTimeout(saveTimer);
          saveTimer = setTimeout(save, 500);
          pump();
        });
    }
  }

  /** Read the values of a journal's pending trades. */
  function enrich(jid: string) {
    const j = journals().find((x) => x.id === jid);
    if (!j) return;
    for (const t of j.trades) if (t.status === "pending") queue.push({ jid, tid: t.id });
    pump();
  }

  /** Read every value again (e.g. after the trades' data was corrected). */
  function recompute(jid: string) {
    setJournals((js) => js.map((j) => (j.id !== jid ? j : { ...j, trades: j.trades.map((t) => ({ ...t, status: "pending" as const, calc: undefined })) })));
    barCache.clear();
    save();
    enrich(jid);
  }

  // ── Import ───────────────────────────────────────────────────────────
  /** Add parsed trades to a new journal `name` (or to journal `into`).
   *  `zone`: "exchange" (each symbol's exchange zone) or an IANA zone the
   *  file's times are written in; date-only trades always take the exchange
   *  zone (their bars are stamped there). Returns the journal id and the
   *  symbols that could not be found. */
  async function importTrades(
    parsed: ParsedTrade[],
    opts: { name: string; zone: string; into?: string },
  ): Promise<{ id: string; added: number; unknown: string[]; dropped: number }> {
    const symbols = [...new Set(parsed.map((p) => p.symbol))];
    const full = new Map<string, string | null>();
    const zones = new Map<string, string>();
    await Promise.all(
      symbols.map(async (s) => {
        const f = await toFullSymbol(s).catch(() => null);
        full.set(s, f);
        zones.set(s, f ? ((await symbolSessions(f).catch(() => null))?.timeZone ?? DEFAULT_ZONE) : DEFAULT_ZONE);
      }),
    );
    let dropped = 0;
    const trades: JournalTrade[] = [];
    for (const p of parsed) {
      const zone = zones.get(p.symbol) ?? DEFAULT_ZONE;
      const dateOnly = p.entry.dateOnly && p.exit.dateOnly;
      const at = (st: Stamp) => stampToUtc(st, dateOnly || opts.zone === "exchange" ? zone : opts.zone);
      const entryTime = at(p.entry);
      const exitTime = at(p.exit);
      if (exitTime < entryTime) {
        dropped++;
        continue;
      }
      const f = full.get(p.symbol) ?? null;
      trades.push({
        id: newId(),
        symbol: f ? f.split(":").pop()! : p.symbol,
        fullSymbol: f,
        zone,
        side: p.side,
        entryTime,
        exitTime,
        dateOnly,
        qty: p.qty,
        entryPrice: p.entryPrice,
        exitPrice: p.exitPrice,
        fees: p.fees,
        notes: p.notes,
        status: f ? "pending" : "unknown",
      });
    }
    trades.sort((a, b) => a.entryTime - b.entryTime);
    let id = opts.into && journals().some((j) => j.id === opts.into) ? opts.into : null;
    if (id) {
      setJournals((js) => js.map((j) => (j.id === id ? { ...j, trades: [...j.trades, ...trades].sort((a, b) => a.entryTime - b.entryTime) } : j)));
    } else {
      id = newId();
      setJournals((js) => [...js, { id: id!, name: opts.name, created: Date.now(), trades }]);
    }
    setActiveId(id);
    save();
    enrich(id);
    return { id, added: trades.length, unknown: symbols.filter((s) => !full.get(s)), dropped };
  }

  function rename(id: string, name: string) {
    setJournals((js) => js.map((j) => (j.id === id ? { ...j, name } : j)));
    save();
  }
  function remove(id: string) {
    setJournals((js) => js.filter((j) => j.id !== id));
    if (activeId() === id) setActiveId(journals()[0]?.id ?? null);
    save();
  }
  function removeTrade(jid: string, tid: string) {
    setJournals((js) => js.map((j) => (j.id !== jid ? j : { ...j, trades: j.trades.filter((t) => t.id !== tid) })));
    if (selectedId() === tid) setSelectedId(null);
    save();
  }

  // ── Showing a trade ──────────────────────────────────────────────────
  let navigator: ((r: ShowRequest) => void) | null = null;
  /** App installs how a trade reaches the active chart. */
  function setNavigator(fn: ((r: ShowRequest) => void) | null) {
    navigator = fn;
  }

  /** Select a trade and show it on the active chart (its symbol, an interval
   *  that fits it unless the chart keeps its own, framed from entry to exit).
   *  `replay`: start Bar Replay at its entry. */
  function show(t: JournalTrade, replay = false, onFramed?: () => void) {
    setSelectedId(t.id);
    if (!t.fullSymbol || !navigator) return onFramed?.();
    const interval = prefs().interval === "auto" ? chartInterval(t, Date.now() / 1000) : null;
    navigator({ symbol: t.fullSymbol, interval, entryTime: t.entryTime, exitTime: t.exitTime, replayAt: replay ? t.entryTime : undefined, onFramed });
  }

  /** Show a trade and wait until the chart is framed on it and painted with its marks (a share pictures it). */
  function showFramed(t: JournalTrade): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, FRAME_TIMEOUT_MS);
      show(t, false, () => {
        clearTimeout(timer);
        // The chart paints the new range and marks on its next frames.
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
  }

  /** Trades of the active journal on `fullSymbol`: the chart's trade marks. */
  const marksFor = (fullSymbol: string) => (open() ? (active()?.trades.filter((t) => t.fullSymbol === fullSymbol) ?? []) : []);

  // Trades left pending by a previous run are read again.
  queueMicrotask(() => {
    for (const j of journals()) enrich(j.id);
  });

  return {
    journals,
    active,
    setActiveId,
    prefs,
    setPrefs,
    selectedId,
    setSelectedId,
    open,
    setOpen,
    importTrades,
    recompute,
    rename,
    remove,
    removeTrade,
    setNavigator,
    show,
    showFramed,
    marksFor,
  };
});
