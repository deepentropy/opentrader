/*
 * What a broker supports (#320): the order ticket, the chart trading lines, the DOM and the account manager offer
 * only that. A broker plugin reports it in `broker.state.capabilities`; the replay broker supports everything.
 */
import type { BrokerCapabilities } from "../../bindings";
import type { OrderRequest, OrderType, TradingOrder } from "./types";

export type TradingCapabilities = {
  /** Order types, in the ticket's order. */
  orderTypes: OrderType[];
  /** Take profit / stop loss on a new order. */
  brackets: boolean;
  /** Take profit / stop loss on an open position. */
  positionBrackets: boolean;
  /** Close part of a position. */
  partialClose: boolean;
  /** Modify a working order's price or quantity. */
  modifyOrders: boolean;
  /** Order price rules (#370, see price-rules.ts): a stop / the stop of a stop limit may sit on either side of the
   *  market; a limit may not cross it. */
  stopOrdersBothSides: boolean;
  stopLimitOrdersBothSides: boolean;
  strictLimitPrice: boolean;
};

export const ORDER_TYPES: OrderType[] = ["market", "limit", "stop", "stopLimit"];

export const ALL_CAPABILITIES: TradingCapabilities = {
  orderTypes: ORDER_TYPES,
  brackets: true,
  positionBrackets: true,
  partialClose: true,
  modifyOrders: true,
  stopOrdersBothSides: false,
  stopLimitOrdersBothSides: false,
  strictLimitPrice: false,
};

/** A plugin's capabilities; a feature it leaves out is supported (as the app reads `broker.state`), a price rule it
 *  leaves out applies. */
export function capabilitiesOf(c: BrokerCapabilities | null | undefined): TradingCapabilities {
  if (!c) return ALL_CAPABILITIES;
  const listed = c.orderTypes ? ORDER_TYPES.filter((t) => c.orderTypes!.includes(t)) : ORDER_TYPES;
  return {
    // A broker that lists no order type the app knows would leave the ticket without one: all of them, it refuses.
    orderTypes: listed.length ? listed : ORDER_TYPES,
    brackets: c.brackets ?? true,
    positionBrackets: c.positionBrackets ?? true,
    partialClose: c.partialClose ?? true,
    modifyOrders: c.modifyOrders ?? true,
    // Price rules: a broker that says nothing has the usual ones.
    stopOrdersBothSides: c.stopOrdersBothSides ?? false,
    stopLimitOrdersBothSides: c.stopLimitOrdersBothSides ?? false,
    strictLimitPrice: c.strictLimitPrice ?? false,
  };
}

/** The broker takes this order as it is: its type, and its take profit / stop loss. */
export function takesOrder(c: TradingCapabilities, req: Pick<OrderRequest, "type" | "takeProfit" | "stopLoss">): boolean {
  if (!c.orderTypes.includes(req.type)) return false;
  return c.brackets || (req.takeProfit === null && req.stopLoss === null);
}

/** A line (or DOM mark) of `o` may be dragged to a new price, or its bracket cancelled: a working order is modified,
 *  an order's take profit / stop loss is a modify of its order, the position's sets its brackets. */
export function canMove(c: TradingCapabilities, o: TradingOrder): boolean {
  if (o.kind === "order") return c.modifyOrders;
  if (o.parentId === "position") return c.positionBrackets;
  return c.modifyOrders && c.brackets;
}

/** A working order's take profit / stop loss can be added from its line: a modify that sets them. */
export const canAddOrderBrackets = (c: TradingCapabilities) => c.modifyOrders && c.brackets;

/** A choice the broker needs with each order (a product type…): a selector in the order ticket. */
export type TicketField = { id: string; label: string; options: { value: string; label: string }[]; default: string };

/** A time in force the broker takes (#349): its id goes with the order, the label shows in the ticket. */
export type TicketDuration = { id: string; label: string; orderTypes: OrderType[] | null; default: boolean };

/** How the ticket's ticker trades: the quantities the broker takes (units) and the money one unit moves by a point. */
export type Instrument = {
  qtyMin: number | null;
  /** Orders are whole multiples of it: the lot size. */
  qtyStep: number | null;
  qtyMax: number | null;
  pointValue: number;
  fields: TicketField[];
  /** Its times in force; none: the broker's own, and the ticket shows no selector. */
  durations: TicketDuration[];
};

export const ANY_INSTRUMENT: Instrument = { qtyMin: null, qtyStep: null, qtyMax: null, pointValue: 1, fields: [], durations: [] };

type WireField = { id?: string | null; label?: string | null; options?: { value?: string | null; label?: string | null }[] | null; default?: string | null };

