/*
 * Points asked on the chart for a script's time and price inputs (Pine `confirm`, the study menu's "Reset points…").
 *
 * Reference rules: the inputs are asked one by one in their order; a time and a price input that share an `inline`
 * id (and are alone on it) are one point, set with one click. Each request shows a hint at the bottom of the chart
 * ("Set the time for "<study>"" …, or the tooltip of the input / of its inline row); Escape or the hint's close button
 * cancels the whole sequence. A time is the bar under the pointer (left of the first bar: no point), a price the
 * price at the pointer on the main price scale, not rounded.
 */
import { createSignal } from "solid-js";
import { translateWith } from "../../i18n/translator";

/** What a click sets: the bar's time, the price, or both. */
export type PointKind = "time" | "price" | "all";
/** A point given on the chart: `time` in UNIX seconds (a bar time), `price` on the main price scale. */
export type PickedPoint = { time?: number; price?: number };

/** The chart asked: a tab and the index of the chart in its layout. */
export type PointTarget = { tabId: string; paneIndex: number };

export type PointRequest = PointTarget & {
  kind: PointKind;
  hint: string;
  /** The points already given in this sequence (drawn while the next one is asked). */
  picked: PickedPoint[];
  resolve: (p: PickedPoint) => void;
  cancel: () => void;
};

const [current, setCurrent] = createSignal<PointRequest | null>(null);
/** The point asked now, if any. */
export const pointRequest = current;

/** Ask a point on the chart `target`; null when the user cancels. */
export function requestChartPoint(target: PointTarget, kind: PointKind, hint: string, picked: PickedPoint[] = []): Promise<PickedPoint | null> {
  current()?.cancel();
  return new Promise((resolve) => {
    const req: PointRequest = {
      ...target,
      kind,
      hint,
      picked,
      resolve: (p) => {
        if (current() === req) setCurrent(null);
        resolve(p);
      },
      cancel: () => {
        if (current() === req) setCurrent(null);
        resolve(null);
      },
    };
    setCurrent(req);
  });
}

/** The charts that can take a point now (shown, time-based bars), by `tabId:paneIndex`; kept by their pick layers. */
const pickable = new Set<string>();
const keyOf = (t: PointTarget) => `${t.tabId}:${t.paneIndex}`;
export function setPickable(t: PointTarget, on: boolean): void {
  if (on) pickable.add(keyOf(t));
  else pickable.delete(keyOf(t));
}
/** False when the chart `t` is not shown (an editor tab's chart) or has no bar times (brick types): its points are
 *  then given in the dialog's fields. */
export const canPickOn = (t: PointTarget): boolean => pickable.has(keyOf(t));

/** Cancel the point asked now (Escape, the hint's close button). */
export function cancelPointRequest(): void {
  current()?.cancel();
}

/** The fields of an input the planning reads. */
export type PointInput = { id: string; type: string; title?: string; inline?: string; group?: string; tooltip?: string; hidden?: boolean };

/** One click: the input ids it sets and its hint. */
export type PointStep = { kind: PointKind; hint: string; timeId?: string; priceId?: string };

/** A time or price input a user can see: the ones given on the chart. */
export const isPointInput = (c: PointInput): boolean => (c.type === "time" || c.type === "price") && !c.hidden;

/**
 * The clicks that give `inputs` (time and price inputs, in their order) a value. `all`: every input of the script
 * (an inline row's tooltip is read from any of its inputs). `study`: the study's short title, in the hints.
 */
export function pointSteps(inputs: PointInput[], all: PointInput[], study: string): PointStep[] {
  const rowTooltip = (inline: string): string | undefined => {
    let tip: string | undefined;
    for (const c of all) if (c.inline === inline && c.tooltip) tip = c.tooltip;
    return tip;
  };
  const rowKey = (c: PointInput) => `${c.group ?? ""}\u0000${c.inline}`;
  const rows = new Map<string, PointInput[]>();
  for (const c of inputs) if (c.inline !== undefined) rows.set(rowKey(c), [...(rows.get(rowKey(c)) ?? []), c]);
  const steps: PointStep[] = [];
  const done = new Set<string>();
  for (const c of inputs) {
    if (done.has(c.id)) continue;
    const row = c.inline !== undefined ? rows.get(rowKey(c))! : [c];
    if (row.length === 2 && row[0].type !== row[1].type) {
      const time = row[0].type === "time" ? row[0] : row[1];
      const price = row[0].type === "price" ? row[0] : row[1];
      const hint =
        rowTooltip(c.inline!) ??
        (time.inline
          ? translateWith('Set the "{0}" time and price for "{1}"', time.inline, study)
          : translateWith('Set the time and price for "{0}"', study));
      steps.push({ kind: "all", hint, timeId: time.id, priceId: price.id });
      done.add(time.id).add(price.id);
      continue;
    }
    const isTime = c.type === "time";
    const hint =
      (c.inline !== undefined ? rowTooltip(c.inline) : undefined) ??
      c.tooltip ??
      (c.title
        ? isTime
          ? translateWith('Set the "{0}" time for "{1}"', c.title, study)
          : translateWith('Set the "{0}" price for "{1}"', c.title, study)
        : isTime
          ? translateWith('Set the time for "{0}"', study)
          : translateWith('Set the price for "{0}"', study));
    steps.push(isTime ? { kind: "time", hint, timeId: c.id } : { kind: "price", hint, priceId: c.id });
    done.add(c.id);
  }
  return steps;
}

/**
 * Ask the points of `steps` on the chart `target`, one after another; the inputs they set (a time in milliseconds, as
 * time inputs hold it), or null when the user cancels.
 */
export async function askPoints(target: PointTarget, steps: PointStep[]): Promise<Record<string, number> | null> {
  const out: Record<string, number> = {};
  const picked: PickedPoint[] = [];
  for (const step of steps) {
    const p = await requestChartPoint(target, step.kind, step.hint, [...picked]);
    if (!p) return null;
    if (step.timeId && p.time !== undefined) out[step.timeId] = p.time * 1000;
    if (step.priceId && p.price !== undefined) out[step.priceId] = p.price;
    picked.push(p);
  }
  return out;
}
