/*
 * Price scales of a chart: several scales per side and per pane.
 *
 * Reference rules (its price scale model, read from its code):
 *   - a pane holds at most 8 scales (left + right); a source that would need a
 *     ninth one gets no scale;
 *   - each side keeps an ordered list; index 0 is next to the chart, the
 *     others go outwards; an emptied scale is removed and the next ones move in;
 *   - a new scale goes to the end of a side: "Auto" placement = the side with
 *     fewer scales (left when left < right, else right), "Stack on the left /
 *     right" = that side;
 *   - scales are named by their index, right A, B, C... H, left Z, Y, X... S;
 *     names show once the chart has two scales or more (largest pane count per
 *     side, summed);
 *   - every pane reserves the chart's largest count of scales per side, each
 *     index as wide as its widest pane.
 *
 * Here a scale is named by a key stored with its sources: "left" / "right" (the
 * first scale made on that side) or "left#<n>" / "right#<n>" (later ones, n
 * grows). Sources pinned to one scale share its key. A pane's keys of one side,
 * sorted by n, give its scale list; the chart library draws index 0 as its side
 * scale ("left" / "right") and index i > 0 on an overlay scale "<side>#<i>"
 * whose axis this app paints next to it (extra-axes.ts).
 */

export type Side = "left" | "right";
export type ScaleKey = string;
/** Scales placement (Settings > Scales): Auto, Stack on the left, Stack on the right. */
export type ScalesMode = "auto" | Side;

/** Most scales of one pane (both sides). */
export const MAX_PANE_SCALES = 8;

const RIGHT_NAMES = ["A", "B", "C", "D", "E", "F", "G", "H"];
const LEFT_NAMES = ["Z", "Y", "X", "W", "V", "U", "T", "S"];

/** Name of the scale at `index` of `side` ("" past the 8th). */
export function scaleLetter(side: Side, index: number): string {
  return (side === "left" ? LEFT_NAMES : RIGHT_NAMES)[index] ?? "";
}

