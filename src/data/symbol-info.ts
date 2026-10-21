/*
 * "Symbol info" dialog data (the reference dialog's rules):
 *  - the fields in two groups, two per row, a field without a value left out
 *    (no "-" rows): Symbol, Name, Sector, Industry, FIGI, Website (a stock) /
 *    Home page (a fund) | Type, Point value, Listed exchange, Currency, Tick
 *    size. The data served has no ISIN, CUSIP, CFI code nor sector, and no
 *    traded-exchange name: those rows do not show;
 *  - Type: the security type and its visible sub-type ("Fund ETF", "Stock",
 *    "DR"), first letter capitalised.
 * The session bar is the legend status popup's (window/chart/legend-status.ts).
 */

/** "Fund ETF", "Stock", "DR" for a security type as served ("etf", "stock", "adr"…); null when unknown. */
export function securityTypeLabel(kind: string | null | undefined): string | null {
  switch ((kind ?? "").toLowerCase()) {
    case "stock":
    case "preferred":
      return "Stock";
    case "etf":
      return "Fund ETF";
    case "etn":
      return "Fund ETN";
    case "etv":
    case "fund":
      return "Fund";
    case "adr":
      return "DR";
    case "warrant":
      return "Warrant";
    case "right":
      return "Right";
    case "unit":
      return "Unit";
    default:
      return null;
  }
}

/** One field of the dialog. `link`: opens in the browser (value = its host name); `copy`: has a copy button. */
export type InfoField = { title: string; value: string; link?: string; copy?: boolean; flag?: string };

export type InfoInput = {
  /** Full symbol ("AMEX:SPY"). */
  symbol: string;
  name?: string | null;
  sector?: string | null;
  industry?: string | null;
  figi?: string | null;
  homepageUrl?: string | null;
  /** Security type as served ("etf", "stock"…). */
  securityType?: string | null;
  /** Listing exchange as the symbol names it ("AMEX"). */
  listedExchange?: string | null;
  /** Its country flag (an image URL). */
  flag?: string | null;
  currency?: string | null;
  tickSize?: string | null;
};

/** Host name of a URL without "www." (the reference shows the site that way). */
export function siteName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The two groups of fields. */
export function symbolInfoGroups(i: InfoInput): InfoField[][] {
  const kind = (i.securityType ?? "").toLowerCase();
  const isFund = ["etf", "etn", "etv", "fund"].includes(kind);
  const isStock = kind === "stock" || kind === "preferred";
  const first: InfoField[] = [{ title: "Symbol", value: i.symbol }];
  if (i.name) first.push({ title: "Name", value: i.name });
  if (i.sector) first.push({ title: "Sector", value: i.sector });
  if (i.industry) first.push({ title: "Industry", value: i.industry });
  if (i.figi) first.push({ title: "FIGI", value: i.figi, copy: true });
  if (i.homepageUrl && (isStock || isFund)) first.push({ title: isStock ? "Website" : "Home page", value: siteName(i.homepageUrl), link: i.homepageUrl });
  const second: InfoField[] = [];
  const type = securityTypeLabel(i.securityType);
  if (type) second.push({ title: "Type", value: type });
  second.push({ title: "Point value", value: "1" });
  if (i.listedExchange) second.push({ title: "Listed exchange", value: i.listedExchange, ...(i.flag ? { flag: i.flag } : {}) });
  if (i.currency) second.push({ title: "Currency", value: i.currency });
  if (i.tickSize) second.push({ title: "Tick size", value: i.tickSize });
  return [first, second];
}

/** "New York" for "America/New_York". */
export function zoneCity(timeZone: string): string {
  return (timeZone.split("/").pop() ?? timeZone).replace(/_/g, " ");
}
