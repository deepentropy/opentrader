/*
 * The price scales of a chart's studies (scale-layout.ts keys): which scale a
 * study is on by the reference rules or its pin, the scale a stacked pane
 * shows, and the defaults of a new study pane's scales. IndicatorController
 * asks it where to draw a study.
 */
import { PriceScaleMode, type IChartApi } from 'lightweight-charts';
import { getIndicatorEntry } from './registry';
import type { IndicatorHost } from './indicator-controller';
import type { PaneAllocator, PanedInstance } from './pane-allocator';
import type { IndicatorOptions, StudyScale } from './indicator-options';
import { isScaleKey, type ScaleKey, type ScaleUse } from '../scales/scale-layout';

/** A study or pane owner as far as its scale goes. */
type ScaledInstance = PanedInstance & { owner?: unknown };

export class StudyScales {
  /** Panes whose scales were given their defaults. */
  private defaultsSet = new WeakSet<HTMLElement>();

  constructor(
    private readonly chart: IChartApi,
    private readonly host: Pick<IndicatorHost, 'scaleIds' | 'scaleResolve'>,
    private readonly instances: ReadonlyMap<string, ScaledInstance>,
    private readonly options: ReadonlyMap<string, IndicatorOptions>,
    private readonly panes: PaneAllocator,
  ) {}

  /** A study pane's scales start regular and upright (reference: a percent / log / inverted price scale stays on the
   *  price pane). The library merges the options of a pane's left / right scale into the chart-wide ones that new
   *  panes start from, so they are set once per pane; a mode set later on the pane's own scale is kept. */
  paneDefaults(paneIndex: number): void {
    if (paneIndex === this.panes.mainPane) return;
    const el = this.chart.panes()[paneIndex]?.getHTMLElement();
    if (!el || this.defaultsSet.has(el)) return;
    this.defaultsSet.add(el);
    for (const side of ['left', 'right'] as const) {
      try {
        this.chart.priceScale(side, paneIndex).applyOptions({ mode: PriceScaleMode.Normal, invertScale: false });
      } catch {
        /* pane gone (teardown) */
      }
    }
  }

  /** Scale of a study other than its default one (the main series' scale
   *  over the series, the pane's scale in a study pane): the chart library
   *  id of the scale it is on, `axis` false for a hidden scale of its own (no
   *  scale). Null = the default scale. */
  detached(id: string, inst: ScaledInstance): { id: string; axis: boolean } | null {
    const key = this.keyOf(id);
    if (key === null || key === 'own') return null;
    if (key === 'none') return { id: `src:${id}`, axis: false };
    const ids = this.host.scaleIds();
    const def = inst.overlay ? ids.price : ids.pane;
    const r = this.host.scaleResolve(id, inst.paneIndex, key);
    if (!r) return { id: `src:${id}`, axis: false };
    if (r.key === def && r.lib === def) return null;
    return { id: r.lib, axis: true };
  }

  /** Scale key of a study (scale-layout.ts): its pinned scale ("Pin to
   *  scale"), else the reference rules: a price study over the series takes
   *  the series' scale, another study there a new scale; in a stacked pane the
   *  study the pane was made for takes the pane's scale, a price study joins
   *  it when it shows prices, another study takes a new scale. "own" = the
   *  study's own hidden scale (Volume), "none" = no scale, "new" = a new scale
   *  to give it. Null when it is not a study of the chart. */
  keyOf(id: string): ScaleKey | 'new' | 'none' | 'own' | null {
    const inst = this.instances.get(id);
    const entry = getIndicatorEntry(id);
    if (!inst || inst.owner || !entry) return null;
    const pinned = this.options.get(id)?.scale;
    if (pinned === 'none') return 'none';
    if (pinned && isScaleKey(pinned)) return pinned;
    if ((entry.metadata as { ownScaleId?: string }).ownScaleId) return 'own';
    const ids = this.host.scaleIds();
    if (inst.overlay) return entry.overlay ? ids.price : 'new';
    const lead = this.groupLead(inst.group);
    if (lead === id) return ids.pane;
    if (entry.overlay && lead !== null && this.leadsPriceScale(lead)) {
      const k = this.instances.get(lead)?.owner ? ids.pane : this.keyOf(lead);
      return k !== null && isScaleKey(k) ? k : ids.pane;
    }
    return 'new';
  }

  /** The studies on a side scale (scale layout input). */
  uses(): ScaleUse[] {
    const out: ScaleUse[] = [];
    for (const [id, inst] of this.instances) {
      const key = this.keyOf(id);
      if (key === null || key === 'own' || key === 'none') continue;
      out.push({ source: id, pane: inst.paneIndex, key });
    }
    return out;
  }

  /** Scale a study is on: the key of a scale of its pane, or none (a hidden
   *  scale of its own: Volume, a study with no room for a scale). Null when it
   *  is not on the chart. */
  scaleOf(id: string): StudyScale | null {
    const key = this.keyOf(id);
    const inst = this.instances.get(id);
    if (key === null || !inst) return null;
    if (key === 'own' || key === 'none') return 'none';
    return this.host.scaleResolve(id, inst.paneIndex, key)?.key ?? 'none';
  }

  /** The series shares a study pane whose scale shows prices: it takes that
   *  scale (reference: the first price scale of the pane), else a scale of
   *  its own on the free side. */
  seriesSharesPriceScale(): boolean {
    const lead = [...this.instances].find(([, i]) => !i.overlay && i.paneIndex === this.panes.mainPane);
    if (!lead) return false;
    const id = this.groupLead(lead[1].group);
    return id !== null && this.leadsPriceScale(id);
  }

  /** The study (or pane owner) whose scale is the scale of the stacked pane of
   *  `group`: the one the group was made for, else the first member. */
  private groupLead(group: string | null): string | null {
    const members = [...this.instances].filter(([, i]) => !i.overlay && i.group === group).map(([mid]) => mid);
    return members.includes(group ?? "") ? group : members[0] ?? null;
  }

  /** The pane scale led by `id` shows prices: a price study (drawn over the
   *  series by default) or a compared symbol. */
  private leadsPriceScale(id: string): boolean {
    const inst = this.instances.get(id);
    if (!inst) return false;
    if (inst.owner) return true;
    return !!getIndicatorEntry(id)?.overlay;
  }
}
