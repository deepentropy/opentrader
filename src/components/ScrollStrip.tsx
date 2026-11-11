/*
 * ScrollStrip — a toolbar that scrolls when its window is too small for it (#297, #298): no scrollbar, the wheel
 * (a horizontal wheel for a row) and an arrow button at each end that slides in while there is more on that side.
 * A click scrolls a page less the two arrows. The drawing toolbar keeps its arrows shown; the header shows them
 * while the pointer is over it.
 *
 * The strip clips what overflows it: a menu opened from inside it is placed `position: fixed`.
 */
import { createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { inlineSign } from "./reading-direction";

/** The arrows' thickness (their height in a column, their width in a row). */
const ARROW = 24;

type Props = {
  axis: "x" | "y";
  /** The arrows show only while the pointer is over the strip. */
  arrowsOnHover?: boolean;
  class?: string;
  /** Class of the scrolled content (a flex row or column at least as large as the strip). */
  contentClass?: string;
  /** After the strip or its content changed size, with the scrolled element. */
  onResize?: (view: HTMLElement) => void;
  children: JSX.Element;
};

export function ScrollStrip(props: Props) {
  let view!: HTMLDivElement;
  let content!: HTMLDivElement;
  const [canBack, setCanBack] = createSignal(false);
  const [canForward, setCanForward] = createSignal(false);
  const column = () => props.axis === "y";

  const update = () => {
    // Right to left a row scrolls toward negative scrollLeft: the distance from the start is its magnitude.
    const pos = column() ? view.scrollTop : Math.abs(view.scrollLeft);
    const max = column() ? view.scrollHeight - view.clientHeight : view.scrollWidth - view.clientWidth;
    setCanBack(pos > 1);
    setCanForward(pos < max - 1);
  };
  const scroll = (dir: 1 | -1) => {
    const page = Math.max(ARROW, (column() ? view.clientHeight : view.clientWidth) - 2 * ARROW - 2);
    view.scrollBy(column() ? { top: dir * page, behavior: "smooth" } : { left: dir * page * inlineSign(), behavior: "smooth" });
  };

  onMount(() => {
    const observer = new ResizeObserver(() => {
      props.onResize?.(view);
      update();
    });
    observer.observe(view);
    observer.observe(content);
    onCleanup(() => observer.disconnect());
  });

  const arrow = (dir: 1 | -1) => (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      class={`ot-scroll-strip-arrow ${dir < 0 ? "is-back" : "is-forward"}${(dir < 0 ? canBack() : canForward()) ? " is-visible" : ""}`}
      // Keep the focus where it is (an open menu, the chart).
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => scroll(dir)}
    >
      <svg class="ot-scroll-strip-icon" viewBox="0 0 20 10" width="20" height="10">
        <path fill="none" stroke="currentColor" stroke-width="1.5" d="M3 2l7 6 7-6" />
      </svg>
    </button>
  );

  return (
    <div
      class={`ot-scroll-strip is-${props.axis}${props.arrowsOnHover ? " arrows-on-hover" : ""}${props.class ? " " + props.class : ""}`}
    >
      <div ref={view} class="ot-scroll-strip-view" onScroll={update}>
        <div ref={content} class={`ot-scroll-strip-content${props.contentClass ? " " + props.contentClass : ""}`}>
          {props.children}
        </div>
      </div>
      {arrow(-1)}
      {arrow(1)}
    </div>
  );
}
