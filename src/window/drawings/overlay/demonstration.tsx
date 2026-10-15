/*
 * Demonstration cursor of the drawings overlay: the circle under the pointer
 * and the "Hold Alt for temporary drawing" highlighter strokes that fade out
 * after release.
 */
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { defaultStyleFor } from "lightweight-charts-drawing/core/specs";
import type { DataPoint, Drawing } from "lightweight-charts-drawing/core/types";
import type { Pt } from "lightweight-charts-drawing/core/_shared";
import { projectAll, unproject } from "lightweight-charts-drawing/core/interact/project";
import {
  DEMO_CURSOR_BORDER_OPACITY,
  HIGHLIGHTER_COLOR,
  HIGHLIGHTER_FADE_MS,
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_WIDTH,
} from "../cursors";
import { eventPoint } from "./helpers";
import { renderKind } from "./render";
import { type OverlayCx } from "./context";

/** What createDemonstration adds to the overlay context. */
export interface DemonstrationApi {
  demoCursor: Accessor<Pt | null>;
  demoCursorElement: () => import("solid-js").JSX.Element;
  highlighterElement: () => import("solid-js").JSX.Element;
  startHighlighter: (e: PointerEvent) => void;
}

export function createDemonstration(cx: OverlayCx): DemonstrationApi {
  const { cmode, props } = cx;
  // Demonstration cursor (crosshair demonstration view): a circle under the
  // pointer on the pane it is over (screen px), or null.
  const [demoCursor, setDemoCursor] = createSignal<Pt | null>(null);
  // "Hold Alt for temporary drawing" (demonstration cursor, Alt-only mouse
  // down): a presentation highlighter — a brush stroke, 36 px, ripe-red-500
  // at 25 %, opaque while drawn, then fading linearly over 4000 ms after
  // release and removed. Data points, so it follows pan / zoom. Not a
  // drawing: never saved, no undo.
  type Highlighter = { id: number; points: DataPoint[]; finishedAt: number | null };
  const [highlighters, setHighlighters] = createSignal<Highlighter[]>([]);
  const [fadeClock, setFadeClock] = createSignal(0);
  let highlighterSeq = 0;

  // Highlighter fade: an animation-frame clock runs while a finished stroke is
  // fading; strokes past the 4 s fade are dropped.
  createEffect(() => {
    if (!highlighters().some((h) => h.finishedAt !== null)) return;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      setFadeClock(now);
      const cur = highlighters();
      const kept = cur.filter((h) => h.finishedAt === null || now - h.finishedAt < HIGHLIGHTER_FADE_MS);
      if (kept.length !== cur.length) setHighlighters(kept);
      if (kept.some((h) => h.finishedAt !== null)) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  /** Alt + press in demonstration mode: draw a highlighter until release. */
  function startHighlighter(e: PointerEvent) {
    const c = props.coords;
    if (!c) return;
    const first = unproject(c, eventPoint(cx.svg, e));
    if (!first) return;
    const id = ++highlighterSeq;
    setHighlighters((hs) => [...hs, { id, points: [first], finishedAt: null }]);
    const onDocMove = (ev: PointerEvent) => {
      const cc = props.coords;
      const dp = cc ? unproject(cc, eventPoint(cx.svg, ev)) : null;
      if (!dp) return;
      setHighlighters((hs) => hs.map((h) => (h.id === id ? { ...h, points: [...h.points, dp] } : h)));
    };
    const onDocUp = () => {
      document.removeEventListener("pointermove", onDocMove);
      document.removeEventListener("pointerup", onDocUp);
      const t = performance.now();
      setHighlighters((hs) => hs.map((h) => (h.id === id ? { ...h, finishedAt: t } : h)));
    };
    document.addEventListener("pointermove", onDocMove);
    document.addEventListener("pointerup", onDocUp);
  }

  // Demonstration mode: the pane keeps its crosshair, pan and selection (the
  // overlay does not capture it); the circle follows the pointer and an
  // Alt-only left press draws a highlighter instead (handled on the pane mouse
  // down, before hit tests / scrolling). Listened on the pane
  // root in the capture phase so the press never reaches the chart.
  createEffect(() => {
    if (cmode() !== "demonstration" || props.armedTool) {
      setDemoCursor(null);
      return;
    }
    const root = cx.svg?.parentElement;
    if (!root) return;
    const onMovePt = (e: PointerEvent) => {
      const p = eventPoint(cx.svg, e);
      const { w, h } = cx.chartDims();
      setDemoCursor(p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h ? p : null);
    };
    const onLeave = () => setDemoCursor(null);
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
      const p = eventPoint(cx.svg, e);
      const { w, h } = cx.chartDims();
      if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) return;
      e.preventDefault();
      e.stopPropagation();
      startHighlighter(e);
    };
    root.addEventListener("pointermove", onMovePt, true);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("pointerdown", onDown, true);
    onCleanup(() => {
      root.removeEventListener("pointermove", onMovePt, true);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointerdown", onDown, true);
    });
  });

  /** Demonstration highlighters (Alt + draw): the brush renderer (smoothed
   *  the same way), faded by the time since release. */
  function highlighterElement(): import("solid-js").JSX.Element {
    const hs = highlighters();
    const c = props.coords;
    if (hs.length === 0 || !c) return null;
    void props.coordEpoch; // re-project on pan / zoom
    const now = fadeClock();
    const { w, h } = cx.chartDims();
    const style = { ...defaultStyleFor("brush"), color: HIGHLIGHTER_COLOR, width: HIGHLIGHTER_WIDTH, fillBackground: false };
    return (
      <g pointer-events="none" clip-path={`url(#${cx.paneClipId}-all)`}>
        {hs.map((hl) => {
          const pts = projectAll(c, hl.points);
          if (!pts || pts.length < 2) return null;
          const progress = hl.finishedAt === null ? 0 : Math.min(1, Math.max(0, (now - hl.finishedAt) / HIGHLIGHTER_FADE_MS));
          const d = { id: `__highlighter_${hl.id}__`, kind: "brush", points: hl.points, style } as Drawing;
          return <g opacity={HIGHLIGHTER_OPACITY * (1 - progress)}>{renderKind(d, pts, false, w, h, c)}</g>;
        })}
      </g>
    );
  }

  /** Demonstration cursor: circle of radius LineWidth / 2 = 18 at
   *  the pointer, filled ripe-red-500 at 25 %, 1 px border at 3 %. */
  function demoCursorElement(): import("solid-js").JSX.Element {
    const p = demoCursor();
    if (!p) return null;
    return (
      <circle
        cx={p.x}
        cy={p.y}
        r={HIGHLIGHTER_WIDTH / 2}
        fill={HIGHLIGHTER_COLOR}
        fill-opacity={HIGHLIGHTER_OPACITY}
        stroke={HIGHLIGHTER_COLOR}
        stroke-opacity={DEMO_CURSOR_BORDER_OPACITY}
        stroke-width={1}
        pointer-events="none"
      />
    );
  }

  return { demoCursor, demoCursorElement, highlighterElement, startHighlighter };
}
