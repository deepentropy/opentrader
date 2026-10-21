/*
 * Trading settings that are app-wide in the reference app (not per chart):
 * one-click trading, the execution sound, "Show only rejection
 * notifications" and "Orders, executions, and positions in chart snapshots".
 * They show in every chart's Settings → Trading tab; the dialog reads them
 * from here when it opens and writes them back on Ok, so a change applies to
 * every chart (and is kept across restarts).
 */
import { createRoot, createSignal } from "solid-js";
import * as kv from "../kv";
import { makeDefaultDraft, tradingAppearance, type Draft, type RowState } from "../../window/header/chart-settings";

const KEY = "ot:trading:app-prefs";

/** Draft keys of the app-wide rows of the Trading tab. */
export const APP_WIDE_TRADING_ROWS = [
  "trading:One-click trading",
  "trading:Execution sound",
  "trading:Execution sound type",
  "trading:Show only rejection notifications",
  "trading:Orders, executions, and positions in chart snapshots",
] as const;

export type TradingPrefs = {
  oneClick: boolean;
  /** Execution sound: null = off; else the sound-bank key and volume 0-1. */
  sound: { key: string; volume: number } | null;
  rejectionOnly: boolean;
  /** Positions, orders and executions drawn in chart snapshots. */
  snapshot: boolean;
};

function readRows(): Partial<Draft> {
  try {
    const v = JSON.parse(kv.getItem(KEY) ?? "null") as Record<string, RowState> | null;
    if (!v || typeof v !== "object") return {};
    const out: Partial<Draft> = {};
    for (const k of APP_WIDE_TRADING_ROWS) {
      const r = v[k];
      if (r && Array.isArray(r.controls)) out[k] = { checked: r.checked ?? null, controls: r.controls };
    }
    return out;
  } catch {
    return {};
  }
}

function prefsOf(rows: Partial<Draft>): TradingPrefs {
  const d = { ...makeDefaultDraft(), ...rows } as Draft;
  const t = tradingAppearance(d);
  return {
    oneClick: t.oneClick,
    sound: t.sound,
    rejectionOnly: t.rejectionOnly,
    snapshot: !!d["trading:Orders, executions, and positions in chart snapshots"]?.checked,
  };
}

export const tradingPrefs = createRoot(() => {
  const [rows, setRowsRaw] = createSignal<Partial<Draft>>(readRows());
  const [prefs, setPrefs] = createSignal<TradingPrefs>(prefsOf(rows()));
  return {
    prefs,
    /** The app-wide rows (dialog seed); the rows not set yet are absent. */
    rows,
    /** Store the app-wide rows of a committed dialog draft. */
    setRows(d: Draft) {
      const next: Partial<Draft> = {};
      for (const k of APP_WIDE_TRADING_ROWS) if (d[k]) next[k] = { checked: d[k].checked, controls: d[k].controls.map((c) => ({ ...c })) as RowState["controls"] };
      setRowsRaw(next);
      setPrefs(prefsOf(next));
      kv.setItem(KEY, JSON.stringify(next));
    },
  };
});
