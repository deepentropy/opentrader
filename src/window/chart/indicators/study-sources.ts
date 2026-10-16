/*
 * Study on study: a study's source input can name an output of another
 * source of the chart (a study's plot, a compared symbol).
 *
 * Reference rules (its study metainfo and inputs tab, read from its code):
 *   - the value is "<source id>$<plot index>"; a study added on a source
 *     ("Add indicator/strategy on …") takes "<source id>$0" in its first
 *     source input, and a study with no source input cannot be added on a
 *     source ("Can't apply this indicator");
 *   - a study can be a source when it is not a strategy and has plots; every
 *     plot is offered;
 *   - a study's Source list = the price sources, then the plots of the other
 *     sources of the chart, its own descendants left out, named
 *     "<short title>: <plot title>" ("<short title>" alone for a single plot);
 *   - removing a source removes the studies built on it.
 */
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import { isStrategyId } from "./strategy-entries";

/** Reference to output `plot` of source `id`. */
export function sourceRef(id: string, plot = 0): string {
  return `${id}$${plot}`;
}

/** Source id and plot index of a source input value, null for a price source. */
export function parseSourceRef(v: unknown): { id: string; plot: number } | null {
  if (typeof v !== "string") return null;
  const at = v.lastIndexOf("$");
  if (at <= 0) return null;
  const plot = Number(v.slice(at + 1));
  return Number.isInteger(plot) && plot >= 0 ? { id: v.slice(0, at), plot } : null;
}

/** Ids of the source inputs of a study. */
export function sourceInputIds(entry: IndicatorRegistryEntry): string[] {
  return (entry.inputConfig ?? []).filter((c) => c.type === "source").map((c) => c.id);
}

/** Sources a study reads (its source inputs naming other sources). */
export function parentsOf(entry: IndicatorRegistryEntry, inputs: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const id of sourceInputIds(entry)) {
    const r = parseSourceRef(inputs[id]);
    if (r && !out.includes(r.id)) out.push(r.id);
  }
  return out;
}

/** A study can be the source of another: not a strategy, with plots. */
export function canHaveChildren(id: string, entry: IndicatorRegistryEntry | undefined): boolean {
  return !!entry && !isStrategyId(id) && (entry.plotConfig?.length ?? 0) > 0;
}

/** Source choices of a study's plots: "<title>: <plot title>", or the title alone for one plot. */
export function plotChoices(id: string, title: string, entry: IndicatorRegistryEntry): { value: string; label: string }[] {
  const plots = entry.plotConfig ?? [];
  if (plots.length === 1) return [{ value: sourceRef(id, 0), label: title }];
  return plots.map((p, i) => ({ value: sourceRef(id, i), label: `${title}: ${p.title || p.id}` }));
}

/** Values of points `{ time, value }` at the times of `bars` (NaN where there is none). */
export function alignToBars(points: ReadonlyArray<{ time: unknown; value?: number | null }> | undefined, bars: ReadonlyArray<{ time: unknown }>): number[] {
  const byTime = new Map<number, number>();
  for (const p of points ?? []) {
    const v = p.value;
    if (typeof v === "number") byTime.set(p.time as number, v);
  }
  return bars.map((b) => byTime.get(b.time as number) ?? NaN);
}

/** `ids` and every study of a chart built on them (directly or through others), from the saved chart: the
 *  studies' inputs are their defaults with the saved ones over them. */
export function withDescendants(
  indicators: readonly string[],
  settings: Record<string, { inputs?: Record<string, unknown> } | undefined> | undefined,
  ids: readonly string[],
  entryOf: (id: string) => IndicatorRegistryEntry | undefined,
): string[] {
  const out = [...ids];
  for (let grew = true; grew; ) {
    grew = false;
    for (const sid of indicators) {
      if (out.includes(sid)) continue;
      const e = entryOf(sid);
      if (!e) continue;
      const inputs = { ...e.defaultInputs, ...settings?.[sid]?.inputs };
      if (parentsOf(e, inputs).some((p) => out.includes(p))) {
        out.push(sid);
        grew = true;
      }
    }
  }
  return out;
}

/** Key of the sources' description in a study's inputs given to an alert (the alert engine calculates them first;
 *  reference: an alert on a study keeps its parent sources and the plot each source input reads). */
export const SOURCES_KEY = "__sources";

/** What a source input value names: another study (its inputs, sources included, and plot) or a compared symbol
 *  (its price source); `label` = its name in the Source list. */
export type SourceSpec = {
  label: string;
  study?: { id: string; inputs: Record<string, unknown>; plot: number };
  symbol?: { symbol: string; source: string };
};

/** The sources' description in a study's inputs, or null. */
export function sourceSpecsOf(inputs: unknown): Record<string, SourceSpec> | null {
  if (!inputs || typeof inputs !== "object") return null;
  const v = (inputs as Record<string, unknown>)[SOURCES_KEY];
  return v && typeof v === "object" ? (v as Record<string, SourceSpec>) : null;
}