/** The ticket fields a plugin declares, cleaned: without an id or an option they are left out. */
export function ticketFieldsOf(list: WireField[] | null | undefined): TicketField[] {
  const out: TicketField[] = [];
  for (const f of list ?? []) {
    const options = (f.options ?? []).filter((o) => o.value).map((o) => ({ value: o.value!, label: o.label || o.value! }));
    if (!f.id || !options.length) continue;
    const def = options.some((o) => o.value === f.default) ? f.default! : options[0].value;
    out.push({ id: f.id, label: f.label || f.id, options, default: def });
  }
  return out;
}

type WireDuration = { id?: string | null; label?: string | null; orderTypes?: string[] | null; default?: boolean | null };

/** The durations a plugin declares, cleaned: without an id they are left out; no order type the app knows is all. */
export function durationsOf(list: WireDuration[] | null | undefined): TicketDuration[] {
  return (list ?? [])
    .filter((d) => d.id)
    .map((d) => {
      const types = ORDER_TYPES.filter((t) => d.orderTypes?.includes(t));
      return { id: d.id!, label: d.label || d.id!, orderTypes: types.length ? types : null, default: !!d.default };
    });
}

/** The durations an order of `type` may have. */
export const durationsFor = (list: TicketDuration[], type: OrderType): TicketDuration[] => list.filter((d) => !d.orderTypes || d.orderTypes.includes(type));

/** The duration of an order of `type`: the first of `wanted` it may have, else the broker's default, else the first;
 *  null when the broker declares none for it. */
export function pickDuration(list: TicketDuration[], type: OrderType, ...wanted: (string | null | undefined)[]): string | null {
  const ok = durationsFor(list, type);
  return wanted.find((w) => w && ok.some((d) => d.id === w)) ?? ok.find((d) => d.default)?.id ?? ok[0]?.id ?? null;
}

const positive = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v > 0 ? v : null);

/** A plugin's instrument (`broker.instrument`), the capabilities' ticket fields and durations when it names none. */
export function instrumentOf(
  i:
    | { qtyMin?: number | null; qtyStep?: number | null; qtyMax?: number | null; pointValue?: number | null; ticketFields?: WireField[] | null; durations?: WireDuration[] | null }
    | null
    | undefined,
  fields: WireField[] | null | undefined,
  durations?: WireDuration[] | null,
): Instrument {
  return {
    qtyMin: positive(i?.qtyMin),
    qtyStep: positive(i?.qtyStep),
    qtyMax: positive(i?.qtyMax),
    pointValue: positive(i?.pointValue) ?? 1,
    fields: ticketFieldsOf(i?.ticketFields ?? fields),
    durations: durationsOf(i?.durations ?? durations),
  };
}

/** `v` is a whole multiple of `step` (to the float's precision). */
const isMultiple = (v: number, step: number) => Math.abs(v / step - Math.round(v / step)) < 1e-6;

/** What is wrong with a quantity for the instrument, or null. */
export function qtyProblem(qty: number, i: Instrument): { kind: "min" | "max" | "step"; n: number; next?: number } | null {
  // A minimum of one lot reads as the lots ("65 is one lot: use 65 or 130").
  const lotMin = i.qtyStep != null && i.qtyMin != null && i.qtyMin <= i.qtyStep;
  if (i.qtyMin != null && !lotMin && qty < i.qtyMin - 1e-9) return { kind: "min", n: i.qtyMin };
  if (i.qtyMax != null && qty > i.qtyMax + 1e-9) return { kind: "max", n: i.qtyMax };
  if (i.qtyStep != null && !isMultiple(qty, i.qtyStep)) {
    const below = Math.floor(qty / i.qtyStep + 1e-9) * i.qtyStep;
    return { kind: "step", n: Math.max(below, i.qtyStep), next: Math.max(below, i.qtyStep) === below ? below + i.qtyStep : 2 * i.qtyStep };
  }
  return null;
}

/** Units rounded down to the instrument's lots (null when below one lot or the minimum). */
export function wholeLots(units: number, i: Instrument): number | null {
  const step = i.qtyStep;
  const v = step ? Math.floor(units / step + 1e-9) * step : units;
  const clean = step ? Number(v.toFixed(10)) : v;
  if (!(clean > 0) || (i.qtyMin != null && clean < i.qtyMin - 1e-9)) return null;
  return i.qtyMax != null ? Math.min(clean, i.qtyMax) : clean;
}

/** The quantity one arrow-key press moves: a lot, else 1. */
export const qtyArrowStep = (i: Instrument) => i.qtyStep ?? 1;
