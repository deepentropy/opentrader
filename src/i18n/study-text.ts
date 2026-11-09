/*
 * The text a library study draws on the chart in the interface language (#190): its labels, shape texts, boxes and
 * tables, and its plot names on the price scale. A user's script draws its own text: it stays as written.
 */
import type { IndicatorResult, PlotConfig } from "oakscriptjs";
import { translateDrawn, translating } from "./translator";

type Texted = { text?: string };

/** The list with its text translated; the list itself when none changes. */
function withText<T extends Texted>(items: T[] | undefined): T[] | undefined {
  if (!items?.length) return items;
  let changed = false;
  const out = items.map((i) => {
    const to = i.text ? translateDrawn(i.text) : i.text;
    if (to === i.text) return i;
    changed = true;
    return { ...i, text: to };
  });
  return changed ? out : items;
}

/** The result with its drawn text translated (the result itself in English). */
export function translatedStudyResult<R extends IndicatorResult>(result: R): R {
  if (!translating()) return result;
  return {
    ...result,
    markers: withText(result.markers),
    labels: withText(result.labels),
    boxes: withText(result.boxes),
    tables: result.tables?.map((t) => {
      const cells = withText(t.cells) ?? t.cells;
      return cells === t.cells ? t : { ...t, cells };
    }),
  };
}

/** The plots with their names translated (the price scale's name labels). */
export function translatedPlotConfig<P extends Pick<PlotConfig, "title">>(plots: P[]): P[] {
  if (!translating()) return plots;
  return plots.map((p) => (p.title ? { ...p, title: translateDrawn(p.title) } : p));
}
