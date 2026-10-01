/*
 * Country flags of the symbol search rows (open-source "flag-icons" set,
 * MIT, square variant drawn as a 20 px disc). A row's country comes from
 * the search data (locale) or, for rows built from a full symbol name, from
 * its exchange.
 *
 * Each flag is its own lazy chunk, loaded the first time a row needs it:
 * the set is 2.4 MB, so nothing of it rides in the startup bundle.
 */
import { createSignal } from "solid-js";

const LOADERS = import.meta.glob("../../node_modules/flag-icons/flags/1x1/*.svg", {
  query: "?url",
  import: "default",
}) as Record<string, () => Promise<string>>;

const LOADER_BY_CODE: Record<string, () => Promise<string>> = {};
for (const [path, load] of Object.entries(LOADERS)) {
  const code = /\/([a-z0-9-]+)\.svg$/.exec(path)?.[1];
  if (code) LOADER_BY_CODE[code.toUpperCase()] = load;
}

const [loaded, setLoaded] = createSignal<Record<string, string>>({});
const requested = new Set<string>();

/** Flag image URL of an ISO 3166 alpha-2 country code. Reactive: undefined
 *  until the flag's chunk has loaded (or when the set has no such flag). */
export function flagUrl(country: string | undefined): string | undefined {
  if (!country) return undefined;
  const code = country.toUpperCase();
  const url = loaded()[code];
  if (url) return url;
  const load = LOADER_BY_CODE[code];
  if (load && !requested.has(code)) {
    requested.add(code);
    load().then((u) => setLoaded((m) => ({ ...m, [code]: u })), () => {});
  }
  return undefined;
}

/** US exchanges, by the names and codes the rows carry. */
const US_EXCHANGES = new Set([
  "NASDAQ", "NYSE", "NYSE ARCA", "NYSE AMERICAN", "AMEX", "ARCA",
  "CBOE", "CBOE BZX", "CBOE BYX", "CBOE EDGX", "CBOE EDGA", "BATS",
  "IEX", "OTC", "BOATS",
]);

/** Country of a listing by its exchange (undefined when not known). */
export function countryOfExchange(exchange: string | undefined): string | undefined {
  return exchange && US_EXCHANGES.has(exchange.toUpperCase()) ? "US" : undefined;
}
