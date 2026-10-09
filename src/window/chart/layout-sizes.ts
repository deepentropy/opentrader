/*
 * Multi-chart layout sizes — the split tree of a layout template and the
 * arithmetic of its draggable splitters.
 *
 * A layout is a tree: a node is `["h" | "v", ...children]` ("h" = children
 * side by side, "v" = children stacked), a leaf is a pane index. Each node's
 * children share its box by `percent` (equal shares at start); a nested child
 * carries its own `substate`. A splitter sits on every gap between two
 * children of a node and moves the share between those two.
 *
 * Rules:
 *   - the gap between two charts is `gap` px; the shares apply to the box
 *     minus its gaps, boxes are rounded to whole pixels at every level;
 *   - a splitter is a `SPLITTER_SIZE` px band centred on its gap;
 *   - a drag moves `delta / box length` from one child to the next, each kept
 *     at `MIN_SHARE` or more;
 *   - with Shift, the same splitter of every sibling sub-layout moves too,
 *     after the siblings took the dragged sub-layout's shares.
 */

export type LayoutExpr = number | LayoutNode;
export type LayoutNode = readonly ["h" | "v", ...LayoutExpr[]];

export type SizingNode = { percent: number; substate?: SizingNode[] };
/** Shares of a node's children, in child order. */
export type Sizing = SizingNode[];

export type Rect = { left: number; top: number; width: number; height: number };

export type Splitter = {
  /** Depth of the node the splitter belongs to (0 = the root). */
  level: number;
  /** Orientation of that node: "h" = a vertical bar dragged left / right. */
  orientation: "h" | "v";
  /** Child index at each level down to the splitter (the last one is the
   *  child on the splitter's left / top). */
  indexes: number[];
  rect: Rect;
  /** Same level, same position, same orientation: the splitters Shift moves
   *  together. */
  group: string;
};

export const SPLITTER_SIZE = 12;
export const MIN_SHARE = 0.05;

const isLeaf = (e: LayoutExpr): e is number => typeof e === "number";
const children = (e: LayoutNode) => e.slice(1) as LayoutExpr[];

export function initialSizing(expr: LayoutExpr): Sizing {
  if (isLeaf(expr)) return [];
  const kids = children(expr);
  return kids.map((k) => ({ percent: 1 / kids.length, substate: isLeaf(k) ? undefined : initialSizing(k) }));
}

/** True when `sizing` has the shape of `expr` (a stored state of another
 *  template, or a damaged one, is not used). */
export function sizingFits(expr: LayoutExpr, sizing: unknown): sizing is Sizing {
  if (isLeaf(expr)) return true;
  const kids = children(expr);
  if (!Array.isArray(sizing) || sizing.length !== kids.length) return false;
  return kids.every((k, i) => {
    const s = sizing[i] as SizingNode | undefined;
    if (!s || typeof s.percent !== "number" || !Number.isFinite(s.percent) || s.percent <= 0) return false;
    return isLeaf(k) || sizingFits(k, s.substate);
  });
}

export function cloneSizing(s: Sizing): Sizing {
  return s.map((n) => ({ percent: n.percent, substate: n.substate ? cloneSizing(n.substate) : undefined }));
}

/** Box of child `i` of a node: `before` = sum of the shares in front of it. */
function childRect(box: Rect, i: number, gap: number, before: number, share: number, count: number, orientation: "h" | "v"): Rect {
  const length = orientation === "h" ? box.width : box.height;
  const free = length - gap * (count - 1);
  const start = before * free + i * gap;
  const from = Math.round(start);
  const size = i === count - 1 ? length - from : Math.round(start + share * free) - from;
  return orientation === "h"
    ? { left: box.left + from, top: box.top, width: size, height: box.height }
    : { left: box.left, top: box.top + from, width: box.width, height: size };
}

/** Each child of a node with its box. */
function eachChild(expr: LayoutNode, box: Rect, gap: number, sizing: Sizing, fn: (kid: LayoutExpr, i: number, rect: Rect) => void) {
  const kids = children(expr);
  let before = 0;
  kids.forEach((kid, i) => {
    const share = sizing[i]?.percent ?? 1 / kids.length;
    fn(kid, i, childRect(box, i, gap, before, share, kids.length, expr[0]));
    before += share;
  });
}

