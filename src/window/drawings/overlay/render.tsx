/*
 * Render dispatch of the drawings overlay: one drawing as SVG (core scene, or
 * the text / table / image components), its anchors (per-drawing anchor
 * context) and the padlocks of a locked selection.
 */
import { createContext, For, Show, useContext } from "solid-js";
import type { Coords } from "../coords";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { HANDLE_RADIUS, HIT_TOLERANCE, type Pt } from "lightweight-charts-drawing/core/_shared";
import { sceneImage, sceneTable, sceneTextTool } from "lightweight-charts-drawing/core/scene/text-tools";
import { sceneSvg } from "../scene-svg";
import { sceneLockedAnchors, sceneOf } from "lightweight-charts-drawing/core/scene";
import { anchorCursor } from "lightweight-charts-drawing/core/interact/drag";
import { tableAnchors, tableHitCell, tableLayout, type TableLayout } from "lightweight-charts-drawing/core/kinds/table";
import { setTableUi, tableUi } from "../table-ui";
import { imagesVersion } from "../image-store";

/** ---------- render dispatch ---------- */

/** Draws one drawing: the core scene (lightweight-charts-drawing
 *  scene/index sceneOf) as SVG. Text, table and image stay components (they
 *  read OpenTrader signals: anchor context, table UI, image cache). Exported
 *  for the port's golden render check. */
export function renderKind(
  d: Drawing,
  pts: Pt[],
  selected: boolean,
  w: number,
  h: number,
  coords: Coords | null,
  hovered = false,
  /** Painted on the chart canvas: only the anchors show here. */
  ghost = false,
): import("solid-js").JSX.Element {
  switch (d.kind) {
    case "text":
      return <TextToolView d={d} p={pts[0]} hovered={hovered} ghost={ghost} />;
    case "table":
      return <TableView d={d} p={pts[0]} active={selected} />;
    case "image":
      return <ImageView d={d} p={pts[0]} active={selected} />;
  }
  return sceneSvg(sceneOf(d, pts, { w, h, coords, selected, hovered }), Handles, d.style.color, ghost);
}

/** Anchor colour (ot-blue-600), the same for every drawing whatever its line
 *  colour. */
const ANCHOR_COLOR = "#1e53e5";

/** Per-drawing anchor context: chart background at a y, and whether the owner
 *  drawing is selected (the ring is thicker for a selected drawing). */
export const AnchorCtx = createContext<{ fillAt: (y: number) => string; selected: () => boolean }>({
  fillAt: () => "#0f0f0f",
  selected: () => true,
});

/** Line anchors: radius 6, ring in ot-blue-600 drawn inside the radius with
 *  stroke 1 (+1 when the drawing is selected), filled with
 *  the chart background at the anchor's height. The hovered anchor adds a 3px
 *  ring (RegularSelectedStrokeWidth) at 20% alpha just outside. `color` (the
 *  drawing colour) is no longer used for anchors. */
function Handles(props: { pts: Pt[]; color: string; squares?: readonly number[] }) {
  const ctx = useContext(AnchorCtx);
  const sw = () => (ctx.selected() ? 2 : 1);
  return (
    <For each={props.pts}>
      {(p, i) => {
        // One-axis anchors (`square: true`) are rounded squares: side
        // 2·radius − stroke, corner radius 3; hover ring side 2·radius + 3.
        const square = () => !!props.squares?.includes(i());
        return (
          <g class="drawing-handle" style={{ cursor: anchorCursor(p, props.pts) }}>
            {/* hovered-anchor ring (20%-alpha halo) — shown via CSS :hover */}
            <Show
              when={square()}
              fallback={<circle class="drawing-handle-ring" cx={p.x} cy={p.y} r={HANDLE_RADIUS + 1.5} fill="none" stroke={ANCHOR_COLOR} stroke-opacity={0.2} stroke-width={3} pointer-events="none" />}
            >
              <rect class="drawing-handle-ring" x={p.x - HANDLE_RADIUS - 1.5} y={p.y - HANDLE_RADIUS - 1.5} width={2 * HANDLE_RADIUS + 3} height={2 * HANDLE_RADIUS + 3} rx={4.5} fill="none" stroke={ANCHOR_COLOR} stroke-opacity={0.2} stroke-width={3} pointer-events="none" />
            </Show>
            <Show
              when={square()}
              fallback={<circle cx={p.x} cy={p.y} r={HANDLE_RADIUS - sw() / 2} fill={ctx.fillAt(p.y)} stroke={ANCHOR_COLOR} stroke-width={sw()} />}
            >
              <rect x={p.x - HANDLE_RADIUS + sw() / 2} y={p.y - HANDLE_RADIUS + sw() / 2} width={2 * HANDLE_RADIUS - sw()} height={2 * HANDLE_RADIUS - sw()} rx={3} fill={ctx.fillAt(p.y)} stroke={ANCHOR_COLOR} stroke-width={sw()} />
            </Show>
          </g>
        );
      }}
    </For>
  );
}

