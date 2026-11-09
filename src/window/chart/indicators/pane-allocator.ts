/*
 * The pane numbering of a chart's studies: the price pane (any position), the
 * stacked panes claimed by the studies and pane owners, panes kept empty for a
 * pane owner about to take them, and the renumbering when panes are swapped or
 * removed. IndicatorController places its studies through it.
 */
import type { IChartApi } from 'lightweight-charts';

type Pane = ReturnType<IChartApi['panes']>[number];

/** A study or pane owner as far as its pane goes. */
export type PanedInstance = {
  paneIndex: number;
  /** Drawn in the price pane (over the main series). */
  overlay: boolean;
  /** Pane group of a stacked pane; null in the price pane. */
  group: string | null;
  owner?: { setPaneIndex(i: number): void };
  layer: { setPaneIndex(i: number): void };
};

export class PaneAllocator {
  /** Pane of the main series and of the studies drawn over it. */
  mainPane = 0;
  /** Pane indices currently claimed by a non-overlay study (the price pane is never in it). */
  private used = new Set<number>();
  /** Panes kept (empty) for a pane owner about to take them: a compared symbol over the series stays in the pane
   *  the series left. */
  private reserved = new Map<string, Pane>();

  constructor(
    private readonly chart: IChartApi,
    private readonly instances: ReadonlyMap<string, PanedInstance>,
    /** The price pane moved (renumbered after a swap or a removal). */
    private readonly mainPaneMoved: () => void,
  ) {}

  /** Claim the first free stacked pane. */
  claim(): number {
    let pane = 0;
    while (this.used.has(pane) || pane === this.mainPane) pane++;
    this.used.add(pane);
    return pane;
  }

  /** A pane taken another way (a reserved pane) counts as claimed. */
  markUsed(paneIndex: number): void {
    this.used.add(paneIndex);
  }

  /** The stacked panes claimed now (the price pane is not claimed). */
  resetUsed(): void {
    this.used = new Set([...this.instances.values()].filter((o) => !o.overlay && o.paneIndex !== this.mainPane).map((o) => o.paneIndex));
  }

  /** Move an instance's drawing to pane `i`. */
  setPaneOf(inst: PanedInstance, i: number): void {
    if (inst.owner) inst.owner.setPaneIndex(i);
    else inst.layer.setPaneIndex(i);
  }

  /** Pane group of stacked pane `paneIndex` (the group of a study or pane owner in it), null for the price pane or
   *  none. */
  groupOfPane(paneIndex: number): string | null {
    if (paneIndex === this.mainPane) return null;
    for (const inst of this.instances.values()) if (!inst.overlay && inst.paneIndex === paneIndex && inst.group) return inst.group;
    return null;
  }

  /** Studies and pane owners of stacked pane `paneIndex` (not the ones drawn over the series). */
  idsInPane(paneIndex: number): string[] {
    const out: string[] = [];
    for (const [id, inst] of this.instances) if (!inst.overlay && inst.paneIndex === paneIndex) out.push(id);
    return out;
  }

  /** The series shares its pane with stacked studies (or pane owners). */
  seriesShares(): boolean {
    return [...this.instances.values()].some((i) => !i.overlay && i.paneIndex === this.mainPane);
  }

  /** Swap two panes (pane controls: move up / down; the price pane too). */
  swap(a: number, b: number): void {
    const n = this.chart.panes().length;
    if (a < 0 || b < 0 || a >= n || b >= n || a === b) return;
    this.chart.swapPanes(a, b);
    for (const inst of this.instances.values()) {
      if (inst.paneIndex === a) { inst.paneIndex = b; this.setPaneOf(inst, b); }
      else if (inst.paneIndex === b) { inst.paneIndex = a; this.setPaneOf(inst, a); }
    }
    const moved = this.mainPane === a || this.mainPane === b;
    if (moved) this.mainPane = this.mainPane === a ? b : a;
    this.resetUsed();
    if (moved) this.mainPaneMoved();
  }

  /** Panes were removed since `before` (the chart's panes then): the pane indices after them move up. */
  reindex(before: Pane[]): void {
    const after = new Set(this.chart.panes());
    const removed = before.map((p, i) => (after.has(p) ? -1 : i)).filter((i) => i >= 0);
    if (removed.length) {
      const shift = (i: number) => i - removed.filter((r) => r < i).length;
      for (const other of this.instances.values()) {
        const next = shift(other.paneIndex);
        if (next === other.paneIndex) continue;
        other.paneIndex = next;
        this.setPaneOf(other, next);
      }
      const main = shift(this.mainPane);
      const moved = main !== this.mainPane;
      this.mainPane = main;
      if (moved) this.mainPaneMoved();
    }
    this.resetUsed();
  }

  /** Drop any pane but the price pane that no longer holds a series (the caller renumbers with {@link reindex}). */
  removeEmpty(): void {
    const panes = this.chart.panes();
    for (let i = panes.length - 1; i >= 0; i--) {
      if (i !== this.mainPane && panes[i].getSeries().length === 0) {
        try { this.chart.removePane(i); } catch { /* race with teardown */ }
      }
    }
  }

  /** Remove `pane` (not the price pane) when it holds no series any more, then renumber. */
  private removeIfEmpty(pane: Pane): void {
    const before = this.chart.panes();
    const at = before.indexOf(pane);
    if (at >= 0 && pane.getSeries().length === 0 && at !== this.mainPane) {
      try { this.chart.removePane(at); } catch { /* race with teardown */ }
      this.reindex(before);
    }
  }

  /** Keep pane `pane` (empty) for pane owner `id` (a compared symbol staying in the pane the series left): it takes
   *  it with {@link unreserve}. Not taken soon: the pane goes. */
  reserve(id: string, pane: Pane): void {
    pane.setPreserveEmptyPane(true);
    this.reserved.set(id, pane);
    setTimeout(() => {
      if (this.reserved.get(id) !== pane) return;
      this.reserved.delete(id);
      pane.setPreserveEmptyPane(false);
      this.removeIfEmpty(pane);
    }, 3000);
  }

  /** The pane kept for `id`, no longer kept for it; undefined when none. */
  unreserve(id: string): Pane | undefined {
    const pane = this.reserved.get(id);
    this.reserved.delete(id);
    return pane;
  }
}