/** Pane index -> box. */
export function cellRects(expr: LayoutExpr, box: Rect, gap: number, sizing: Sizing): Rect[] {
  const out: Rect[] = [];
  const walk = (e: LayoutExpr, b: Rect, s: Sizing) => {
    if (isLeaf(e)) {
      out[e] = b;
      return;
    }
    eachChild(e, b, gap, s, (kid, i, rect) => walk(kid, rect, s[i]?.substate ?? []));
  };
  walk(expr, box, sizing);
  return out;
}

export function splitters(expr: LayoutExpr, box: Rect, gap: number, sizing: Sizing): Splitter[] {
  const out: Splitter[] = [];
  const walk = (e: LayoutExpr, b: Rect, s: Sizing, level: number, path: number[]) => {
    if (isLeaf(e)) return;
    const orientation = e[0];
    const count = e.length - 1;
    eachChild(e, b, gap, s, (kid, i, rect) => {
      if (i < count - 1) {
        out.push({
          level,
          orientation,
          indexes: [...path, i],
          rect:
            orientation === "v"
              ? { left: rect.left, top: rect.top + rect.height - SPLITTER_SIZE / 2 + 1, width: rect.width, height: SPLITTER_SIZE }
              : { left: rect.left + rect.width - SPLITTER_SIZE / 2 + 1, top: rect.top, width: SPLITTER_SIZE, height: rect.height },
          group: `${level}-${i}-${orientation}`,
        });
      }
      walk(kid, rect, s[i]?.substate ?? [], level + 1, [...path, i]);
    });
  };
  walk(expr, box, sizing, 0, []);
  return out;
}

/** `sizing` after `splitter` moved by `delta` px. `sizing` is changed in
 *  place: pass a copy of the state the drag started from. `all` (Shift) moves
 *  the same splitter of every sibling sub-layout. */
export function applyResize(expr: LayoutExpr, box: Rect, gap: number, delta: number, splitter: Splitter, sizing: Sizing, all: boolean): Sizing {
  const walk = (e: LayoutExpr, b: Rect, s: Sizing, level: number): Sizing => {
    if (isLeaf(e)) return s;
    if (level < splitter.level) {
      eachChild(e, b, gap, s, (kid, i, rect) => {
        if (isLeaf(kid) || (!all && i !== splitter.indexes[level])) return;
        const node = s[i];
        if (node?.substate) node.substate = walk(kid, rect, node.substate, level + 1);
      });
      return s;
    }
    if (e[0] !== splitter.orientation || s.length < 2) return s;
    const i = Math.min(splitter.indexes[level], s.length - 2);
    const length = e[0] === "v" ? b.height : b.width;
    const moved = delta / length;
    const both = s[i].percent + s[i + 1].percent;
    const clamp = (v: number) => Math.min(both - MIN_SHARE, Math.max(MIN_SHARE, v));
    s[i].percent = clamp(s[i].percent + moved);
    s[i + 1].percent = clamp(s[i + 1].percent - moved);
    return s;
  };
  return walk(expr, box, sizing, 0);
}

/** The Shift start state: every sibling sub-layout of the splitter's node
 *  takes that node's shares. A sibling with more children splits the last
 *  share between the extra ones; one with fewer merges the shares it has no
 *  child for. `sizing` is changed in place. */
export function alignSiblings(expr: LayoutExpr, splitter: Splitter, sizing: Sizing): Sizing {
  let source = sizing;
  for (const i of splitter.indexes.slice(0, -1)) source = source[i]?.substate ?? [];
  const index = splitter.indexes[splitter.level];
  const walk = (e: LayoutExpr, s: Sizing, level: number): Sizing => {
    if (isLeaf(e)) return s;
    if (level < splitter.level) {
      children(e).forEach((kid, i) => {
        const node = s[i];
        if (!isLeaf(kid) && node?.substate) node.substate = walk(kid, node.substate, level + 1);
      });
      return s;
    }
    let from = source.map((n) => n.percent);
    if (from.length < s.length) {
      const extra = s.length - from.length;
      const share = from[from.length - 1] / (extra + 1);
      from[from.length - 1] = share;
      for (let k = 0; k < extra; k++) from.push(share);
    } else if (from.length > s.length) {
      if (index >= s.length - 1) {
        const extra = from.length - s.length;
        for (let k = 0; k < extra; k++) from[extra] += from[k];
        from = from.slice(extra);
      } else {
        for (let k = s.length; k < from.length; k++) from[s.length - 1] += from[k];
        from = from.slice(0, s.length);
      }
    }
    s.forEach((n, k) => (n.percent = from[k]));
    return s;
  };
  return walk(expr, sizing, 0);
}