/** Locked-selection anchors: padlocks on the anchor points in place of
 *  the grab handles (core sceneLockedAnchors); no resize cursors — the body
 *  keeps `default`. */
export function renderLockedAnchors(pts: Pt[], color: string) {
  return sceneSvg(sceneLockedAnchors(pts, color), Handles, color);
}

/** Table (scene/text-tools sceneTable) with the host's interaction: the
 *  hovered resize edge (active edge from the last hit test, selected only)
 *  and its cursor. */
function TableView(props: { d: Drawing; p: Pt; active: boolean }) {
  const ctx = useContext(AnchorCtx);
  const l = (): TableLayout => tableLayout(props.d, props.p);
  const ui = () => {
    const u = tableUi();
    return u && u.id === props.d.id && ctx.selected() ? u : null;
  };
  const edgeCursor = () => {
    const e = ui()?.edge;
    if (!e) return undefined;
    return e.col != null && e.row != null ? "default" : e.col != null ? "ew-resize" : "ns-resize";
  };
  const onMove = (e: PointerEvent) => {
    const id = props.d.id;
    const svgEl = (e.currentTarget as SVGElement).ownerSVGElement;
    let edge = null as ReturnType<typeof edgeOf>;
    if (svgEl && ctx.selected()) {
      const r = svgEl.getBoundingClientRect();
      const cur = { x: e.clientX - r.left, y: e.clientY - r.top };
      const onAnchor = tableAnchors(l()).some((q) => Math.hypot(q.x - cur.x, q.y - cur.y) <= HANDLE_RADIUS + HIT_TOLERANCE);
      edge = onAnchor ? null : edgeOf(tableHitCell(l(), cur, true));
    }
    setEdge(id, edge);
  };
  return (
    <g style={{ cursor: edgeCursor() }} onPointerMove={onMove} onPointerLeave={() => setEdge(props.d.id, null)}>
      {sceneSvg(sceneTable(props.d, props.p, props.active, ui()), Handles, props.d.style.color)}
    </g>
  );
}
function edgeOf(h: ReturnType<typeof tableHitCell>) {
  return h && "edge" in h ? h.edge : null;
}
function setEdge(id: string, edge: ReturnType<typeof edgeOf>) {
  const u = tableUi();
  const cur = u && u.id === id ? u.edge : null;
  if ((cur?.row ?? -1) === (edge?.row ?? -1) && (cur?.col ?? -1) === (edge?.col ?? -1)) return;
  setTableUi(u && u.id === id ? { ...u, edge } : { id, cell: null, editing: false, edge });
}

function ImageView(props: { d: Drawing; p: Pt; active: boolean }) {
  return (
    <>
      {(() => {
        void imagesVersion();
        return sceneSvg(sceneImage(props.d, props.p, props.active), Handles, props.d.style.color);
      })()}
    </>
  );
}

function TextToolView(props: { d: Drawing; p: Pt; hovered: boolean; ghost?: boolean }) {
  const ctx = useContext(AnchorCtx);
  return <>{sceneSvg(sceneTextTool(props.d, props.p, ctx.selected(), props.hovered), Handles, props.d.style.color, props.ghost)}</>;
}
