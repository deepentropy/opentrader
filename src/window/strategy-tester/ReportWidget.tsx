/*
 * Frame of the report tab charts (the reference app's WidgetLayout 416475,
 * PagedChart 808973, LegendItem 130386, PositionedTooltip 12981 and its
 * detail switcher 849983): a 34 px title row with its actions, the chart
 * area ("Not enough data to show" without data), the paging arrows and the
 * legend; the hover tooltip floats above its anchor.
 */
import { For, Show, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { IChartApi } from "lightweight-charts";
import { Icon } from "../../components/Icon";
import { ChartPager, type PagerParams } from "./report-chart-kit";

export function Widget(props: {
  title: string;
  hasData: boolean;
  actions?: JSX.Element;
  /** Show the actions without data too. */
  alwaysActions?: boolean;
  /** Half the report width beside another widget (from 930 px). */
  half?: boolean;
  /** 8 px under the title instead of 12. */
  smallTitleMargin?: boolean;
  /** Minimum content height, px. */
  minHeight?: number;
  /** Illustration of "Not enough data to show": 72 px, or 120 px on the larger charts (reference app). */
  stubSize?: "small" | "medium";
  contentClass?: string;
  children: JSX.Element;
}) {
  return (
    <div class="st-widget" classList={{ "is-half": props.half }}>
      <div class="st-widget-title" classList={{ "is-small": props.smallTitleMargin }}>
        <span class="st-widget-title-text">{props.title}</span>
        <Show when={props.actions && (props.hasData || props.alwaysActions)}>
          <div class="st-widget-actions">{props.actions}</div>
        </Show>
      </div>
      <div class={`st-widget-content ${props.contentClass ?? ""}`} style={props.minHeight ? { "min-height": `${props.minHeight}px` } : undefined}>
        <Show when={!props.hasData}>
          <div class="st-widget-nodata">
            <div class="st-nodata">
              <NoDataArt size={props.stubSize === "medium" ? 120 : 72} />
              <div class="st-nodata-text">Not enough data to show</div>
            </div>
          </div>
        </Show>
        {props.children}
      </div>
    </div>
  );
}

/** Illustration above "Not enough data to show": an empty chart frame and a
 *  magnifying glass. */
function NoDataArt(props: { size: number }) {
  return (
    <svg class="st-nodata-icon" width={props.size} height={props.size} viewBox="0 0 120 120" aria-hidden="true">
      <rect x="14" y="24" width="76" height="62" rx="6" fill="var(--st-nodata-fill)" stroke="var(--st-nodata-line)" stroke-width="2" />
      <path d="M24 74h56" stroke="var(--st-nodata-line)" stroke-width="2" stroke-dasharray="4 4" />
      <path d="M26 64l12-10 10 6 14-16 12 8" fill="none" stroke="var(--st-nodata-line)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.5" />
      <circle cx="80" cy="78" r="16" fill="var(--st-nodata-bg)" stroke="var(--st-nodata-accent)" stroke-width="3" />
      <path d="M91.5 89.5l12 12" stroke="var(--st-nodata-accent)" stroke-width="5" stroke-linecap="round" />
      <path d="M74 78h12" stroke="var(--st-nodata-accent)" stroke-width="3" stroke-linecap="round" />
    </svg>
  );
}

/** Paging state of a chart: attach the pager once the chart exists, give it the slot count after each data set. */
export function usePager(params: PagerParams) {
  const [showArrows, setShowArrows] = createSignal(false);
  const [canLeft, setCanLeft] = createSignal(false);
  const [canRight, setCanRight] = createSignal(false);
  const [breakpoint, setBreakpoint] = createSignal(-1);
  let pager: ChartPager | null = null;
  onCleanup(() => pager?.destroy());
  return {
    showArrows,
    canLeft,
    canRight,
    breakpoint,
    attach(chart: IChartApi, container: HTMLElement) {
      pager = new ChartPager(chart, container, params, { showArrows: setShowArrows, canPageLeft: setCanLeft, canPageRight: setCanRight, breakpoint: setBreakpoint });
    },
    setItemCount: (n: number) => pager?.setItemCount(n),
    left: () => pager?.pageLeft(),
    right: () => pager?.pageRight(),
  };
}

/** Chart host between the paging arrows (28 x 28, 10 px gaps), shown when the bars do not fit. */
export function PagedChart(props: {
  showArrows: boolean;
  canLeft: boolean;
  canRight: boolean;
  onLeft: () => void;
  onRight: () => void;
  containerRef: (el: HTMLDivElement) => void;
  hostRef: (el: HTMLDivElement) => void;
  class?: string;
  children?: JSX.Element;
}) {
  return (
    <div ref={props.containerRef} class={`st-paged ${props.class ?? ""}`}>
      <Show when={props.showArrows}>
        <button type="button" class="st-page-btn" title="Scroll left" disabled={!props.canLeft} onClick={() => props.onLeft()}>
          <Icon name="st-chart-page-left" size={18} />
        </button>
      </Show>
      <div ref={props.hostRef} class="st-paged-host" classList={{ "is-scrollable": props.showArrows }}>
        {props.children}
      </div>
      <Show when={props.showArrows}>
        <button type="button" class="st-page-btn" title="Scroll right" disabled={!props.canRight} onClick={() => props.onRight()}>
          <Icon name="st-chart-page-right" size={18} />
        </button>
      </Show>
    </div>
  );
}

export type LegendEntry = { label: string; color: string };

export function Legend(props: { items: LegendEntry[]; class?: string }) {
  return (
    <div class={`st-chart-legend ${props.class ?? ""}`}>
      <For each={props.items}>
        {(it) => (
          <div class="st-legend-item">
            <span class="st-legend-dot" style={{ background: it.color }} />
            <span class="st-legend-label">{it.label}</span>
          </div>
        )}
      </For>
    </div>
  );
}

/** Weekly / Quarterly / Yearly ... switch; hidden with a single choice. */
export function DetailSwitch<T extends string>(props: { value: T; options: readonly T[]; label: (v: T) => string; onChange: (v: T) => void }) {
  return (
    <Show when={props.options.length > 1}>
      <div class="st-segmented" role="radiogroup" style={{ "grid-template-columns": `repeat(${props.options.length}, minmax(0, 1fr))` }}>
        <For each={props.options}>
          {(o) => (
            <button type="button" role="radio" class="st-segment" classList={{ "is-checked": o === props.value }} aria-checked={o === props.value} onClick={() => props.onChange(o)}>
              {props.label(o)}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

export type TipRow = {
  title?: string;
  /** Color dot before the title. */
  color?: string;
  value: JSX.Element;
  unit?: string;
  /** Green / red value (undefined: neutral). */
  positive?: boolean;
  leftAlign?: boolean;
  noPadding?: boolean;
};

/** Where a tooltip anchors: x (viewport) of its middle, y (viewport) its bottom sits `offset` px above. */
export type TipAnchor = {
  x: number;
  y: number;
  /** The chart element: the report scroll area holding it bounds the tooltip. */
  el?: Element;
};

/**
 * Hover tooltip of a report chart: centred on x, kept inside the window
 * horizontally; its bottom `offset` px (5) above y, kept under the top of the
 * report's scroll area. The arrow under it is dropped when it is moved.
 */
export function ChartTip(props: { anchor: TipAnchor; rows: TipRow[]; foot?: JSX.Element; title?: string; offset?: number; columns?: number }) {
  let el!: HTMLDivElement;
  // Shift that keeps the rendered tooltip in view, measured after each move.
  const [shift, setShift] = createSignal({ dx: 0, dy: 0 });
  createEffect(
    on(
      () => [props.anchor.x, props.anchor.y, props.rows],
      () => {
        setShift({ dx: 0, dy: 0 });
        requestAnimationFrame(() => {
          if (!el?.isConnected) return;
          const r = el.getBoundingClientRect();
          const dx = r.left < 0 ? -r.left : r.right > window.innerWidth ? window.innerWidth - r.right : 0;
          const top = props.anchor.el?.closest(".st-metrics")?.getBoundingClientRect().top ?? 0;
          setShift({ dx, dy: r.top < top ? top - r.top : 0 });
        });
      },
    ),
  );
  const moved = () => shift().dx !== 0 || shift().dy !== 0;
  return (
    <Portal>
      <div ref={el} class="st-tip" style={{ left: `${props.anchor.x + shift().dx}px`, top: `${props.anchor.y - (props.offset ?? 5) + shift().dy}px` }}>
        <Show when={props.title}>
          <div class="st-tip-title">{props.title}</div>
        </Show>
        <div class="st-tip-rows" classList={{ "has-foot": !!props.foot }} style={{ "grid-template-columns": props.columns === 3 ? "1fr auto auto" : "1fr auto" }}>
          <For each={props.rows}>
            {(r) => (
              <>
                <span class="st-tip-name" classList={{ "no-pad": r.noPadding }}>
                  <Show when={r.color}>
                    <span class="st-tip-dot" style={{ background: r.color }} />
                  </Show>
                  {r.title}
                </span>
                <span class="st-tip-value" classList={{ "is-left": r.leftAlign, "no-pad": r.noPadding, "is-positive": r.positive === true, "is-negative": r.positive === false }}>
                  {r.value}
                  <Show when={r.unit}>
                    <span class="st-tip-unit">{r.unit}</span>
                  </Show>
                </span>
              </>
            )}
          </For>
        </div>
        <Show when={props.foot}>
          <div>{props.foot}</div>
        </Show>
        <Show when={!moved()}>
          <svg class="st-tip-arrow" width="16" height="5" viewBox="0 0 16 5">
            <path d="M.5 5h15L8 0 .5 5Z" fill="currentColor" />
          </svg>
        </Show>
      </div>
    </Portal>
  );
}

/** Tone of a value (undefined at 0), as the tooltips color it. */
export const signOf = (v: number): boolean | undefined => (v === 0 ? undefined : v > 0);
