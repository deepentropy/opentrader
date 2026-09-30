/*
 * Scan controller: loads screener rows by pages of 100 (the reference app sends
 * `range:[0,100]`, then the next pages as the table scrolls) and keeps one
 * scan in flight at a time, so a burst of changes costs one extra scan.
 *
 * `reset()` (the plan changed: filters, sort, columns, scope) drops the rows;
 * `refresh()` (a backend update or the Refresh button) keeps the rows on
 * screen and re-fetches the visible pages, so the table never blanks.
 */
import { batch, createSignal } from "solid-js";
import type { ScanRow } from "../../bindings";
import { screenerScan } from "../../data/screener-api";
import type { Plan } from "../../data/screener-query";

export const PAGE = 100;

export function createScanController(plan: () => Plan | null) {
  const [total, setTotal] = createSignal<number | null>(null);
  const [rev, setRev] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  /** Page index → rows; `fresh` holds the pages loaded for the current generation. */
  let pages = new Map<number, ScanRow[]>();
  let fresh = new Set<number>();
  let gen = 0;
  let inflight = false;
  let visible = { first: 0, last: 0 };
  let lastMs = 0;

  const neededPages = (): number[] => {
    const t = total();
    const maxPage = t === null ? 0 : Math.max(0, Math.ceil(t / PAGE) - 1);
    const p0 = Math.min(Math.floor(visible.first / PAGE), maxPage);
    const p1 = Math.min(Math.floor(visible.last / PAGE), maxPage);
    const out: number[] = [];
    for (let p = p0; p <= p1; p++) if (!fresh.has(p)) out.push(p);
    return out;
  };

  async function pump(): Promise<void> {
    if (inflight) return;
    const need = neededPages();
    if (!need.length) {
      setLoading(false);
      return;
    }
    const p = plan();
    if (!p) return;
    // One request covers the contiguous run of missing pages.
    let last = need[0];
    while (need.includes(last + 1)) last++;
    const from = need[0] * PAGE;
    const to = (last + 1) * PAGE;
    const myGen = gen;
    inflight = true;
    setLoading(true);
    const t0 = performance.now();
    try {
      const res = await screenerScan({ columns: p.fields, filter: p.filter, sort: p.sort, range: [from, to], tickers: p.tickers });
      if (myGen === gen) {
        batch(() => {
          for (let pg = need[0]; pg <= last; pg++) {
            pages.set(pg, res.rows.slice((pg - need[0]) * PAGE, (pg - need[0] + 1) * PAGE));
            fresh.add(pg);
          }
          // Pages past the end of a shrunk result are dropped.
          const maxPage = Math.max(0, Math.ceil(res.totalCount / PAGE) - 1);
          for (const k of [...pages.keys()]) if (k > maxPage) pages.delete(k);
          setTotal(res.totalCount);
          setError(null);
          setRev((r) => r + 1);
        });
        lastMs = performance.now() - t0;
      }
    } catch (e) {
      if (myGen === gen) {
        setError(e instanceof Error ? e.message : String(e));
        // Mark the pages as done so a failing backend does not spin.
        for (let pg = need[0]; pg <= last; pg++) fresh.add(pg);
      }
    } finally {
      inflight = false;
      void pump();
    }
  }

  return {
    total,
    error,
    loading,
    /** Row at index i (undefined while its page loads). Tracks row changes. */
    row(i: number): ScanRow | undefined {
      rev();
      return pages.get(Math.floor(i / PAGE))?.[i % PAGE];
    },
    rev,
    lastScanMs: () => lastMs,
    setVisible(first: number, last: number): void {
      visible = { first, last };
      void pump();
    },
    /** Plan changed: drop every row and load the first visible pages. */
    reset(): void {
      gen++;
      pages = new Map();
      fresh = new Set();
      setRev((r) => r + 1);
      void pump();
    },
    /** Same plan, new data: keep rows on screen, re-fetch the visible pages. */
    refresh(): void {
      gen++;
      fresh = new Set();
      void pump();
    },
  };
}

export type ScanController = ReturnType<typeof createScanController>;
