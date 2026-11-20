/*
 * The order book of a ticker as a broker plugin sends it (`broker.depth`, #372): the whole book (a snapshot), or the
 * levels that changed, a quantity of 0 removing its level. Prices are kept as the plugin sends them; the DOM puts
 * them on its tick grid.
 */

/** As the plugin sent it: a number the JSON could not hold arrives as null and the level is skipped. */
export type DepthLevel = { price: number | null; qty: number | null };
/** `snapshot` left out: the whole book. */
export type DepthMessage = { snapshot?: boolean; bids?: DepthLevel[]; asks?: DepthLevel[] };
/** Price → quantity, per side. */
export type DepthBook = { bids: Map<number, number>; asks: Map<number, number> };

function merge(side: Map<number, number>, levels: DepthLevel[] = []) {
  for (const { price, qty } of levels) {
    if (price == null || !Number.isFinite(price) || price <= 0 || qty == null || !Number.isFinite(qty)) continue;
    if (qty > 0) side.set(price, qty);
    else side.delete(price);
  }
}

/** The book once a message is applied (a new object: the old one is left as it was). */
export function applyDepth(book: DepthBook | undefined, m: DepthMessage): DepthBook {
  const next: DepthBook = m.snapshot !== false || !book ? { bids: new Map(), asks: new Map() } : { bids: new Map(book.bids), asks: new Map(book.asks) };
  merge(next.bids, m.bids);
  merge(next.asks, m.asks);
  return next;
}
