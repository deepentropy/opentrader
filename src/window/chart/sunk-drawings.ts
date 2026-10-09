/*
 * Drawings painted on the chart canvas, behind a series. A drawing that the
 * drawing order puts behind a source cannot be drawn by the overlay (it is
 * in front of the whole chart): the chart paints it through a series
 * primitive, right in front of the source behind it ("normal": after that
 * series, before the next one) or behind every series of the pane
 * ("bottom").
 */
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

/** Drawings painted with one series of a pane, back to front. */
export type SunkGroup = {
  series: ISeriesApi<SeriesType>;
  /** Behind every series of the pane (else right in front of `series`). */
  bottom: boolean;
  /** Owner key of the pane (null = the price pane). */
  paneKey: string | null;
  ids: string[];
};

export const sameSunkGroups = (a: SunkGroup[], b: SunkGroup[]): boolean =>
  a.length === b.length &&
  a.every((g, i) => g.series === b[i].series && g.bottom === b[i].bottom && g.paneKey === b[i].paneKey && g.ids.join("\n") === b[i].ids.join("\n"));

export class SunkDrawings implements ISeriesPrimitive<Time> {
  private requestUpdate: (() => void) | null = null;
  private readonly views: IPrimitivePaneView[];

  constructor(group: SunkGroup, paint: (ctx: CanvasRenderingContext2D, id: string, paneKey: string | null) => void) {
    const renderer: IPrimitivePaneRenderer = {
      draw: (target) => {
        target.useMediaCoordinateSpace(({ context }) => {
          for (const id of group.ids) paint(context, id, group.paneKey);
        });
      },
    };
    this.views = [{ renderer: () => renderer, zOrder: () => (group.bottom ? "bottom" : "normal") }];
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** A drawing changed: paint again. */
  update(): void {
    this.requestUpdate?.();
  }
}