const KEY_RE = /^(left|right)(?:#(\d+))?$/;

/** A side scale key ("left", "right", "left#2"...). */
export function isScaleKey(s: unknown): s is ScaleKey {
  return typeof s === "string" && KEY_RE.test(s);
}

export function keySide(key: ScaleKey): Side {
  return key.startsWith("left") ? "left" : "right";
}

/** Order of a key on its side (0 = the side's first scale). */
export function keyOrder(key: ScaleKey): number {
  const m = KEY_RE.exec(key);
  return m?.[2] ? Number(m[2]) : 0;
}

/** Key of a new scale at the end of `side`, given the keys of the pane. */
export function newScaleKey(side: Side, paneKeys: Iterable<ScaleKey>): ScaleKey {
  let max = -1;
  for (const k of paneKeys) if (keySide(k) === side) max = Math.max(max, keyOrder(k));
  return max < 0 ? side : `${side}#${max + 1}`;
}

/** Chart library scale id of index `index` of `side`. */
export function libScaleId(side: Side, index: number): string {
  return index === 0 ? side : `${side}#${index}`;
}

/** A source on a scale: `key` = its scale, or "new" = a new scale to give it. */
export type ScaleUse = { source: string; pane: number; key: ScaleKey | "new" };

export type ScaleSlot = { side: Side; index: number };

const byOrder = (a: ScaleKey, b: ScaleKey) => keyOrder(a) - keyOrder(b);

export class ScaleLayout {
  /** Scales of each pane per side, in display order (index 0 first). */
  private panes = new Map<number, { left: ScaleKey[]; right: ScaleKey[] }>();
  /** Keys given to the "new" uses (in use order). */
  readonly given = new Map<string, ScaleKey | null>();
  private keyOf = new Map<string, { pane: number; key: ScaleKey }>();

  constructor(uses: readonly ScaleUse[], readonly mode: ScalesMode = "auto") {
    const stored = new Map<number, Set<ScaleKey>>();
    const keysOf = (pane: number) => {
      let s = stored.get(pane);
      if (!s) stored.set(pane, (s = new Set()));
      return s;
    };
    for (const u of uses) if (u.key !== "new") keysOf(u.pane).add(u.key);
    for (const u of uses) {
      if (u.key !== "new") {
        this.keyOf.set(u.source, { pane: u.pane, key: u.key });
        continue;
      }
      const keys = keysOf(u.pane);
      const key = this.newKeyIn(u.pane, keys);
      this.given.set(u.source, key);
      if (key) {
        keys.add(key);
        this.keyOf.set(u.source, { pane: u.pane, key });
      }
    }
    for (const [pane, keys] of stored) this.panes.set(pane, this.lists(keys));
  }

  /** Display lists of a pane's keys. */
  private lists(keys: Iterable<ScaleKey>): { left: ScaleKey[]; right: ScaleKey[] } {
    const left = [...keys].filter((k) => keySide(k) === "left").sort(byOrder);
    const right = [...keys].filter((k) => keySide(k) === "right").sort(byOrder);
    if (this.mode === "left") return { left: [...left, ...right], right: [] };
    if (this.mode === "right") return { left: [], right: [...right, ...left] };
    return { left, right };
  }

  /** Key of a new scale in a pane holding `keys`, or null (no room: no scale). */
  private newKeyIn(pane: number, keys: Set<ScaleKey>): ScaleKey | null {
    void pane;
    if (keys.size >= MAX_PANE_SCALES) return null;
    const l = this.lists(keys);
    const side: Side = this.mode !== "auto" ? this.mode : l.left.length < l.right.length ? "left" : "right";
    return newScaleKey(side, keys);
  }

  /** The key a new scale of `side` (or the placement's side) would take in `pane`, or null when full. */
  newKeyFor(pane: number, side?: Side): ScaleKey | null {
    const keys = new Set(this.keysIn(pane));
    if (keys.size >= MAX_PANE_SCALES) return null;
    if (!side) return this.newKeyIn(pane, keys);
    return newScaleKey(side, keys);
  }

  /** Room for another scale in the pane. */
  canCreate(pane: number): boolean {
    return this.keysIn(pane).length < MAX_PANE_SCALES;
  }

  keysIn(pane: number): ScaleKey[] {
    const p = this.panes.get(pane);
    return p ? [...p.left, ...p.right] : [];
  }

  /** Scales of `side` in `pane`, index 0 first. */
  scales(pane: number, side: Side): ScaleKey[] {
    return this.panes.get(pane)?.[side] ?? [];
  }

  /** Where scale `key` of `pane` is shown, or null. */
  slotOf(pane: number, key: ScaleKey): ScaleSlot | null {
    const p = this.panes.get(pane);
    if (!p) return null;
    for (const side of ["left", "right"] as const) {
      const i = p[side].indexOf(key);
      if (i >= 0) return { side, index: i };
    }
    return null;
  }

  /** Chart library scale id of `key` in `pane` (the side id when not laid out). */
  libId(pane: number, key: ScaleKey): string {
    const s = this.slotOf(pane, key);
    return s ? libScaleId(s.side, s.index) : keySide(key);
  }

  /** Scale (pane, key) of a source, or null (no scale / not on the chart). */
  sourceScale(source: string): { pane: number; key: ScaleKey } | null {
    return this.keyOf.get(source) ?? null;
  }

  /** Sources on scale `key` of `pane`. */
  sourcesOn(pane: number, key: ScaleKey): string[] {
    const out: string[] = [];
    for (const [src, k] of this.keyOf) if (k.pane === pane && k.key === key) out.push(src);
    return out;
  }

  /** Largest count of scales per side over the panes (every pane reserves them). */
  slotCounts(): { left: number; right: number; total: number } {
    let left = 0;
    let right = 0;
    for (const p of this.panes.values()) {
      left = Math.max(left, p.left.length);
      right = Math.max(right, p.right.length);
    }
    return { left, right, total: left + right };
  }

  /** Name of scale `key` of `pane` ("" when the chart has a single scale or the scale is not laid out). */
  letter(pane: number, key: ScaleKey): string {
    const s = this.slotOf(pane, key);
    return s ? scaleLetter(s.side, s.index) : "";
  }

  /** Every pane and side with scales past the first one. */
  extraScales(): { pane: number; side: Side; index: number; key: ScaleKey }[] {
    const out: { pane: number; side: Side; index: number; key: ScaleKey }[] = [];
    for (const [pane, p] of this.panes) {
      for (const side of ["left", "right"] as const) p[side].forEach((key, index) => { if (index > 0) out.push({ pane, side, index, key }); });
    }
    return out;
  }

  /** Compact text of the layout (changes = the sources' scale ids changed). */
  signature(): string {
    const parts: string[] = [];
    for (const [src, k] of [...this.keyOf].sort(([a], [b]) => (a < b ? -1 : 1))) parts.push(`${src}=${k.pane}:${this.libId(k.pane, k.key)}`);
    return parts.join("|");
  }
}
