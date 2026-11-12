import { describe, expect, it } from "vitest";
import { addEquityEvent, equityExtremes, newEquityExtremes } from "../equity-extremes";
import type { EquityEvent } from "../types";

/** The max drawdown / run-up read from the whole list of events (as the report did before they were folded). */
function fromList(events: EquityEvent[], initialCapital: number) {
  let peak = initialCapital;
  let trough = initialCapital;
  const r = { dd: 0, ddPct: 0, ru: 0, ruPct: 0 };
  for (let k = 0; k < events.length; k++) {
    const e = events[k]!;
    const beforeFill = e.t === "p" && k + 1 < events.length && events[k + 1]!.t !== "p";
    if (e.t !== "e" && !beforeFill) {
      const dd = peak - e.v;
      if (dd > r.dd) r.dd = dd;
      if (peak > 0 && dd / peak > r.ddPct) r.ddPct = dd / peak;
      const ru = e.v - trough;
      if (ru > r.ru) r.ru = ru;
      if (e.v > 0 && ru / e.v > r.ruPct) r.ruPct = ru / e.v;
    }
    if (e.t === "c") peak = Math.max(peak, e.realized);
    if ((e.t === "c" && (e.flat || e.marginCall)) || e.t === "e") trough = Math.min(trough, e.realized);
  }
  return r;
}

describe("equity extremes folded as the events come", () => {
  it("equal the ones read from the whole list, at every step", () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let run = 0; run < 200; run++) {
      const capital = 1000 + rnd() * 9000;
      const events: EquityEvent[] = [];
      const x = newEquityExtremes();
      let realized = capital;
      for (let k = 0; k < 300; k++) {
        const r = rnd();
        const t: EquityEvent["t"] = r < 0.6 ? "p" : r < 0.8 ? "c" : "e";
        if (t === "c") realized += (rnd() - 0.5) * 400;
        const e: EquityEvent = { t, v: realized + (rnd() - 0.5) * 600, realized, flat: t === "c" && rnd() < 0.5 };
        events.push(e);
        addEquityEvent(x, e, capital);
        // a margin call changes the close event it just made
        if (t === "c" && rnd() < 0.1) {
          e.marginCall = true;
          e.v -= 100;
        }
        if (k % 37 === 0 || k === 299) expect(equityExtremes(x, capital)).toEqual(fromList(events, capital));
      }
    }
  });

  it("survive a copy of the broker's state (live runs save and restore it)", () => {
    const x = newEquityExtremes();
    addEquityEvent(x, { t: "e", v: 990, realized: 999, flat: false }, 1000);
    addEquityEvent(x, { t: "p", v: 900, realized: 999, flat: false }, 1000);
    const y = structuredClone(x);
    addEquityEvent(y, { t: "c", v: 950, realized: 950, flat: true }, 1000);
    expect(equityExtremes(y, 1000)).toEqual(
      fromList([{ t: "e", v: 990, realized: 999, flat: false }, { t: "p", v: 900, realized: 999, flat: false }, { t: "c", v: 950, realized: 950, flat: true }], 1000),
    );
  });
});
