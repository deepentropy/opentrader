/*
 * Multi-chart layout templates.
 *
 * The layout-setup menu exposes tile variants whose ids look like
 * `layouts-list-item-<token>`.  The trailing
 * <token> matches the `layout` field of the persisted ChartLayout content
 * blob.
 *
 * Each entry in LAYOUT_SPECS describes the geometry needed to render the
 * template via CSS Grid:
 *   - `cols`/`rows`: grid track counts (drive grid-template-columns/rows
 *     as `repeat(N, 1fr)`).
 *   - `cells`: one entry per chart pane.  When `col`/`row` is set it's
 *     applied as the cell's `gridColumn` / `gridRow` (so spans, manual
 *     positions, and explicit line ranges work).  When omitted, cells flow
 *     in document order via the grid's auto-placement.
 *
 * Geometries were lifted from the in-app menu thumbnails (the SVGs under
 * src/assets/icons/menu-layout-setup-layouts-list-item-*.svg).  Naming
 * conventions:
 *   - `Nh` = N columns × 1 row (horizontal strip).
 *   - `Nv` = 1 column × N rows (vertical strip).
 *   - `Ns` = 1 big left + N-1 stacked right (sidebar).
 *   - `Ns-l` = mirror of `Ns` (N-1 stacked left + 1 big right).
 *   - `a-b` (and `a-b-c…`) = each segment is a row; first row has `a`
 *     panes, second row `b` panes, etc., split into equal columns per
 *     row.  Row heights are equal.
 *   - `NcM` = grid with N total cells in M columns (rest derives rows).
 *   - `2-2`/`2-2-l`/`2-2-r`/`2-3-l`/`2-3-r` = hybrid sidebars (see specs).
 *
 * `expr` is the same geometry as a split tree (see layout-sizes.ts): it
 * places the cells and carries the draggable splitters between them.
 */
import type { LayoutExpr, LayoutNode } from './layout-sizes';

export type CellSpec = {
  /** CSS `gridColumn` value (e.g. "2", "1 / 3", "1 / span 2").  Omit to let
   *  the grid auto-flow this cell. */
  col?: string;
  /** CSS `gridRow` value.  Same rules as `col`. */
  row?: string;
};

export type LayoutSpec = {
  cols: number;
  rows: number;
  cells: CellSpec[];
  /** Split tree over the cell indexes. */
  expr: LayoutExpr;
};

/* `count` cells from `first`, side by side ("h") or stacked ("v"); one cell
 * is the cell itself. */
function strip(dir: 'h' | 'v', first: number, count: number): LayoutExpr {
  if (count === 1) return first;
  return [dir, ...Array.from({ length: count }, (_, i) => first + i)] as LayoutNode;
}

/* Build a uniform grid of `cols × rows`, all cells auto-placed.  When
 * `count` is set it overrides the cell count (e.g. for a sparse grid). */
function grid(cols: number, rows: number, count?: number): LayoutSpec {
  return {
    cols,
    rows,
    cells: Array.from({ length: count ?? cols * rows }, () => ({})),
    expr: rows === 1
      ? strip('h', 0, cols)
      : (['v', ...Array.from({ length: rows }, (_, r) => strip('h', r * cols, cols))] as LayoutNode),
  };
}

/* Sidebar layouts — one full-height column on `side`, the other column
 * split into `stack` equal stacked panes.  Pane count = stack + 1. */
