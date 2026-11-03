/*
 * US dollar exchange rates for the screener's "Convert financials": the
 * latest noon buying rate of the central bank's daily series (the economic
 * series feed, observed a few days late), read once an hour.
 */
import { createSignal } from "solid-js";
import { getBars } from "./datafeed";
import type { Currency } from "./screener-settings";

/** Series per currency, and whether it is quoted as dollars per unit (true) or units per dollar. */
const SERIES: Record<Exclude<Currency, "USD">, [id: string, dollarsPerUnit: boolean]> = {
  EUR: ["DEXUSEU", true],
  GBP: ["DEXUSUK", true],
  AUD: ["DEXUSAL", true],
  JPY: ["DEXJPUS", false],
  CAD: ["DEXCAUS", false],
  CHF: ["DEXSZUS", false],
  CNY: ["DEXCHUS", false],
  INR: ["DEXINUS", false],
};
const MAX_AGE_MS = 3600_000;

const [rates, setRates] = createSignal<Partial<Record<Currency, number>>>({ USD: 1 });
const loadedAt = new Map<Currency, number>();

/** Units of `c` per US dollar (reactive), or undefined until it is loaded. Starts the load when needed. */
export function usdRate(c: Currency): number | undefined {
  if (c !== "USD" && Date.now() - (loadedAt.get(c) ?? 0) > MAX_AGE_MS) {
    loadedAt.set(c, Date.now());
    void load(c);
  }
  return rates()[c];
}

async function load(c: Exclude<Currency, "USD">): Promise<void> {
  const [id, dollarsPerUnit] = SERIES[c];
  try {
    const { bars } = await getBars(`ECONOMICS:${id}`, "1D");
    const close = [...bars].reverse().map((b) => b.close).find((v): v is number => v !== null && Number.isFinite(v) && v > 0);
    if (close !== undefined) setRates({ ...rates(), [c]: dollarsPerUnit ? 1 / close : close });
  } catch (e) {
    // Tried again a minute later.
    loadedAt.set(c, Date.now() - MAX_AGE_MS + 60_000);
    console.warn("[fx] rate", c, e);
  }
}
