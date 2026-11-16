/*
 * The message of an order quantity the broker would refuse (#341): below its minimum, above its maximum, or not whole
 * lots. The order ticket shows it under its button; an order from the chart or the DOM is refused with it.
 */
import { translateWith } from "../../i18n/translator";
import { fmtQty } from "../../window/trading/format";
import { qtyProblem, type Instrument } from "./capabilities";

export function qtyMessage(qty: number, i: Instrument): string | null {
  const p = qtyProblem(qty, i);
  if (!p) return null;
  if (p.kind === "min") return translateWith("The smallest quantity is {0}", fmtQty(p.n));
  if (p.kind === "max") return translateWith("The largest quantity is {0}", fmtQty(p.n));
  return translateWith("{0} is one lot: use {1} or {2}", fmtQty(i.qtyStep), fmtQty(p.n), fmtQty(p.next));
}