function sidebar(side: 'L' | 'R', stack: number): LayoutSpec {
  const cells: CellSpec[] = [];
  if (side === 'L') {
    cells.push({ col: '1', row: `1 / span ${stack}` });
    for (let i = 1; i <= stack; i++) cells.push({ col: '2', row: `${i}` });
  } else {
    for (let i = 1; i <= stack; i++) cells.push({ col: '1', row: `${i}` });
    cells.push({ col: '2', row: `1 / span ${stack}` });
  }
  const expr: LayoutNode = side === 'L' ? ['h', 0, strip('v', 1, stack)] : ['h', strip('v', 0, stack), stack];
  return { cols: 2, rows: stack, cells, expr };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
function lcm(a: number, b: number): number {
  return (a * b) / gcd(a, b);
}

/* Row-decomposed layouts (`a-b`, `a-b-c`, …).  Each segment is a row of
 * equal-width panes; the grid uses LCM of segment widths so every pane is
 * an integer span.  Row heights are equal. */
function rowSplit(...rowCounts: number[]): LayoutSpec {
  const cols = rowCounts.reduce((acc, n) => lcm(acc, n), 1);
  const cells: CellSpec[] = [];
  rowCounts.forEach((n, rIdx) => {
    const span = cols / n;
    for (let i = 0; i < n; i++) {
      cells.push({
        col: `${i * span + 1} / span ${span}`,
        row: `${rIdx + 1}`,
      });
    }
  });
  let first = 0;
  const expr = ['v', ...rowCounts.map((n) => {
    const row = strip('h', first, n);
    first += n;
    return row;
  })] as LayoutNode;
  return { cols, rows: rowCounts.length, cells, expr };
}

/* The 55 templates exposed by the layout-setup dropdown. */
export const LAYOUT_SPECS = {
  // Single pane.
  's': grid(1, 1),

  // 2-pane.
  '2h': grid(2, 1),
  '2v': grid(1, 2),

  // 3-pane.
  '3h': grid(3, 1),
  '3v': grid(1, 3),
  '3s': sidebar('L', 2),
  '3r': sidebar('R', 2),
  '2-1': rowSplit(2, 1),
  '1-2': rowSplit(1, 2),

  // 4-pane.
  '4': grid(2, 2),
  '4v': grid(1, 4),
  '4h': grid(4, 1),
  '4s': sidebar('L', 3),
  '4s-l': sidebar('R', 3),
  '1-3': rowSplit(1, 3),
  '3-1': rowSplit(3, 1),
  // 2-2: 2 cols on a half-height top row, then two stacked full-width rows.
  '2-2': {
    cols: 2,
    rows: 4,
    cells: [
      { col: '1', row: '1 / span 2' },
      { col: '2', row: '1 / span 2' },
      { col: '1 / span 2', row: '3' },
      { col: '1 / span 2', row: '4' },
    ],
    expr: ['v', ['h', 0, 1], ['v', 2, 3]],
  },
  // 2-2-l: 2 full-height left cols + 2 stacked right cells.
  '2-2-l': {
    cols: 3,
    rows: 2,
    cells: [
      { col: '1', row: '1 / span 2' },
      { col: '2', row: '1 / span 2' },
      { col: '3', row: '1' },
      { col: '3', row: '2' },
    ],
    expr: ['h', 0, 1, ['v', 2, 3]],
  },
  // 2-2-r: mirror of 2-2-l.
  '2-2-r': {
    cols: 3,
    rows: 2,
    cells: [
      { col: '1', row: '1' },
      { col: '1', row: '2' },
      { col: '2', row: '1 / span 2' },
      { col: '3', row: '1 / span 2' },
    ],
    expr: ['h', ['v', 0, 1], 2, 3],
  },

  // 5-pane.
  '1-4': rowSplit(1, 4),
  '5h': grid(5, 1),
  '5v': grid(1, 5),
  '5s': sidebar('L', 4),
  '5s-l': sidebar('R', 4),
  '2-3': rowSplit(2, 3),
  '3-2': rowSplit(3, 2),
  '4-1': rowSplit(4, 1),
  // 2-3-l: 2 full-height left cols + 3 stacked right cells.
  '2-3-l': {
    cols: 3,
    rows: 3,
    cells: [
      { col: '1', row: '1 / span 3' },
      { col: '2', row: '1 / span 3' },
      { col: '3', row: '1' },
      { col: '3', row: '2' },
      { col: '3', row: '3' },
    ],
    expr: ['h', 0, 1, ['v', 2, 3, 4]],
  },
  '2-3-r': {
    cols: 3,
    rows: 3,
    cells: [
      { col: '1', row: '1' },
      { col: '1', row: '2' },
      { col: '1', row: '3' },
      { col: '2', row: '1 / span 3' },
      { col: '3', row: '1 / span 3' },
    ],
    expr: ['h', ['v', 0, 1, 2], 3, 4],
  },

  // 6-pane.
  '6': grid(3, 2),
  '6h': grid(6, 1),
  '6v': grid(1, 6),
  '6c': grid(2, 3),
  '2-4': rowSplit(2, 4),
  '4-2': rowSplit(4, 2),

  // 7-pane.
  '4-3': rowSplit(4, 3),
  '7h': grid(7, 1),
  '7s': sidebar('L', 6),

  // 8-pane.
  '8': grid(4, 2),
  '8c': grid(2, 4),
  '8h': grid(8, 1),
  '8v': grid(1, 8),

  // 9-pane.
  '9s': grid(3, 3),
  '5-4': rowSplit(5, 4),
  '9h': grid(9, 1),
  '9v': grid(1, 9),

  // 10-pane.
  '10c5': grid(5, 2),
  '10h': grid(10, 1),
  '10v': grid(1, 10),

  // 12-pane.
  '12c6': grid(6, 2),
  '12c4': grid(4, 3),
  '12h': grid(12, 1),

  // 14-pane.
  '14c7': grid(7, 2),

  // 16-pane.
  '16c8': grid(8, 2),
  '16c4': grid(4, 4),
} as const satisfies Record<string, LayoutSpec>;

export type LayoutId = keyof typeof LAYOUT_SPECS;

export const DEFAULT_LAYOUT: LayoutId = 's';

const ALL_LAYOUT_IDS = new Set<string>(Object.keys(LAYOUT_SPECS));

/** Number of chart panes the template renders. */
export function paneCount(id: LayoutId): number {
  return LAYOUT_SPECS[id].cells.length;
}

/* Translate the menu's variant id (`layouts-list-item-<token>`) to the
 * layout token used as the LAYOUT_SPECS key.  Unknown tokens fall back to
 * the default single-pane layout — keeps the menu responsive even if a new
 * variant ships before this map is updated. */
export function layoutFromVariantId(variantId: string): LayoutId {
  const m = /^layouts-list-item-(.+)$/.exec(variantId);
  if (!m) return DEFAULT_LAYOUT;
  const token = m[1];
  return ALL_LAYOUT_IDS.has(token) ? (token as LayoutId) : DEFAULT_LAYOUT;
}

/** Inverse — the variant id that should appear selected for a given layout.
 *  Used by the menu to highlight the active template tile. */
export function variantIdForLayout(layout: LayoutId): string {
  return `layouts-list-item-${layout}`;
}

/* Icon name shown on the header toolbar's layout-setup button, swapped to
 * match the active layout (with layout="3s" the button renders
 * menu-layout-setup-layouts-list-item-3s.svg).
 *
 * Most variants use a per-id variant icon; the two exceptions ride on the
 * parent group icon because they have no variant-specific SVG:
 *   - 's'   → menu-layout-setup-1
 *   - '14c7' → menu-layout-setup-14
 */
export function iconNameForLayout(layout: LayoutId): string {
  if (layout === 's') return 'menu-layout-setup-1';
  if (layout === '14c7') return 'menu-layout-setup-14';
  return `menu-layout-setup-layouts-list-item-${layout}`;
}
