/*
 * Stock screener catalog: the reference app screener columns that the backend
 * table can fill, with their titles, formats, filter configs, filter presets,
 * column sets and the default screen.
 *
 * Source: the reference desktop app 3.4.1, read over CDP on 29/09/2026 from the
 * screener's own modules (getColumnConfig, getColumnFilterConfig, column
 * titles, presets data, redux store). Raw captures and the design notes are in
 * .tmp/screener/ (doc).
 *
 * A column is a reference app table column id + params (`{ id: "Ema", params:
 * { length: "50" } }`), stored like the reference app stores it in a screen. Each param
 * option maps to one backend field id (the reference app scanner name, e.g. EMA50).
 * Options whose field is missing from `screenerFields()` are dropped at
 * runtime (see `offered*` helpers), so the UI never offers a column or filter
 * the backend cannot serve.
 */
import { formatted, translate } from "../i18n/translator";
import { listText } from "../i18n/format";
import { CANDLE_PATTERNS } from "./candle-patterns";
import type { Clause } from "../bindings";

export type ColumnRef = { id: string; params: Record<string, string> };

/** Cell / value format. */
export type Fmt =
  | "price" //       14.82 USD
  | "signedPrice" // +0.12 USD, colored
  | "change" //      +6.47%, colored
  | "percent" //     5.22%
  | "volume" //      9.07 M
  | "signedVolume" // +39.66 M, colored
  | "money" //       4.8 B USD
  | "signedMoney" // +4.56 B USD, colored
  | "number" //      1.79
  | "integer" //     25
  | "date" //        27/09/2026 (UNIX seconds)
  | "rating" //      Strong buy (a technical rating from -1 to 1)
  | "patterns" //    candlestick pattern badges (comma-joined pattern ids)
  | "text";

export type Category = "securityInfo" | "marketData" | "technicals" | "financials" | "valuation" | "growth" | "margins" | "dividends";

/** The reference app filter operations the backend can evaluate (crosses and the % offset
 *  manual operations are left out). */
export type Operation = "above" | "aboveOrEqual" | "below" | "belowOrEqual" | "equal" | "nequal" | "between" | "outside";
/** The operations of both screeners: these and the Script Screener's crossings and signal ones. */
export type FilterOp = Operation | "crosses" | "crossesUp" | "crossesDown" | "true" | "trueWithin";
/** Operations only used by presets (EMA/SMA deviation from price). */
export type OffsetOperation = "abovePercent" | "belowPercent";
export type OffsetRangeId = "offset_range_0_5" | "offset_range_0_10" | "offset_range_0_20" | "offset_range_10" | "offset_range_20" | "offset_range_100";

export type ParamOption = { value: string; label: string; short: string; field: string };
/** `custom`: any length from 1 to MAX_CUSTOM_LENGTH can be typed ("Custom…"); its field is the prefix and the
 *  length ("EMA137"), computed by the backend from the closes file when a screen uses it. */
export type ParamDef = { key: string; title: string; default: string; options: ParamOption[]; custom?: { prefix: "EMA" | "SMA" | "RSI" } };

/** Longest custom length (the backend's closes::MAX_LENGTH). */
export const MAX_CUSTOM_LENGTH = 500;

/** A custom length's field id ("EMA137", "SMA150", "RSI21"): one the daily state does not hold. */
export function isCustomField(field: string): boolean {
  const m = /^(EMA|SMA|RSI)([1-9]\d*)$/.exec(field);
  if (!m || Number(m[2]) > MAX_CUSTOM_LENGTH) return false;
  const n = Number(m[2]);
  return m[1] === "RSI" ? n !== 7 : !MA_LENGTHS.includes(n);
}

/** The option of a param value: one of its options, else a typed custom length. */
export function optionOf(pd: ParamDef, value: string): ParamOption | undefined {
  const opt = pd.options.find((o) => o.value === value);
  if (opt || !pd.custom || !/^[1-9]\d*$/.test(value) || Number(value) > MAX_CUSTOM_LENGTH) return opt;
  return { value, label: value, short: value, field: `${pd.custom.prefix}${value}` };
}

/** One filter preset (a row of the pill popover list). */
export type Preset = {
  operation: Operation | OffsetOperation;
  offsetRangeId?: OffsetRangeId;
  /** "value" or the reference app id of the right column. */
  target: string;
  right: { value: number } | { left: number | null; right: number | null } | { column: ColumnRef };
  /** Params forced on the left column (e.g. EMA 50 for "50 above EMA, 100"). */
  leftParams?: Record<string, string>;
  description?: string;
};

export type ColumnDef = {
  id: string;
  /** Long title (column menu, filter popover title, Add filter item). */
  title: string;
  /** Short title (header, inactive pill). */
  short: string;
  category: Category;
  align: "left" | "right";
  fmt: Fmt;
  /** Default table width (px). */
  width: number;
  /** Field of a param-less column. */
  field?: string;
  params?: ParamDef[];
  filter?:
    | { type: "Condition"; operations: Operation[]; defaultOperation: Operation; targets: string[][]; presets?: Preset[] }
    /** `"data"`: the distinct values of `field` in the loaded data.
     *  `codes`: the value is a short code shown before the label ("SPX • S&P 500").
     *  `adaptive`: a single checked value is the pill text (the reference app
     *  `adaptiveFilterTitle`). */
    | { type: "CheckboxGroup"; options: [value: string, label: string][] | "data"; codes?: boolean; adaptive?: boolean;
        /** One value at a time (the reference app RadioGroup filter): a plain list, a click picks the value, the
         *  active pill shows it. */
        single?: boolean;
        /** The values are day ranges relative to today (the reference app Date filter, see RELATIVE_DATES): the
         *  column holds days as UNIX seconds. */
        relativeDate?: boolean;
        /** The clauses of the values picked when they are not "the field is one of them" (the reference's New high:
         *  the period's high is today's). */
        clauses?: (values: string[]) => Clause[] };
  /** Text shown for a raw cell value (a list of codes shown as names). */
  cellText?: (raw: string) => string;
  /** Kept out of the Column setup list (the reference app `isExcludedFromColumnsList`). */
  noColumn?: boolean;
  /** A financial amount: shown in the "Convert financials" currency when that setting is on (prices are not). */
  financial?: boolean;
  /** Field of a column whose field depends on several params at once (the Stochastic's inputs and plot). */
  fieldOfParams?: (params: Record<string, string>) => string;
  /** Field a checkbox filter reads when it is not the column's (a rating's bucket text, the column being its
   *  number). */
  filterField?: string;
};

// ── Param option sets ─────────────────────────────────────────────────────
const RES_1D = (field: string): ParamDef[] => [
  { key: "resolution", title: "Interval", default: "TimeResolution1D", options: [{ value: "TimeResolution1D", label: "1 day", short: "1D", field }] },
];
/** One day, the current week and the current month (the weekly and monthly bars). */
const RES_DWM = (day: string, week: string, month: string): ParamDef[] => [
  { key: "resolution", title: "Interval", default: "TimeResolution1D", options: [
    { value: "TimeResolution1D", label: "1 day", short: "1D", field: day },
    { value: "TimeResolution1W", label: "1 week", short: "1W", field: week },
    { value: "TimeResolution1M", label: "1 month", short: "1M", field: month },
  ] },
];
/** A one-day interval without a field of its own (the field comes from the other params). */
const RES_1D_ONLY: ParamDef = { key: "resolution", title: "Interval", default: "TimeResolution1D", options: [{ value: "TimeResolution1D", label: "1 day", short: "1D", field: "" }] };
const TIMEBASED = (fields: Record<string, string>): ParamDef[] => [
  {
    key: "timebased",
    title: "Interval",
    default: "TimeResolution1D",
    options: [
      { value: "TimeResolution1D", label: "1 day", short: "1D", field: fields["1D"] },
      { value: "Interval1M", label: "1 month", short: "1M", field: fields["1M"] },
      { value: "Interval3M", label: "3 months", short: "3M", field: fields["3M"] },
      { value: "Interval6M", label: "6 months", short: "6M", field: fields["6M"] },
      { value: "Interval52Weeks", label: "52 weeks", short: "52W", field: fields["52W"] },
    ],
  },
];
const MA_LENGTHS = [5, 9, 10, 20, 21, 30, 50, 100, 200];
const MA_PARAMS = (prefix: "EMA" | "SMA"): ParamDef[] => [
  {
    key: "length",
    title: "Length",
    default: "50",
    options: MA_LENGTHS.map((n) => ({ value: String(n), label: String(n), short: String(n), field: `${prefix}${n}` })),
    custom: { prefix },
  },
  { key: "resolution", title: "Interval", default: "TimeResolution1D", options: [{ value: "TimeResolution1D", label: "1 day", short: "1D", field: "" }] },
];

// ── Presets (the reference app presets data, crosses left out) ───────────────────────────
const d = (description: string) => ({ description });
const BANDS: Preset[] = [
  { operation: "above", target: "value", right: { value: 30 }, ...d("Exceptional up") },
  { operation: "above", target: "value", right: { value: 20 }, ...d("Very strong up") },
  { operation: "above", target: "value", right: { value: 10 }, ...d("Strong up") },
  { operation: "above", target: "value", right: { value: 5 }, ...d("Moderate up") },
  { operation: "between", target: "value", right: { left: 0, right: 5 }, ...d("Weak up") },
  { operation: "above", target: "value", right: { value: 0 }, ...d("Up") },
  { operation: "below", target: "value", right: { value: 0 }, ...d("Down") },
  { operation: "between", target: "value", right: { left: -5, right: 0 }, ...d("Weak down") },
  { operation: "below", target: "value", right: { value: -5 }, ...d("Moderate down") },
  { operation: "below", target: "value", right: { value: -10 }, ...d("Strong down") },
  { operation: "below", target: "value", right: { value: -20 }, ...d("Severe down") },
  { operation: "below", target: "value", right: { value: -30 }, ...d("Extreme down") },
];
const EMA50 = { id: "Ema", params: { length: "50", resolution: "TimeResolution1D" } };
const EMA200 = { id: "Ema", params: { length: "200", resolution: "TimeResolution1D" } };
const PRICE = { id: "Price", params: {} };
/** The reference presets of a moving average (the Hull MA takes the first eight). */
const MA_PRESETS = (id: string): Preset[] => [
  { operation: "below", target: "Price", right: { column: PRICE }, ...d("Bullish bias") },
  { operation: "belowPercent", offsetRangeId: "offset_range_0_10", target: "Price", right: { column: PRICE }, ...d("Bullish deviation") },
  { operation: "belowPercent", offsetRangeId: "offset_range_10", target: "Price", right: { column: PRICE }, ...d("Large bullish deviation") },
  { operation: "belowPercent", offsetRangeId: "offset_range_20", target: "Price", right: { column: PRICE }, ...d("Extreme bullish deviation") },
  { operation: "above", target: "Price", right: { column: PRICE }, ...d("Bearish bias") },
  { operation: "abovePercent", offsetRangeId: "offset_range_0_10", target: "Price", right: { column: PRICE }, ...d("Bearish deviation") },
  { operation: "abovePercent", offsetRangeId: "offset_range_10", target: "Price", right: { column: PRICE }, ...d("Large bearish deviation") },
  { operation: "abovePercent", offsetRangeId: "offset_range_20", target: "Price", right: { column: PRICE }, ...d("Extreme bearish deviation") },
  { operation: "above", target: id, leftParams: { length: "50" }, right: { column: { id, params: { length: "100", resolution: "TimeResolution1D" } } }, ...d("Bullish alignment") },
  { operation: "below", target: id, leftParams: { length: "50" }, right: { column: { id, params: { length: "100", resolution: "TimeResolution1D" } } }, ...d("Bearish alignment") },
];

/** Extended-hours columns (the reference column kinds: a price, a coloured percent change with the Change presets, a
 *  coloured amount, a volume). */
const extPrice = (id: string, title: string, short: string, field: string): ColumnDef => ({
  id, title, short, category: "marketData", align: "right", fmt: "price", width: 99, field,
  filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "aboveOrEqual", targets: PRICE_TARGETS(id) },
});
const extChange = (id: string, title: string, short: string, field: string): ColumnDef => ({
  id, title, short, category: "marketData", align: "right", fmt: "change", width: 90, field,
  filter: { type: "Condition", operations: CHANGE_OPS, defaultOperation: "above", targets: CHANGE_TARGETS, presets: BANDS },
});
const extChangeAbs = (id: string, title: string, short: string, field: string): ColumnDef => ({
  id, title, short, category: "marketData", align: "right", fmt: "signedPrice", width: 90, field,
  filter: { type: "Condition", operations: CHANGE_OPS, defaultOperation: "above", targets: [["value"]] },
});
const extVolume = (id: string, title: string, short: string, field: string): ColumnDef => ({
  id, title, short, category: "marketData", align: "right", fmt: "volume", width: 90, field,
  filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value"]] },
});

/** An ETF's weight of its largest holdings, % of net assets. */
const topWeight = (id: string, title: string, short: string, field: string): ColumnDef => ({
  id, title, short, category: "securityInfo", align: "right", fmt: "percent", width: 90, field,
  filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "above", targets: [["value"]] },
});
/** A technical rating column: its number (sorting, the cell) and its bucket text (the checkbox filter). */
const rating = (id: string, title: string, short: string, field: string, bucketField: string): ColumnDef => ({
  id, title, short, category: "technicals", align: "left", fmt: "rating", width: 110, field, filterField: bucketField,
  filter: { type: "CheckboxGroup", options: [["StrongBuy", "Strong buy"], ["Buy", "Buy"], ["Neutral", "Neutral"], ["Sell", "Sell"], ["StrongSell", "Strong sell"]] },
});
/** An oscillator column (the reference filter: any comparison with a value or the same column; `targets`: the other
 *  columns it compares with too). */
const oscillator = (id: string, title: string, short: string, params: ParamDef[], presets?: Preset[], targets: string[] = [id]): ColumnDef => ({
  id, title, short, category: "technicals", align: "right", fmt: "number", width: 86, params,
  filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "aboveOrEqual", targets: [["value", ...targets]], presets },
});
/** A technical drawn over the price (moving average, band, stop, pivot level): a price compared with the prices and
 *  the other such lines. */
const priceLine = (id: string, title: string, short: string, params: ParamDef[], targets: string[][], presets?: Preset[]): ColumnDef => ({
  id, title, short, category: "technicals", align: "right", fmt: "price", width: 99, params,
  filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "aboveOrEqual", targets, presets },
});

// Price-like right-hand targets (the reference app groups: Value | Open High Low Price | the moving averages and bands
// | the pivot points | the extended-hours prices).
const EXT_PRICES = ["PostMarketHigh", "PostMarketLow", "PostMarketOpen", "PostMarketClose", "PreMarketHigh", "PreMarketLow", "PreMarketOpen", "PreMarketClose"];
const OHLP = ["Open", "High", "Low", "Price"];
const PRICE_LINES = ["BollingerBands", "DonchianChannels", "Ema", "HullMovingAverage", "IchimokuCloud", "KeltnerChannels", "Ma", "Psar",
  "VolumeWeightedAveragePrice", "VolumeWeightedMovingAverage"];
const PIVOTS = ["PivotCamarilla", "PivotClassic", "PivotDemark", "PivotFibonacci", "PivotWoodie"];
const PRICE_TARGETS = (self: string) => [["value"], OHLP.filter((x) => x !== self), PRICE_LINES, PIVOTS, EXT_PRICES.filter((x) => x !== self)];
/** The targets of the bands and lines (Bollinger Bands and Hull MA also take the pivot points) and of a pivot level. */
const LINE_TARGETS = [["value"], OHLP, PRICE_LINES];
const LINE_PIVOT_TARGETS = [...LINE_TARGETS, PIVOTS];
const PIVOT_TARGETS = [["value"], OHLP, ["BollingerBands", "Ema", "HullMovingAverage", "Ma"]];
/** The right-hand targets of the percent changes (the reference Change filter's list). */
const CHANGE_TARGETS = [["value", "ChangeFromOpen", "Gap", "PostMarketChange", "PreMarketChange", "PreMarketChangeFromOpen", "PreMarketGap", "Change"]];
const ALL_OPS: Operation[] = ["above", "aboveOrEqual", "below", "belowOrEqual", "between", "outside", "equal"];
const CHANGE_OPS: Operation[] = ["above", "below", "between", "outside", "equal"];


/** Indexes of the reference app Index filter that have a data source, in its
 *  order (code, name). The other 44 (sector, bank and world indexes) have none. */
export const INDEXES: [code: string, name: string][] = [
  ["SPX", "S&P 500"],
  ["NDX", "NASDAQ 100"],
  ["IXIC", "NASDAQ Composite"],
  ["RUT", "Russell 2000"],
  ["DJI", "Dow Jones Industrial Average"],
  ["RUA", "Russell 3000"],
  ["RUI", "Russell 1000"],
];
const INDEX_NAME: Record<string, string> = Object.fromEntries(INDEXES);
/** "SPX,NDX" → "S&P 500, NASDAQ 100" (the Index cell). */
const indexNames = (raw: string) => raw.split(",").map((c) => INDEX_NAME[c] ?? c).join(", ");

/** The reference's New high / New low filter (a filter only): the period's high (low) is today's. Its All Time
 *  option has no data source (the history holds 5 years). */
const NEW_EXTREME_FIELDS: Record<"High" | "Low", Record<string, string>> = {
  High: { month_1: "High.1M", month_3: "High.3M", month_6: "High.6M", weeks_52: "price_52_week_high" },
  Low: { month_1: "Low.1M", month_3: "Low.3M", month_6: "Low.6M", weeks_52: "price_52_week_low" },
};
function newExtreme(id: string, title: string, kind: "High" | "Low"): ColumnDef {
  const fields = NEW_EXTREME_FIELDS[kind];
  return {
    id, title, short: title, category: "marketData", align: "left", fmt: "text", width: 90, field: fields.month_1, noColumn: true,
    filter: { type: "CheckboxGroup", single: true, options: [["month_1", "1 month"], ["month_3", "3 months"], ["month_6", "6 months"], ["weeks_52", "52 weeks"]],
      clauses: ([v]) => (fields[v] ? [{ left: fields[v], operation: kind === "High" ? "eless" : "egreater", right: kind === "High" ? "high" : "low" }] : []) },
  };
}
/** The reference's symbol types as the reference list's security types (structured products are its preferreds:
 *  55 of 62 on 26/11/2026). */
const SYMBOL_TYPES: Record<string, string[]> = { CommonStock: ["stock"], PreferredStock: ["preferred", "structured"], DepositaryReceipt: ["adr"] };
/** One listing per company: the rule of the market pill's "Primary listing" (screener-query's universe), with the
 *  funds of the ETF Screener. */
const PRIMARY_TYPES = ["stock", "adr", "fund", "etf", "etn", "etv"];

// ── Fundamentals (state keys `f.*`, see the backend's fields.rs) ─────────────
const FP_LABEL = { ttm: ["Trailing 12 months", "TTM"], fy: ["Annual", "FY"], fq: ["Quarterly", "FQ"], current: ["Current", "Current"] } as const;
/** A fiscal period param: each option one field. */
const FP = (...opts: [period: keyof typeof FP_LABEL, field: string][]): ParamDef[] => [
  { key: "fiscalPeriod", title: "Fiscal period", default: opts[0][0], options: opts.map(([v, field]) => ({ value: v, label: FP_LABEL[v][0], short: FP_LABEL[v][1], field })) },
];
/** A growth period param ("TTM YoY" or "Annual YoY"). */
const YOY = (v: "YoYTTM" | "YoYAnnual", field: string): ParamDef[] => {
  const label = v === "YoYTTM" ? "TTM YoY" : "Annual YoY";
  return [{ key: "period", title: "Period", default: v, options: [{ value: v, label, short: label, field }] }];
};
/** A number filter (the reference filter configs of these columns were not captured: no presets). */
const NUM_FILTER: ColumnDef["filter"] = { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value"]] };
const fund = (id: string, title: string, short: string, category: Category, fmt: Fmt, source: string | ParamDef[], financial?: boolean): ColumnDef => ({
  id,
  title,
  short,
  category,
  fmt,
  financial,
  align: fmt === "text" ? "left" : "right",
  width: fmt === "money" || fmt === "price" ? 110 : 90,
  ...(typeof source === "string" ? { field: source } : { params: source }),
  ...(fmt === "text" || fmt === "date" ? {} : { filter: NUM_FILTER }),
});
/** The reference app Date filter of the recent earnings date: day ranges relative to today in New York, calendar
 *  days, weeks from Monday (its scanner's in_day_range / in_week_range / in_month_range, measured 23/11/2026). */
export const RELATIVE_DATES: Record<string, { unit: "day" | "week" | "month" | "year"; from: number; to: number }> = {
  Today: { unit: "day", from: 0, to: 0 },
  Yesterday: { unit: "day", from: -1, to: -1 },
  Previous5Days: { unit: "day", from: -5, to: -1 },
  ThisWeek: { unit: "week", from: 0, to: 0 },
  PreviousWeek: { unit: "week", from: -1, to: -1 },
  ThisMonth: { unit: "month", from: 0, to: 0 },
  // The IPO offer date's ranges (the reference's day counts; "More than 5 years ago" counts 3,652 days as it does).
  ThisYear: { unit: "year", from: 0, to: 0 },
  Past3Months: { unit: "day", from: -91, to: -1 },
  Past6Months: { unit: "day", from: -183, to: -1 },
  Past12Months: { unit: "day", from: -366, to: -1 },
  Past2Years: { unit: "day", from: -731, to: -1 },
  Past3Years: { unit: "day", from: -1096, to: -1 },
  Past5Years: { unit: "day", from: -1827, to: -1 },
  Below1YearAgo: { unit: "day", from: -9999999, to: -366 },
  Below5YearsAgo: { unit: "day", from: -9999999, to: -3652 },
  Below10YearsAgo: { unit: "day", from: -9999999, to: -3653 },
  Below15YearsAgo: { unit: "day", from: -9999999, to: -5479 },
  Below20YearsAgo: { unit: "day", from: -9999999, to: -7306 },
  Below25YearsAgo: { unit: "day", from: -9999999, to: -9132 },
};
const FUNDAMENTALS: ColumnDef[] = [
  // Security info
  { id: "EarningsRecent", title: "Recent earnings date", short: "Recent earnings date", category: "securityInfo", align: "right", fmt: "date",
    width: 90, field: "f.earnings_recent", filter: { type: "CheckboxGroup", single: true, relativeDate: true, options: [
      ["Today", "Current trading day"], ["Yesterday", "Previous day"], ["Previous5Days", "Previous 5 days"], ["ThisWeek", "This week"],
      ["PreviousWeek", "Previous week"], ["ThisMonth", "This month"]] } },
  fund("RecentFiscalPeriod", "Recent fiscal period", "Fiscal period", "securityInfo", "text", FP(["current", "f.fiscal_period"])),
  fund("FiscalPeriodEndDate", "Fiscal period end date", "Fiscal period end", "securityInfo", "date", FP(["current", "f.fiscal_period_end"])),
  // Financials: income statement, balance sheet, cash flow
  fund("TotalRevenue", "Total revenue", "Revenue", "financials", "money", FP(["ttm", "f.revenue_ttm"], ["fy", "f.revenue_fy"]), true),
  fund("GrossProfit", "Gross profit", "Gross profit", "financials", "money", FP(["ttm", "f.gross_profit_ttm"]), true),
  fund("OperatingIncome", "Operating income", "Op income", "financials", "money", FP(["ttm", "f.operating_income_ttm"]), true),
  fund("NetIncome", "Net income", "Net income", "financials", "money", FP(["ttm", "f.net_income_ttm"]), true),
  fund("Ebitda", "EBITDA", "EBITDA", "financials", "money", FP(["ttm", "f.ebitda_ttm"]), true),
  fund("EpsDiluted", "Earnings per share diluted", "EPS dil", "financials", "price", FP(["ttm", "f.eps_dil_ttm"]), true),
  fund("BasicEps", "Basic earnings per share", "EPS basic", "financials", "price", FP(["ttm", "f.eps_basic_ttm"]), true),
  fund("TotalAssets", "Total assets", "Total assets", "financials", "money", FP(["fq", "f.total_assets_fq"]), true),
  fund("TotalCurrentAssets", "Total current assets", "Current assets", "financials", "money", FP(["fq", "f.current_assets_fq"]), true),
  fund("CashNShortTermInvest", "Cash and short-term investments", "Cash on hand", "financials", "money", FP(["fq", "f.cash_fq"]), true),
  fund("TotalLiabilities", "Total liabilities", "Total liabilities", "financials", "money", FP(["fq", "f.total_liabilities_fq"]), true),
  fund("TotalDebt", "Total debt", "Total debt", "financials", "money", FP(["fq", "f.total_debt_fq"]), true),
  fund("NetDebt", "Net debt", "Net debt", "financials", "money", FP(["fq", "f.net_debt_fq"]), true),
  fund("TotalEquity", "Total equity", "Total equity", "financials", "money", FP(["fq", "f.total_equity_fq"]), true),
  fund("CashFromOperating", "Cash flow from operating activities", "Operating CF", "financials", "money", FP(["ttm", "f.cfo_ttm"]), true),
  fund("CashFromInvesting", "Cash flow from investing activities", "Investing CF", "financials", "money", FP(["ttm", "f.cfi_ttm"]), true),
  fund("CashFromFinancing", "Cash flow from financing activities", "Financing CF", "financials", "money", FP(["ttm", "f.cff_ttm"]), true),
  fund("FreeCashFlow", "Free cash flow", "FCF", "financials", "money", FP(["ttm", "f.fcf_ttm"]), true),
  fund("CapitalExpenditures", "Capital expenditures", "CapEx", "financials", "money", FP(["ttm", "f.capex_ttm"]), true),
  // Valuation (price ratios computed with the live price)
  fund("PriceToEarnings", "Price to earnings ratio", "P/E", "valuation", "number", "f.pe"),
  fund("PriceToEarningsToGrowth", "Price to earning to growth", "PEG", "valuation", "number", FP(["ttm", "f.peg"])),
  fund("PriceToSales", "Price to sales ratio", "P/S", "valuation", "number", "f.ps"),
  fund("PriceToBook", "Price to book ratio", "P/B", "valuation", "number", "f.pb"),
  fund("PriceToCashFlow", "Price to cash flow ratio", "P/CF", "valuation", "number", "f.pcf"),
  fund("PriceToFreeCashFlow", "Price to free cash flow ratio", "P/FCF", "valuation", "number", "f.pfcf"),
  fund("PriceToCashRatio", "Price to cash ratio", "Price/cash", "valuation", "number", "f.pcash"),
  fund("Ev", "Enterprise value", "EV", "valuation", "money", "f.ev", true),
  fund("EvToRevenue", "Enterprise value to revenue ratio", "EV/revenue", "valuation", "number", FP(["ttm", "f.ev_revenue"])),
  fund("EvToEbit", "Enterprise value to EBIT ratio", "EV/EBIT", "valuation", "number", FP(["ttm", "f.ev_ebit"])),
  fund("EvToEbitda", "Enterprise value to EBITDA ratio", "EV/EBITDA", "valuation", "number", FP(["ttm", "f.ev_ebitda"])),
  fund("MarketCapPerf", "Market capitalization performance %", "Mkt cap perf %", "valuation", "change",
    [{ key: "interval", title: "Date Range", default: "Interval1Y", options: [{ value: "Interval1Y", label: "1 year", short: "1Y", field: "f.market_cap_perf_1y" }] }]),
  // Growth
  fund("RevenueGrowth", "Revenue growth %", "Revenue growth", "growth", "change", YOY("YoYTTM", "f.revenue_growth_ttm_yoy")),
  fund("EpsDilutedGrowth", "Earnings per share diluted growth %", "EPS dil growth", "growth", "change", YOY("YoYTTM", "f.eps_dil_growth_ttm_yoy")),
  fund("EbitdaGrowth", "EBITDA growth %", "EBITDA growth %", "growth", "change", YOY("YoYTTM", "f.ebitda_growth_ttm_yoy")),
  fund("TotalDebtGrowth", "Total debt growth %", "Total debt growth %", "growth", "change", YOY("YoYAnnual", "f.total_debt_growth_fy_yoy")),
  // Margins and ratios
  fund("GrossMargin", "Gross margin %", "Gross margin", "margins", "percent", FP(["ttm", "f.gross_margin_ttm"])),
  fund("OperatingMargin", "Operating margin %", "Op margin %", "margins", "percent", FP(["ttm", "f.operating_margin_ttm"])),
  fund("PreTaxMargin", "Pretax margin %", "Pretax margin", "margins", "percent", FP(["ttm", "f.pretax_margin_ttm"])),
  fund("NetMargin", "Net margin %", "Net margin %", "margins", "percent", FP(["ttm", "f.net_margin_ttm"])),
  fund("FreeCashFlowMargin", "Free cash flow margin %", "FCF margin", "margins", "percent", FP(["ttm", "f.fcf_margin_ttm"])),
  fund("ReturnOnAssets", "Return on assets %", "ROA", "margins", "percent", FP(["ttm", "f.roa_ttm"], ["fy", "f.roa_fy"])),
  fund("ReturnOnEquity", "Return on equity %", "ROE", "margins", "percent", FP(["ttm", "f.roe_ttm"], ["fy", "f.roe_fy"])),
  fund("ReturnOnInvestedCapital", "Return on invested capital %", "ROIC", "margins", "percent", FP(["ttm", "f.roic_ttm"], ["fy", "f.roic_fy"])),
  fund("ResearchNDevelopmentRatio", "Research and development ratio", "R&D ratio", "margins", "percent", FP(["ttm", "f.rnd_ratio_ttm"])),
  fund("SellingGeneralNAdminExpensesRatio", "Selling, general, and admin expenses ratio", "SG&A ratio", "margins", "percent", FP(["ttm", "f.sga_ratio_ttm"])),
  fund("CurrentRatio", "Current ratio", "Current ratio", "margins", "number", FP(["fq", "f.current_ratio_fq"])),
  fund("QuickRatio", "Quick ratio", "Quick ratio", "margins", "number", FP(["fq", "f.quick_ratio_fq"])),
  fund("DebtToEquityRatio", "Debt to equity ratio", "Debt/equity", "margins", "number", FP(["fq", "f.debt_to_equity_fq"])),
  fund("CashToDebt", "Cash to debt ratio", "Cash/debt", "margins", "number", FP(["fq", "f.cash_to_debt_fq"])),
  fund("RevenuePerShare", "Revenue per share", "Revenue per share", "margins", "price", FP(["ttm", "f.revenue_ps_ttm"]), true),
  fund("OperatingCashFlowPerShare", "Operating cash flow per share", "Op cash flow per share", "margins", "price", FP(["ttm", "f.ocf_ps_ttm"]), true),
  fund("FreeCashFlowPerShare", "Free cash flow per share", "FCF per share", "margins", "price", FP(["ttm", "f.fcf_ps_ttm"]), true),
  fund("EBITPerShare", "EBIT per share", "EBIT per share", "margins", "price", FP(["ttm", "f.ebit_ps_ttm"]), true),
  fund("EBITDAPerShare", "EBITDA per share", "EBITDA per share", "margins", "price", FP(["ttm", "f.ebitda_ps_ttm"]), true),
  fund("BookPerShare", "Book value per share", "Book per share", "margins", "price", FP(["fq", "f.book_ps_fq"]), true),
  fund("TotalDebtPerShare", "Total debt per share", "Total debt per share", "margins", "price", FP(["fq", "f.debt_ps_fq"]), true),
  fund("CashPerShare", "Cash per share", "Cash per share", "margins", "price", FP(["fq", "f.cash_ps_fq"]), true),
  fund("RevenuePerEmployee", "Revenue per employee", "Revenue/employees", "margins", "money", FP(["fy", "f.revenue_per_employee_fy"]), true),
  fund("NumberOfEmployees", "Number of employees", "Employees", "margins", "volume", FP(["fy", "f.employees"])),
  // Dividends
  fund("DividendsPerShare", "Dividends per share", "Div per share", "dividends", "price", FP(["fy", "f.dps_fy"], ["fq", "f.dps_fq"]), true),
  fund("DividendsYieldForward", "Dividend yield % (indicated)", "Div yield % (indicated)", "dividends", "percent", "f.div_yield_indicated"),
  fund("DividendPayoutRatio", "Dividend payout ratio %", "Div payout ratio %", "dividends", "percent", FP(["ttm", "f.payout_ratio_ttm"])),
  fund("DividendsPerShareGrowth", "Dividends per share growth %", "DPS growth %", "dividends", "change", YOY("YoYAnnual", "f.dps_growth_fy_yoy")),
  fund("ContinuousDivPayout", "Continuous dividend payout", "Cont div payout", "dividends", "integer", "f.cont_div_payout"),
  fund("ContinuousDivGrowth", "Continuous dividend growth", "Cont div growth", "dividends", "integer", "f.cont_div_growth"),
];

// ── More fundamentals (#415): the reference columns, params and filter configs (its screener's column and filter
// configs, 26/11/2026). Options its scanner leaves empty (the TTM of the turnover and return-on-capital ratios) and
// half-year ones are left out. ─────────────────────────────────────────────────────────────────────────────────────
/** A fiscal period param with its default (the options in the reference order). */
const FPD = (def: keyof typeof FP_LABEL, ...opts: [period: keyof typeof FP_LABEL, field: string][]): ParamDef[] => [
  { ...FP(...opts)[0], default: def },
];
const GROWTH_LABEL = { YoYTTM: "TTM YoY", YoYAnnual: "Annual YoY", YoYQuaterly: "Quarterly YoY", QoQQuaterly: "Quarterly QoQ", FiveYCAGR: "5 year CAGR" } as const;
/** A growth period param: each option one field, the first the default. */
const GROWTH = (...opts: [period: keyof typeof GROWTH_LABEL, field: string][]): ParamDef[] => [
  { key: "period", title: "Period", default: opts[0][0], options: opts.map(([v, field]) => ({ value: v, label: GROWTH_LABEL[v], short: GROWTH_LABEL[v], field })) },
];
/** The reference filter configs: compared with a value or the column itself (other params), a value only, or a range
 *  only. */
const selfFilter = (id: string, ...more: string[]): ColumnDef["filter"] => ({ ...NUM_FILTER, targets: [["value", ...more, id]] } as ColumnDef["filter"]);
const RANGE_FILTER: ColumnDef["filter"] = { type: "Condition", operations: ["between"], defaultOperation: "between", targets: [["value"]] };
const more = (filter: ColumnDef["filter"] | "self", id: string, title: string, short: string, category: Category, fmt: Fmt,
  source: string | ParamDef[], financial?: boolean): ColumnDef => ({
  ...fund(id, title, short, category, fmt, source, financial),
  filter: filter === "self" ? selfFilter(id) : filter,
});
/** Growth options: TTM, annual, quarterly YoY, quarterly QoQ (`f.<key>_growth_<period>`). */
const growthOf = (key: string, ttm = true): [keyof typeof GROWTH_LABEL, string][] => [
  ...(ttm ? [["YoYTTM", `f.${key}_growth_ttm_yoy`] as [keyof typeof GROWTH_LABEL, string]] : []),
  ["YoYAnnual", `f.${key}_growth_fy_yoy`],
  ["YoYQuaterly", `f.${key}_growth_fq_yoy`],
  ["QoQQuaterly", `f.${key}_growth_fq_qoq`],
];
/** The quarter and year options of a balance (`f.<key>_fq`, `f.<key>_fy`). */
const fqfy = (key: string, def: "fq" | "fy") => FPD(def, ["fq", `f.${key}_fq`], ["fy", `f.${key}_fy`]);
/** The year and trailing twelve months options of a ratio (`f.<key>_fy`, `f.<key>_ttm`). */
const fyttm = (key: string, def: "fy" | "ttm") => FPD(def, ["fy", `f.${key}_fy`], ["ttm", `f.${key}_ttm`]);
/** The quarter, year and trailing twelve months options of an amount. */
const fqfyttm = (key: string) => FPD("fy", ["fq", `f.${key}_fq`], ["fy", `f.${key}_fy`], ["ttm", `f.${key}_ttm`]);
const MORE_FUNDAMENTALS: ColumnDef[] = [
  // Financials
  more("self", "CashNEquivalents", "Cash and equivalents", "Cash and equivalents", "financials", "money", fqfy("cash_eq", "fy"), true),
  more("self", "Goodwill", "Goodwill (net)", "Goodwill", "financials", "money", fqfy("goodwill", "fq"), true),
  more("self", "LTDebt", "Long-term debt", "LT debt", "financials", "money", fqfy("lt_debt", "fy"), true),
  more("self", "STDebt", "Short-term debt", "ST debt", "financials", "money", fqfy("st_debt", "fy"), true),
  more("self", "ResearchNDevelopment", "Research and development", "R&D", "financials", "money", fqfyttm("rnd"), true),
  more("self", "TotalCurrentLiabilities", "Total current liabilities", "Current liabilities", "financials", "money", fqfy("current_liabilities", "fq"), true),
  more("self", "NetIncomeFromContinuingOperations", "Net income from continuing operations", "Net income cont. ops", "financials", "money", fqfyttm("income_cont"), true),
  more("self", "NetRevenue", "Net revenue", "Net revenue", "financials", "money", fqfyttm("net_revenue"), true),
  more("self", "NetRevenueAfterProvision", "Net revenue after provision", "Net revenue after provision", "financials", "money", fqfyttm("net_revenue_ap"), true),
  // Valuation (with the live price)
  more(NUM_FILTER, "EvToFreeCashFlow", "Enterprise value to free cash flow", "EV/FCF", "valuation", "number", FP(["ttm", "f.ev_fcf"])),
  more(NUM_FILTER, "EvToGrossProfit", "Enterprise value to gross profit ratio", "EV / gross profit", "valuation", "number", FP(["ttm", "f.ev_gross_profit"])),
  more(RANGE_FILTER, "PriceToNetWorkingCapital", "Price to net working capital", "P/NWC", "valuation", "number", "f.price_wc"),
  more(RANGE_FILTER, "EarningsYield", "Earnings yield %", "Earnings yield %", "valuation", "percent", FP(["ttm", "f.earnings_yield"])),
  // Growth
  more("self", "FreeCashFlowGrowth", "Free cash flow growth %", "FCF growth", "growth", "change", GROWTH(...growthOf("fcf"), ["FiveYCAGR", "f.fcf_cagr_5y"])),
  more("self", "GrossProfitGrowth", "Gross profit growth %", "Gross profit growth", "growth", "change", GROWTH(...growthOf("gross_profit"))),
  more("self", "NetIncomeGrowth", "Net income growth %", "Net income growth %", "growth", "change", GROWTH(...growthOf("net_income"), ["FiveYCAGR", "f.net_income_cagr_5y"])),
  more("self", "TotalAssetsGrowth", "Total assets growth %", "Total assets growth", "growth", "change", GROWTH(...growthOf("total_assets", false))),
  more("self", "CapexGrowth", "Capital expenditures growth %", "CapEx growth", "growth", "change", GROWTH(...growthOf("capex"))),
  // Margins & ratios
  more("self", "AltmanZScore", "Altman Z-score", "Alt Z-score", "margins", "number", fyttm("altman", "fy")),
  more("self", "CashRatio", "Cash ratio", "Cash ratio", "margins", "number", fqfy("cash_ratio", "fy")),
  more("self", "DebtToEbitda", "Debt to EBITDA ratio", "Debt/EBITDA", "margins", "number", fqfy("debt_ebitda", "fy")),
  more("self", "DebtToRevenueRatio", "Debt to revenue ratio", "Debt to revenue ratio", "margins", "number", fyttm("debt_revenue", "fy")),
  more("self", "EquityToAsset", "Equity to assets ratio", "Equity/assets", "margins", "number", fqfy("equity_assets", "fy")),
  more("self", "EBITDAMargin", "EBITDA margin %", "EBITDA margin %", "margins", "percent", fyttm("ebitda_margin", "fy")),
  more("self", "EffectiveInterestRateOnDebt", "Effective interest rate on debt %", "Effective int rate on debt %", "margins", "percent", fyttm("eff_interest_rate", "fy")),
  more("self", "FixedAssetsTurnover", "Fixed assets turnover", "Fixed assets turn", "margins", "number", FP(["fy", "f.fixed_assets_turnover_fy"])),
  more("self", "FScore", "Piotroski F-score", "F-score", "margins", "integer", fyttm("fscore", "fy")),
  more(selfFilter("GrahamsNumber", "Price"), "GrahamsNumber", "Graham's number", "Graham's number", "margins", "price", fyttm("graham", "fy"), true),
  more(RANGE_FILTER, "EbitdaPerEmployee", "EBITDA per employee", "EBITDA/employees", "margins", "money", FP(["fy", "f.ebitda_per_employee_fy"]), true),
  more(RANGE_FILTER, "FreeCashFlowPerEmployee", "Free cash flow per employee", "FCF/employees", "margins", "money", FP(["fy", "f.fcf_per_employee_fy"]), true),
  more(RANGE_FILTER, "NetIncomePerEmployee", "Net income per employee", "Net income / employees", "margins", "money", FP(["fy", "f.net_income_per_employee_fy"]), true),
  more(RANGE_FILTER, "OperatingIncomePerEmployee", "Operating income per employee", "Op income / employees", "margins", "money", FP(["fy", "f.operating_income_per_employee_fy"]), true),
  more(RANGE_FILTER, "ResearchNDevelopmentPerEmployee", "Research and development per employee", "R&D/employees", "margins", "money", FP(["fy", "f.rnd_per_employee_fy"]), true),
  more(RANGE_FILTER, "TotalAssetsPerEmployee", "Total assets per employee", "Total assets / employees", "margins", "money", FP(["fy", "f.total_assets_per_employee_fy"]), true),
  more(RANGE_FILTER, "TotalDebtPerEmployee", "Total debt per employee", "Total debt / employees", "margins", "money", FP(["fy", "f.total_debt_per_employee_fy"]), true),
  more("self", "ReturnOnCapitalEmployed", "Return on capital employed %", "ROCE", "margins", "percent", FP(["fy", "f.roce_fy"])),
  more("self", "DebtToAssets", "Debt to assets ratio", "Debt/assets", "margins", "number", fqfy("debt_assets", "fy")),
  more("self", "ReturnOnTangibleEquity", "Return on tangible equity %", "ROTE", "margins", "percent", FP(["fy", "f.rote_fy"])),
  more("self", "ReturnOnTangibleAssets", "Return on tangible assets %", "ROTA", "margins", "percent", FP(["fy", "f.rota_fy"])),
  more("self", "ReturnOnTotalCapital", "Return on total capital %", "ROTC", "margins", "percent", FP(["fy", "f.rotc_fy"])),
  more("self", "AssetsTurnover", "Asset turnover", "Asset turnover", "margins", "number", FP(["fy", "f.asset_turnover_fy"])),
  more("self", "InventoryTurnover", "Inventory turnover", "Inventory turn", "margins", "number", FP(["fy", "f.inventory_turnover_fy"])),
  more("self", "ReceivablesTurnover", "Total receivables turnover", "Receivables turn", "margins", "number", FP(["fy", "f.receivables_turnover_fy"])),
  more("self", "CashDividendCoverageRatio", "Cash dividend coverage ratio", "Cash DCR", "margins", "number", fyttm("cash_div_coverage", "ttm")),
  more("self", "InterestCoverage", "Interest coverage", "Int coverage", "margins", "number", fyttm("interest_coverage", "ttm")),
  more("self", "NetDebtToEbitda", "Net debt to EBITDA ratio", "Net debt / EBITDA", "margins", "number", FP(["fy", "f.net_debt_ebitda_fy"])),
  more("self", "EbitdaInterestCoverage", "EBITDA interest coverage", "EBITDA interest coverage", "margins", "number", fyttm("ebitda_interest_coverage", "ttm")),
  more("self", "EbitdaLessCapexInterestCoverage", "EBITDA less CapEx interest coverage", "EBITDA less CapEx int cov", "margins", "number",
    fyttm("ebitda_capex_interest_coverage", "ttm")),
  more("self", "TotalDebtToCapital", "Total debt to capital", "Debt/capital", "margins", "number", fqfy("debt_capital", "fy")),
  more(NUM_FILTER, "BuybackYield", "Buyback yield %", "Buyback yield %", "margins", "percent", "f.buyback_yield"),
  more("self", "SloanRatio", "Sloan ratio %", "Sloan ratio %", "margins", "percent", fyttm("sloan", "fy")),
  more("self", "SharesBuyback", "Shares buyback ratio %", "Shares buyback ratio %", "margins", "percent", fqfy("buyback_ratio", "fy")),
  // The reference's TTM sustainable growth rate and ROE adjusted to book are its fiscal year values.
  more("self", "SustainableGrowthRate", "Sustainable growth rate", "Sustainable growth rate", "margins", "percent", FPD("fy", ["fy", "f.sgr_fy"], ["ttm", "f.sgr_fy"])),
  more("self", "ReturnOnCommonEquity", "Return on common equity %", "ROE (common)", "margins", "percent", fyttm("return_common_equity", "fy")),
  more("self", "ROEAdjustedToBook", "Return on equity adjusted to book value %", "ROE adjusted to book", "margins", "percent",
    FPD("fy", ["fy", "f.roe_adj_book_fy"], ["ttm", "f.roe_adj_book_fy"])),
  more("self", "TobinsQ", "Tobin's Q (approximate)", "Tobin's Q", "margins", "number", fqfy("tobin_q", "fy")),
  more("self", "NCAVPS", "Net current asset value per share", "NCAVPS", "margins", "price", fqfy("ncavps", "fq"), true),
  more("self", "TangibleBookPerShare", "Tangible book value per share", "Tangible book per share", "margins", "price", fqfy("tangible_book_ps", "fq"), true),
  more("self", "WorkingCapitalPerShare", "Working capital per share", "Working capital per share", "margins", "price", fqfy("wc_ps", "fq"), true),
  more("self", "CapExPerShare", "Capital expenditures per share", "CapEx per share", "margins", "price",
    FPD("ttm", ["fq", "f.capex_ps_fq"], ["fy", "f.capex_ps_fy"], ["ttm", "f.capex_ps_ttm"]), true),
  more("self", "ZmijewskiScore", "Zmijewski score", "Zmijewski score", "margins", "number", fyttm("zmijewski", "fy")),
  // Dividends
  more("self", "DividendsPaid", "Total cash dividends paid", "Div paid", "dividends", "money", fqfyttm("dividends_paid"), true),
];

// ── Technicals: params and presets of the indicator columns ─────────────────
const R1D_PARAM = { resolution: "TimeResolution1D" };
/** A length param, each length with its field ("" when the field comes from the column's other params). */
const LENGTHS = (opts: [length: string, field: string][], def = opts[0][0]): ParamDef => ({
  key: "length", title: "Length", default: def, options: opts.map(([v, field]) => ({ value: v, label: v, short: v, field })),
});
/** The reference's one set of inputs ("Macd:12_26", shown "12,26"). */
const INPUTS = (id: string, inputs: string, field = ""): ParamDef => {
  const label = inputs.split("_").join(",");
  return { key: "inputsGroup", title: "Inputs", default: `${id}:${inputs}`, options: [{ value: `${id}:${inputs}`, label, short: label, field }] };
};
/** Which line of the indicator a column shows (the field comes from `fieldOfParams`). */
const PLOT = (id: string, opts: { plot: string; label: string }[]): ParamDef => ({
  key: "plot", title: "Plot", default: `${id}:${opts[0].plot}`,
  options: opts.map((o) => ({ value: `${id}:${o.plot}`, label: o.label, short: o.label, field: "" })),
});
const BANDS_PLOT = (id: string) => PLOT(id, [{ plot: "Upper", label: "Upper" }, { plot: "Basis", label: "Basis" }, { plot: "Lower", label: "Lower" }]);
/** The scanner's name of a band plot ("BollingerBands:Lower" → "lower"). */
const bandKey = (plot: string) => (plot.endsWith(":Lower") ? "lower" : plot.endsWith(":Basis") ? "basis" : "upper");
const resOnly = (field: string): ParamDef[] => [{ ...RES_1D_ONLY, options: [{ ...RES_1D_ONLY.options[0], field }] }];
const DMI = (plot: string): ColumnRef => ({ id: "DirectionalMovementIndex", params: { ...R1D_PARAM, plot: `DirectionalMovementIndex:${plot}`, length: "14" } });
const AROON = (plot: string): ColumnRef => ({ id: "Aroon", params: { ...R1D_PARAM, plot: `Aroon:${plot}`, length: "14" } });
const BB_LOWER: ColumnRef = { id: "BollingerBands", params: { ...R1D_PARAM, plot: "BollingerBands:Lower", length: "20" } };
const SPAN_B: ColumnRef = { id: "IchimokuCloud", params: { ...R1D_PARAM, plot: "IchimokuCloud:SpanB", inputsGroup: "IchimokuCloud:9_26_52_26" } };
const SIGN_PRESETS: Preset[] = [
  { operation: "above", target: "value", right: { value: 0 }, ...d("Positive") },
  { operation: "below", target: "value", right: { value: 0 }, ...d("Negative") },
];
const TREND_PRESETS: Preset[] = [
  { operation: "below", target: "Price", right: { column: PRICE }, ...d("Uptrend") },
  { operation: "above", target: "Price", right: { column: PRICE }, ...d("Downtrend") },
];
/** Overbought / oversold %K and %D of a stochastic (80 / 20). */
const ZONE_PRESETS = (id: string, inputs: string, k: string, dd: string): Preset[] => {
  const left = (plot: string) => ({ plot: `${id}:${plot}`, inputsGroup: inputs });
  return [
    { operation: "above", target: "value", leftParams: left(k), right: { value: 80 }, ...d("Overbought (%K)") },
    { operation: "above", target: "value", leftParams: left(dd), right: { value: 80 }, ...d("Overbought (%D)") },
    { operation: "below", target: "value", leftParams: left(k), right: { value: 20 }, ...d("Oversold (%K)") },
    { operation: "below", target: "value", leftParams: left(dd), right: { value: 20 }, ...d("Oversold (%D)") },
  ];
};
/** The price above / below a pivot level (the reference presets, top level first). */
const PIVOT_ABOVE_TEXT: Record<string, string> = { R3: "Exit above R3", R2: "Above R2", R1: "Above R1", Middle: "Above pivot", S1: "Above S1", S2: "Above S2",
  S3: "Above S3" };
const PIVOT_BELOW_TEXT: Record<string, string> = { R3: "Below R3", R2: "Below R2", R1: "Below R1", Middle: "Below pivot", S1: "Below S1", S2: "Below S2",
  S3: "Exit below S3" };
const PIVOT_LEVELS: { level: string; label: string }[] = [
  { level: "Middle", label: "P" }, { level: "R1", label: "R1" }, { level: "R2", label: "R2" }, { level: "R3", label: "R3" },
  { level: "S1", label: "S1" }, { level: "S2", label: "S2" }, { level: "S3", label: "S3" },
];
/** A monthly pivot points column: its levels (DeMark: P, R1, S1), each a field `Pivot.M.<kind>.<level>`. */
const pivot = (id: string, title: string, short: string, kind: string): ColumnDef => {
  const levels = PIVOT_LEVELS.filter((l) => kind !== "Demark" || ["Middle", "R1", "S1"].includes(l.level));
  const order = ["R3", "R2", "R1", "Middle", "S1", "S2", "S3"].filter((l) => levels.some((x) => x.level === l));
  return priceLine(id, title, short, [
    { key: "level", title: "Level", default: "Middle",
      options: levels.map((l) => ({ value: l.level, label: l.label, short: l.label, field: `Pivot.M.${kind}.${l.level}` })) },
    RES_1D_ONLY,
  ], PIVOT_TARGETS, order.flatMap((lv): Preset[] => [
    { operation: "below", target: "Price", leftParams: { level: lv }, right: { column: PRICE }, description: PIVOT_ABOVE_TEXT[lv] },
    { operation: "above", target: "Price", leftParams: { level: lv }, right: { column: PRICE }, description: PIVOT_BELOW_TEXT[lv] },
  ]));
};

// ── Column catalog ────────────────────────────────────────────────────────
export const COLUMNS: ColumnDef[] = [
  // Security info
  { id: "Index", title: "Index", short: "Index", category: "securityInfo", align: "left", fmt: "text", width: 175, field: "indexes",
    filter: { type: "CheckboxGroup", options: INDEXES, codes: true, adaptive: true }, cellText: indexNames },
  { id: "Sector", title: "Sector", short: "Sector", category: "securityInfo", align: "left", fmt: "text", width: 175, field: "sector", filter: { type: "CheckboxGroup", options: "data" } },
  { id: "Industry", title: "Industry", short: "Industry", category: "securityInfo", align: "left", fmt: "text", width: 200, field: "industry", filter: { type: "CheckboxGroup", options: "data" } },
  { id: "Exchange", title: "Exchange", short: "Exchange", category: "securityInfo", align: "left", fmt: "text", width: 99, field: "exchange" },
  // Filters only, on the reference list's security type.
  { id: "SymbolType", title: "Symbol type", short: "Symbol type", category: "securityInfo", align: "left", fmt: "text", width: 120, field: "type", noColumn: true,
    filter: { type: "CheckboxGroup", adaptive: true, options: [["CommonStock", "Common stock"], ["PreferredStock", "Preferred stock"], ["DepositaryReceipt", "Depositary receipt"]],
      clauses: (values) => [{ left: "type", operation: "in_range", right: values.flatMap((v) => SYMBOL_TYPES[v] ?? []) }] } },
  // Share counts, free float, country, IPO (the gateway's security info, state keys `f.*`).
  { id: "TotalSharesOutstanding", title: "Total common shares outstanding", short: "Shares outstanding", category: "securityInfo", align: "right", fmt: "volume",
    width: 110, field: "f.shares_outstanding", filter: { type: "Condition", operations: ["between"], defaultOperation: "between", targets: [["value"]] } },
  { id: "SharesFloat", title: "Free float", short: "Float", category: "securityInfo", align: "right", fmt: "volume", width: 99, field: "f.float_shares",
    filter: { type: "Condition", operations: ["between"], defaultOperation: "between", targets: [["value"]], presets: [
      { operation: "between", target: "value", right: { left: 1e9, right: null } },
      { operation: "between", target: "value", right: { left: 1e8, right: 1e9 } },
      { operation: "between", target: "value", right: { left: 1e7, right: 1e8 } },
      { operation: "between", target: "value", right: { left: 1e6, right: 1e7 } },
      { operation: "between", target: "value", right: { left: null, right: 1e6 } },
    ] } },
  { id: "FloatShares", title: "Free float %", short: "Float %", category: "securityInfo", align: "right", fmt: "percent", width: 86, field: "f.float_percent",
    filter: { type: "Condition", operations: ["between"], defaultOperation: "between", targets: [["value"]] } },
  { id: "Country", title: "Country or region of registration", short: "Registration", category: "securityInfo", align: "left", fmt: "text", width: 150,
    field: "f.country", filter: { type: "CheckboxGroup", options: "data" } },
  { id: "IPOOfferDate", title: "IPO offer date", short: "IPO offer date", category: "securityInfo", align: "right", fmt: "date", width: 99, field: "f.ipo_date",
    filter: { type: "CheckboxGroup", single: true, relativeDate: true, options: [
      ["Today", "Current trading day"], ["Yesterday", "Previous day"], ["ThisWeek", "This week"], ["ThisMonth", "This month"], ["ThisYear", "This year"],
      ["Past3Months", "Past 3 months"], ["Past6Months", "Past 6 months"], ["Past12Months", "Past 12 months"], ["Past2Years", "Past 2 years"],
      ["Past3Years", "Past 3 years"], ["Past5Years", "Past 5 years"], ["Below1YearAgo", "More than 1 year ago"], ["Below5YearsAgo", "More than 5 years ago"],
      ["Below10YearsAgo", "More than 10 years ago"], ["Below15YearsAgo", "More than 15 years ago"], ["Below20YearsAgo", "More than 20 years ago"],
      ["Below25YearsAgo", "More than 25 years ago"]] } },
  { id: "IPODealAmount", title: "IPO deal amount", short: "IPO deal amount", category: "securityInfo", align: "right", fmt: "money", width: 110, field: "f.ipo_deal_amount",
    filter: { type: "Condition", operations: ["between"], defaultOperation: "between", targets: [["value"]] } },
  { id: "IPOOfferPrice", title: "IPO offer price", short: "IPO offer price", category: "securityInfo", align: "right", fmt: "price", width: 99, field: "f.ipo_price",
    filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "aboveOrEqual", targets: [["value", "High", "Low", "Open", "Price"]] } },
  { id: "IPOOfferPricePerformance", title: "Offer price performance %", short: "Offer price perf %", category: "securityInfo", align: "right", fmt: "change", width: 90,
    field: "f.ipo_price_perf", filter: { type: "Condition", operations: ["between"], defaultOperation: "between", targets: [["value"]] } },
  { id: "Listing", title: "Primary listing", short: "Primary listing", category: "securityInfo", align: "left", fmt: "text", width: 120, field: "type", noColumn: true,
    filter: { type: "CheckboxGroup", single: true, options: [["true", "Yes"]], clauses: () => [{ left: "type", operation: "in_range", right: PRIMARY_TYPES }] } },
  // Market data (regular hours)
  { id: "AverageVolume", title: "Average volume", short: "Avg vol", category: "marketData", align: "right", fmt: "volume", width: 90,
    params: [{ key: "interval", title: "Date Range", default: "Interval10D", options: [
      { value: "Interval10D", label: "10 days", short: "10D", field: "average_volume_10d_calc" },
      { value: "Interval30D", label: "30 days", short: "30D", field: "average_volume_30d_calc" },
      { value: "Interval60D", label: "60 days", short: "60D", field: "average_volume_60d_calc" },
      { value: "Interval90D", label: "90 days", short: "90D", field: "average_volume_90d_calc" },
    ] }],
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value", "Volume", "AverageVolume"]] } },
  { id: "Beta", title: "Beta", short: "Beta", category: "marketData", align: "right", fmt: "number", width: 74,
    params: [{ key: "interval", title: "Date Range", default: "Interval5Y", options: [
      { value: "Interval1Y", label: "1 year", short: "1Y", field: "beta_1_year" },
      { value: "Interval3Y", label: "3 years", short: "3Y", field: "beta_3_year" },
      { value: "Interval5Y", label: "5 years", short: "5Y", field: "beta_5_year" },
    ] }],
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value", "Beta"]], presets: [
      { operation: "above", target: "value", right: { value: 1.5 }, ...d("Very high volatility") },
      { operation: "between", target: "value", right: { left: 1.1, right: 1.5 }, ...d("High volatility") },
      { operation: "between", target: "value", right: { left: 0.9, right: 1.1 }, ...d("Near market volatility") },
      { operation: "between", target: "value", right: { left: 0.5, right: 0.9 }, ...d("Low volatility") },
      { operation: "between", target: "value", right: { left: 0, right: 0.5 }, ...d("Very low volatility") },
      { operation: "above", target: "value", right: { value: 0 }, ...d("Positive sensitivity") },
      { operation: "below", target: "value", right: { value: 0 }, ...d("Inverse sensitivity") },
    ] } },
  // 1h and 4h: the price against the close of the regular session's previous 1h / 4h bar (bars from 09:30).
  { id: "Change", title: "Price change %", short: "Chg %", category: "marketData", align: "right", fmt: "change", width: 80,
    params: [{ key: "resolution", title: "Interval", default: "TimeResolution1D", options: [
      { value: "TimeResolution60", label: "1 hour", short: "1h", field: "change|60" },
      { value: "TimeResolution240", label: "4 hours", short: "4h", field: "change|240" },
      { value: "TimeResolution1D", label: "1 day", short: "1D", field: "change" },
    ] }],
    filter: { type: "Condition", operations: CHANGE_OPS, defaultOperation: "above", targets: CHANGE_TARGETS, presets: BANDS } },
  { id: "ChangeAbs", title: "Price change", short: "Chg", category: "marketData", align: "right", fmt: "signedPrice", width: 86, params: RES_1D("change_abs"),
    filter: { type: "Condition", operations: CHANGE_OPS, defaultOperation: "above", targets: [["value"]], presets: [
      { operation: "below", target: "value", right: { value: 1 } },
      { operation: "between", target: "value", right: { left: 1, right: 10 } },
      { operation: "between", target: "value", right: { left: 10, right: 100 } },
      { operation: "above", target: "value", right: { value: 100 } },
    ] } },
  { id: "ChangeFromOpen", title: "Change from open %", short: "Chg from open %", category: "marketData", align: "right", fmt: "change", width: 90, params: RES_1D("change_from_open"),
    filter: { type: "Condition", operations: CHANGE_OPS, defaultOperation: "above", targets: [["value"]], presets: BANDS } },
  { id: "ChangeFromOpenAbs", title: "Change from open", short: "Chg from open", category: "marketData", align: "right", fmt: "signedPrice", width: 90,
    params: RES_1D("change_from_open_abs"), filter: { type: "Condition", operations: CHANGE_OPS, defaultOperation: "above",
      targets: [["value", "ChangeAbs", "PostMarketChangeAbs", "PreMarketChangeAbs", "PreMarketChangeFromOpenAbs", "ChangeFromOpenAbs"]], presets: [
        { operation: "below", target: "value", right: { value: 1 } },
        { operation: "between", target: "value", right: { left: 1, right: 10 } },
        { operation: "between", target: "value", right: { left: 10, right: 100 } },
        { operation: "above", target: "value", right: { value: 100 } },
      ] } },
  { id: "Gap", title: "Gap %", short: "Gap %", category: "marketData", align: "right", fmt: "change", width: 74, params: RES_1D("gap"),
    filter: { type: "Condition", operations: CHANGE_OPS, defaultOperation: "above", targets: [["value"]], presets: BANDS } },
  { id: "High", title: "High", short: "High", category: "marketData", align: "right", fmt: "price", width: 99,
    params: TIMEBASED({ "1D": "high", "1M": "High.1M", "3M": "High.3M", "6M": "High.6M", "52W": "price_52_week_high" }),
    filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "aboveOrEqual", targets: PRICE_TARGETS("High") } },
  { id: "Low", title: "Low", short: "Low", category: "marketData", align: "right", fmt: "price", width: 99,
    params: TIMEBASED({ "1D": "low", "1M": "Low.1M", "3M": "Low.3M", "6M": "Low.6M", "52W": "price_52_week_low" }),
    filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "aboveOrEqual", targets: PRICE_TARGETS("Low") } },
  newExtreme("NewHighSimplified", "New high", "High"),
  newExtreme("NewLowSimplified", "New low", "Low"),
  // A filter only: did the ticker trade in the latest session that opened.
  { id: "LastTradeTime", title: "Last trade time", short: "Last trade time", category: "marketData", align: "left", fmt: "text", width: 90, field: "active_symbol",
    noColumn: true, filter: { type: "CheckboxGroup", single: true, options: [["true", "Yes"], ["false", "No"]],
      clauses: ([v]) => [{ left: "active_symbol", operation: "equal", right: v === "true" ? 1 : 0 }] } },
  { id: "Open", title: "Open", short: "Open", category: "marketData", align: "right", fmt: "price", width: 99, params: RES_1D("open"),
    filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "aboveOrEqual", targets: PRICE_TARGETS("Open"), presets: [
      { operation: "below", target: "value", right: { value: 10 } },
      { operation: "between", target: "value", right: { left: 10, right: 100 } },
      { operation: "between", target: "value", right: { left: 100, right: 1000 } },
      { operation: "above", target: "value", right: { value: 1000 } },
      { operation: "above", target: "Ema", right: { column: EMA50 } },
      { operation: "above", target: "Ema", right: { column: EMA200 } },
      { operation: "below", target: "Ema", right: { column: EMA50 } },
      { operation: "below", target: "Ema", right: { column: EMA200 } },
    ] } },
  { id: "Performance", title: "Performance %", short: "Perf %", category: "marketData", align: "right", fmt: "change", width: 74,
    params: [{ key: "interval", title: "Date Range", default: "IntervalYTD", options: [
      { value: "Interval1W", label: "1 week", short: "1W", field: "Perf.W" },
      { value: "Interval1M", label: "1 month", short: "1M", field: "Perf.1M" },
      { value: "Interval3M", label: "3 months", short: "3M", field: "Perf.3M" },
      { value: "Interval6M", label: "6 months", short: "6M", field: "Perf.6M" },
      { value: "IntervalYTD", label: "Year to date", short: "YTD", field: "Perf.YTD" },
      { value: "Interval1Y", label: "1 year", short: "1Y", field: "Perf.Y" },
      { value: "Interval5Y", label: "5 years", short: "5Y", field: "Perf.5Y" },
      { value: "Interval10Y", label: "10 years", short: "10Y", field: "Perf.10Y" },
      { value: "IntervalAll", label: "All Time", short: "All Time", field: "Perf.All" },
    ] }],
    filter: { type: "Condition", operations: CHANGE_OPS, defaultOperation: "above", targets: [["value"]], presets: BANDS } },
  { id: "Price", title: "Price", short: "Price", category: "marketData", align: "right", fmt: "price", width: 99, field: "close",
    filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "aboveOrEqual", targets: PRICE_TARGETS("Price"), presets: [
      { operation: "above", target: "value", right: { value: 100 }, ...d("Fractional shares time") },
      { operation: "between", target: "value", right: { left: 10, right: 100 }, ...d("Mid-priced") },
      { operation: "belowOrEqual", target: "value", right: { value: 10 }, ...d("Not quite penny stocks") },
      { operation: "belowOrEqual", target: "value", right: { value: 5 }, ...d("Penny stocks") },
      { operation: "above", target: "Ema", right: { column: EMA50 }, ...d("Uptrend") },
      { operation: "below", target: "Ema", right: { column: EMA50 }, ...d("Downtrend") },
    ] } },
  { id: "VolumePrice", title: "Price × volume (turnover)", short: "Price × vol", category: "marketData", align: "right", fmt: "money", width: 99,
    params: RES_DWM("Value.Traded", "Value.Traded|1W", "Value.Traded|1M"),
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value"]], presets: [
      { operation: "above", target: "value", right: { value: 1e9 } },
      { operation: "above", target: "value", right: { value: 1e8 } },
      { operation: "above", target: "value", right: { value: 1e7 } },
      { operation: "below", target: "value", right: { value: 1e6 } },
    ] } },
  // The mean of each day's close × volume over the range, today included (the reference's value, though its title
  // says the price times the average volume).
  { id: "PriceAvgVolume", title: "Price × average volume", short: "Price × avg vol", category: "marketData", align: "right", fmt: "money", width: 99,
    params: [{ key: "interval", title: "Date Range", default: "Interval10D", options: [
      { value: "Interval10D", label: "10 days", short: "10D", field: "AvgValue.Traded_10d" },
      { value: "Interval30D", label: "30 days", short: "30D", field: "AvgValue.Traded_30d" },
      { value: "Interval60D", label: "60 days", short: "60D", field: "AvgValue.Traded_60d" },
      { value: "Interval90D", label: "90 days", short: "90D", field: "AvgValue.Traded_90d" },
    ] }],
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value", "PriceAvgVolume"]] } },
  { id: "Volatility", title: "Volatility", short: "Volatility", category: "marketData", align: "right", fmt: "percent", width: 86,
    params: [{ key: "interval", title: "Date Range", default: "Interval1D", options: [
      { value: "Interval1D", label: "1 day", short: "1D", field: "Volatility.D" },
      { value: "Interval1W", label: "1 week", short: "1W", field: "Volatility.W" },
      { value: "Interval1M", label: "1 month", short: "1M", field: "Volatility.M" },
    ] }],
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value", "Volatility"]], presets: [
      { operation: "above", target: "value", right: { value: 50 }, ...d("Extreme") },
      { operation: "between", target: "value", right: { left: 20, right: 50 }, ...d("Very high") },
      { operation: "between", target: "value", right: { left: 10, right: 20 }, ...d("High") },
      { operation: "between", target: "value", right: { left: 5, right: 10 }, ...d("Elevated") },
      { operation: "between", target: "value", right: { left: 3, right: 5 }, ...d("Moderate") },
      { operation: "below", target: "value", right: { value: 3 }, ...d("Low") },
    ] } },
  { id: "RelativeVolume", title: "Relative volume", short: "Rel vol", category: "marketData", align: "right", fmt: "number", width: 58, params: RES_1D("relative_volume_10d_calc"),
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value"]] } },
  { id: "Volume", title: "Volume", short: "Vol", category: "marketData", align: "right", fmt: "volume", width: 90, params: RES_DWM("volume", "volume|1W", "volume|1M"),
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value", "AverageVolume", "Volume"]] } },
  // The session's volume against the previous session's (colored like the price change).
  { id: "VolumeChange", title: "Volume change %", short: "Vol chg %", category: "marketData", align: "right", fmt: "change", width: 86, params: RES_1D("volume_change"),
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value"]] } },
  { id: "VolumeChangeAbs", title: "Volume change", short: "Vol chg", category: "marketData", align: "right", fmt: "signedVolume", width: 90, params: RES_1D("volume_change_abs"),
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value"]] } },
  // Market data (extended hours): the pre-market (04:00-09:30 New York) of the latest session that traded, shown all
  // day, and its post-market (to 20:00), shown overnight; the changes against the previous close (pre-market) and
  // the day's close (post-market), the gap = the pre-market open against the previous close.
  extPrice("PreMarketOpen", "Pre-market open", "Pre-mkt open", "premarket_open"),
  extPrice("PreMarketHigh", "Pre-market high", "Pre-mkt high", "premarket_high"),
  extPrice("PreMarketLow", "Pre-market low", "Pre-mkt low", "premarket_low"),
  extPrice("PreMarketClose", "Pre-market price", "Pre-mkt price", "premarket_close"),
  extChange("PreMarketChange", "Pre-market change %", "Pre-mkt chg %", "premarket_change"),
  extChangeAbs("PreMarketChangeAbs", "Pre-market change", "Pre-mkt chg", "premarket_change_abs"),
  extChange("PreMarketChangeFromOpen", "Pre-market change from open %", "Pre-mkt chg from open %", "premarket_change_from_open"),
  extChangeAbs("PreMarketChangeFromOpenAbs", "Pre-market change from open", "Pre-mkt chg from open", "premarket_change_from_open_abs"),
  extChange("PreMarketGap", "Pre-market gap %", "Pre-mkt gap %", "premarket_gap"),
  extVolume("PreMarketVolume", "Pre-market volume", "Pre-mkt vol", "premarket_volume"),
  extPrice("PostMarketOpen", "Post-market open", "Post-mkt open", "postmarket_open"),
  extPrice("PostMarketHigh", "Post-market high", "Post-mkt high", "postmarket_high"),
  extPrice("PostMarketLow", "Post-market low", "Post-mkt low", "postmarket_low"),
  extPrice("PostMarketClose", "Post-market price", "Post-mkt price", "postmarket_close"),
  extChange("PostMarketChange", "Post-market change %", "Post-mkt chg %", "postmarket_change"),
  extChangeAbs("PostMarketChangeAbs", "Post-market change", "Post-mkt chg", "postmarket_change_abs"),
  extVolume("PostMarketVolume", "Post-market volume", "Post-mkt vol", "postmarket_volume"),
  // Technicals
  { id: "AverageDailyRange", title: "Average daily range", short: "ADR", category: "technicals", align: "right", fmt: "price", width: 86, field: "ADR",
    filter: { type: "Condition", operations: ["between"], defaultOperation: "between", targets: [["value"]] } },
  { id: "AverageDayRangePercent", title: "Average daily range %", short: "ADR %", category: "technicals", align: "right", fmt: "percent", width: 75, field: "ADRP",
    filter: { type: "Condition", operations: ["between"], defaultOperation: "between", targets: [["value"]], presets: [1, 2, 5, 10, 20, 50, 100].map((n) => ({
      operation: "between" as const, target: "value", right: { left: n, right: null } })) } },
  { id: "AverageTrueRange", title: "Average true range", short: "ATR", category: "technicals", align: "right", fmt: "price", width: 86,
    params: [{ key: "length", title: "Length", default: "14", options: [{ value: "14", label: "14", short: "14", field: "ATR" }] },
      { key: "resolution", title: "Interval", default: "TimeResolution1D", options: [{ value: "TimeResolution1D", label: "1 day", short: "1D", field: "" }] }],
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value"]] } },
  { id: "AverageTrueRangePercent", title: "Average true range %", short: "ATR %", category: "technicals", align: "right", fmt: "percent", width: 75,
    params: [{ key: "length", title: "Length", default: "14", options: [{ value: "14", label: "14", short: "14", field: "ATRP" }] },
      { key: "resolution", title: "Interval", default: "TimeResolution1D", options: [{ value: "TimeResolution1D", label: "1 day", short: "1D", field: "" }] }],
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value", "AverageTrueRangePercent"]],
      presets: [1, 2, 5, 10, 20, 50, 100].map((n) => ({ operation: "above" as const, target: "value", right: { value: n } })) } },
  { id: "Ema", title: "Exponential moving average", short: "EMA", category: "technicals", align: "right", fmt: "price", width: 99, params: MA_PARAMS("EMA"),
    filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "aboveOrEqual", targets: PRICE_TARGETS("Ema"), presets: MA_PRESETS("Ema") } },
  { id: "RelativeStrengthIndex", title: "Relative strength index", short: "RSI", category: "technicals", align: "right", fmt: "number", width: 74,
    params: [{ key: "length", title: "Length", default: "14", custom: { prefix: "RSI" }, options: [
      { value: "7", label: "7", short: "7", field: "RSI7" },
      { value: "14", label: "14", short: "14", field: "RSI" },
    ] },
      { key: "resolution", title: "Interval", default: "TimeResolution1D", options: [{ value: "TimeResolution1D", label: "1 day", short: "1D", field: "" }] }],
    filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "aboveOrEqual", targets: [["value", "RelativeStrengthIndex"]], presets: [
      { operation: "above", target: "value", right: { value: 90 }, ...d("Extremely overbought") },
      { operation: "above", target: "value", right: { value: 80 }, ...d("Strong overbought") },
      { operation: "above", target: "value", right: { value: 70 }, ...d("Overbought") },
      { operation: "above", target: "value", right: { value: 60 }, ...d("Slightly overbought") },
      { operation: "below", target: "value", right: { value: 40 }, ...d("Slightly oversold") },
      { operation: "below", target: "value", right: { value: 30 }, ...d("Oversold") },
      { operation: "below", target: "value", right: { value: 20 }, ...d("Strong oversold") },
      { operation: "below", target: "value", right: { value: 10 }, ...d("Extremely oversold") },
    ] } },
  { id: "Ma", title: "Simple moving average", short: "SMA", category: "technicals", align: "right", fmt: "price", width: 99, params: MA_PARAMS("SMA"),
    filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "aboveOrEqual", targets: PRICE_TARGETS("Ma"), presets: MA_PRESETS("Ma") } },
  rating("TechnicalRating", "Technical rating", "Tech rating", "Recommend.All", "TechRating_1D"),
  { id: "Pattern", title: "Candlestick pattern", short: "Pattern", category: "technicals", align: "left", fmt: "patterns", width: 130,
    params: RES_1D("candlestick_patterns"), filter: { type: "CheckboxGroup", options: CANDLE_PATTERNS.map((p): [string, string] => [p.id, p.title]) } },
  rating("RatingMa", "Moving averages rating", "MA rating", "Recommend.MA", "MARating_1D"),
  rating("RatingOscillators", "Oscillators rating", "Os rating", "Recommend.Other", "OsRating_1D"),
  oscillator("Momentum", "Momentum", "Mom", [
    { key: "length", title: "Length", default: "10", options: [
      { value: "10", label: "10", short: "10", field: "Mom" },
      { value: "14", label: "14", short: "14", field: "Mom_14" },
    ] },
    RES_1D_ONLY,
  ], SIGN_PRESETS),
  oscillator("AwesomeOscillator", "Awesome oscillator", "AO", resOnly("AO"), SIGN_PRESETS),
  oscillator("CommodityChannelIndex", "Commodity channel index", "CCI", [
    { key: "length", title: "Length", default: "20", options: [{ value: "20", label: "20", short: "20", field: "CCI20" }] },
    RES_1D_ONLY,
  ], [
    { operation: "above", target: "value", right: { value: 100 }, ...d("Overbought") },
    { operation: "below", target: "value", right: { value: -100 }, ...d("Oversold") },
  ]),
  {
    ...oscillator("Stochastic", "Stochastic", "Stoch", [
      { key: "inputsGroup", title: "Inputs", default: "Stochastic:14_1_3", options: [
        { value: "Stochastic:14_1_3", label: "14,1,3", short: "14,1,3", field: "" },
        { value: "Stochastic:14_3_3", label: "14,3,3", short: "14,3,3", field: "" },
      ] },
      PLOT("Stochastic", [{ plot: "K", label: "%K" }, { plot: "D", label: "%D" }]),
      RES_1D_ONLY,
    ], ZONE_PRESETS("Stochastic", "Stochastic:14_3_3", "K", "D")),
    // The reference scanner names: Stoch.K / Stoch.D for 14, 3, 3, with the inputs as a suffix otherwise.
    fieldOfParams: (p) => `Stoch.${p.plot === "Stochastic:D" ? "D" : "K"}${p.inputsGroup === "Stochastic:14_3_3" ? "" : "_14_1_3"}`,
  },
  // The indicators of the reference Technicals filters, on the daily bars (deepentropy/gateway#57; the state's values
  // at the close checked against the reference scanner's on 25/11/2026, every US symbol).
  {
    ...oscillator("Macd", "Moving average convergence divergence", "MACD", [INPUTS("Macd", "12_26"), PLOT("Macd", [{ plot: "Level", label: "Level" }, { plot: "Signal", label: "Signal" }]), RES_1D_ONLY], [
      { operation: "above", target: "value", leftParams: { plot: "Macd:Level" }, right: { value: 0 }, ...d("Bullish momentum") },
      { operation: "below", target: "value", leftParams: { plot: "Macd:Level" }, right: { value: 0 }, ...d("Bearish momentum") },
    ]),
    fieldOfParams: (p) => (p.plot === "Macd:Signal" ? "MACD.signal" : "MACD.macd"),
  },
  oscillator("AverageDirectionalIndex", "Average directional index", "ADX",
    [LENGTHS([["9", "ADX_9"], ["14", "ADX"], ["20", "ADX_20"], ["50", "ADX_50"], ["100", "ADX_100"]], "14"), RES_1D_ONLY], [
      { operation: "above", target: "value", right: { value: 60 }, ...d("Extremely strong trend") },
      { operation: "above", target: "value", right: { value: 50 }, ...d("Very strong trend") },
      { operation: "above", target: "value", right: { value: 40 }, ...d("Strong trend") },
      { operation: "below", target: "value", right: { value: 20 }, ...d("Weak or no trend") },
      { operation: "above", target: "DirectionalMovementIndex", leftParams: { length: "14" }, right: { column: DMI("Positive") }, ...d("Uptrend bias") },
      { operation: "above", target: "DirectionalMovementIndex", leftParams: { length: "14" }, right: { column: DMI("Negative") }, ...d("Downtrend bias") },
    ], ["DirectionalMovementIndex", "AverageDirectionalIndex"]),
  {
    ...oscillator("DirectionalMovementIndex", "Directional movement index", "DMI",
      [LENGTHS([["14", ""]]), PLOT("DirectionalMovementIndex", [{ plot: "Positive", label: "Positive" }, { plot: "Negative", label: "Negative" }]), RES_1D_ONLY], [
        { operation: "above", target: "DirectionalMovementIndex", leftParams: { plot: "DirectionalMovementIndex:Positive" }, right: { column: DMI("Negative") },
          ...d("Bullish directional bias") },
        { operation: "below", target: "DirectionalMovementIndex", leftParams: { plot: "DirectionalMovementIndex:Positive" }, right: { column: DMI("Negative") },
          ...d("Bearish directional bias") },
      ], ["AverageDirectionalIndex", "DirectionalMovementIndex"]),
    fieldOfParams: (p) => (p.plot === "DirectionalMovementIndex:Negative" ? "ADX-DI" : "ADX+DI"),
  },
  {
    ...oscillator("Aroon", "Aroon", "Aroon", [LENGTHS([["14", ""]]), PLOT("Aroon", [{ plot: "Up", label: "Up" }, { plot: "Down", label: "Down" }]), RES_1D_ONLY], [
      ...(["Up", "Down"] as const).flatMap((side): Preset[] => {
        const up = side === "Up";
        const left = { plot: `Aroon:${side}` };
        return [
          { operation: "above", target: "Aroon", leftParams: left, right: { column: AROON(up ? "Down" : "Up") }, ...d(up ? "Bullish bias" : "Bearish bias") },
          { operation: "equal", target: "value", leftParams: left, right: { value: 100 }, ...d(up ? "Local high" : "Local low") },
          { operation: "above", target: "value", leftParams: left, right: { value: 50 }, ...d(up ? "Strong bullish momentum" : "Strong bearish momentum") },
          { operation: "below", target: "value", leftParams: left, right: { value: 50 }, ...d(up ? "Weak bullish momentum" : "Weak bearish momentum") },
          { operation: "below", target: "value", leftParams: left, right: { value: 10 }, ...d(up ? "Minimal bullish momentum" : "Minimal bearish momentum") },
        ];
      }),
    ]),
    fieldOfParams: (p) => (p.plot === "Aroon:Down" ? "Aroon.Down" : "Aroon.Up"),
  },
  {
    ...priceLine("BollingerBands", "Bollinger Bands", "BB", [LENGTHS([["20", ""], ["50", ""]]), BANDS_PLOT("BollingerBands"), RES_1D_ONLY], LINE_PIVOT_TARGETS, [
      { operation: "below", target: "Price", leftParams: { plot: "BollingerBands:Upper" }, right: { column: PRICE }, ...d("Upper band proximity") },
      { operation: "belowPercent", offsetRangeId: "offset_range_0_5", target: "Price", leftParams: { plot: "BollingerBands:Upper" }, right: { column: PRICE },
        ...d("Mild upper band proximity") },
      { operation: "below", target: "Price", leftParams: { plot: "BollingerBands:Basis" }, right: { column: PRICE }, ...d("Bullish bias") },
      { operation: "above", target: "Price", leftParams: { plot: "BollingerBands:Basis" }, right: { column: PRICE }, ...d("Bearish bias") },
      { operation: "abovePercent", offsetRangeId: "offset_range_0_5", target: "Price", leftParams: { plot: "BollingerBands:Lower" }, right: { column: PRICE },
        ...d("Lower band proximity") },
      { operation: "above", target: "Price", leftParams: { plot: "BollingerBands:Lower" }, right: { column: PRICE }, ...d("Lower band overextension") },
      { operation: "abovePercent", offsetRangeId: "offset_range_100", target: "BollingerBands", leftParams: { plot: "BollingerBands:Upper", length: "20" },
        right: { column: BB_LOWER }, ...d("High volatility") },
      { operation: "abovePercent", offsetRangeId: "offset_range_0_20", target: "BollingerBands", leftParams: { plot: "BollingerBands:Upper", length: "20" },
        right: { column: BB_LOWER }, ...d("Low volatility") },
    ]),
    // The reference scanner names: BB.upper / BB.basis / BB.lower for 20 closes, "_50" after them for 50.
    fieldOfParams: (p) => `BB.${bandKey(p.plot)}${p.length === "50" ? "_50" : ""}`,
  },
  oscillator("BBPower", "Bull bear power", "Bull/bear", [LENGTHS([["13", "BBPower"]]), RES_1D_ONLY], SIGN_PRESETS),
  oscillator("ChaikinMoneyFlow", "Chaikin money flow", "CMF", [LENGTHS([["20", "ChaikinMoneyFlow"]]), RES_1D_ONLY], [
    { operation: "above", target: "value", right: { value: 0.05 }, ...d("Strong bullish bias") },
    { operation: "above", target: "value", right: { value: 0 }, ...d("Bullish bias") },
    { operation: "below", target: "value", right: { value: 0 }, ...d("Bearish bias") },
    { operation: "below", target: "value", right: { value: -0.05 }, ...d("Strong bearish bias") },
  ]),
  {
    ...priceLine("DonchianChannels", "Donchian channels", "DC", [LENGTHS([["20", ""]]), BANDS_PLOT("DonchianChannels"), RES_1D_ONLY], LINE_TARGETS, [
      { operation: "below", target: "High", leftParams: { plot: "DonchianChannels:Upper" }, right: { column: { id: "High", params: { timebased: "TimeResolution1D" } } },
        ...d("Channel top proximity") },
      { operation: "abovePercent", offsetRangeId: "offset_range_0_5", target: "Price", leftParams: { plot: "DonchianChannels:Upper" }, right: { column: PRICE },
        ...d("Upper channel deviation") },
      { operation: "belowPercent", offsetRangeId: "offset_range_0_5", target: "Price", leftParams: { plot: "DonchianChannels:Lower" }, right: { column: PRICE },
        ...d("Lower band proximity") },
      { operation: "above", target: "Low", leftParams: { plot: "DonchianChannels:Lower" }, right: { column: { id: "Low", params: { timebased: "TimeResolution1D" } } },
        ...d("Channel bottom proximity") },
    ]),
    fieldOfParams: (p) => `DonchCh20.${{ "DonchianChannels:Basis": "Middle", "DonchianChannels:Lower": "Lower" }[p.plot] ?? "Upper"}`,
  },
  priceLine("HullMovingAverage", "Hull moving average", "Hull MA", [LENGTHS([["9", "HullMA9"], ["20", "HullMA20"], ["200", "HullMA200"]]), RES_1D_ONLY],
    LINE_PIVOT_TARGETS, MA_PRESETS("HullMovingAverage").slice(0, 8)),
  {
    ...priceLine("IchimokuCloud", "Ichimoku cloud", "Ichimoku", [
      { ...INPUTS("IchimokuCloud", "9_26_52_26"), options: [...INPUTS("IchimokuCloud", "9_26_52_26").options, ...INPUTS("IchimokuCloud", "20_60_120_30").options] },
      PLOT("IchimokuCloud", [{ plot: "Base", label: "Base line" }, { plot: "Conversion", label: "Conversion line" }, { plot: "SpanA", label: "Leading span A" }, { plot: "SpanB", label: "Leading span B" }]),
      RES_1D_ONLY,
    ], LINE_TARGETS, [
      { operation: "above", target: "IchimokuCloud", leftParams: { plot: "IchimokuCloud:SpanA" }, right: { column: SPAN_B }, ...d("Bullish cloud") },
      { operation: "below", target: "Price", leftParams: { plot: "IchimokuCloud:SpanB" }, right: { column: PRICE }, ...d("Price above cloud") },
      { operation: "below", target: "Price", leftParams: { plot: "IchimokuCloud:SpanA" }, right: { column: PRICE }, ...d("Price above lower cloud boundary") },
      { operation: "above", target: "Price", leftParams: { plot: "IchimokuCloud:SpanA" }, right: { column: PRICE }, ...d("Price below upper cloud boundary") },
      { operation: "above", target: "Price", leftParams: { plot: "IchimokuCloud:SpanB" }, right: { column: PRICE }, ...d("Price below cloud") },
      { operation: "below", target: "IchimokuCloud", leftParams: { plot: "IchimokuCloud:SpanA" }, right: { column: SPAN_B }, ...d("Bearish cloud") },
    ]),
    // The reference scanner names: Ichimoku.BLine / CLine / Lead1 / Lead2, the inputs after them for 20, 60, 120, 30.
    fieldOfParams: (p) =>
      `Ichimoku.${{ "IchimokuCloud:Conversion": "CLine", "IchimokuCloud:SpanA": "Lead1", "IchimokuCloud:SpanB": "Lead2" }[p.plot] ?? "BLine"}${
        p.inputsGroup === "IchimokuCloud:20_60_120_30" ? "_20_60_120_30" : ""}`,
  },
  {
    ...priceLine("KeltnerChannels", "Keltner channels", "KC", [LENGTHS([["20", ""]]), BANDS_PLOT("KeltnerChannels"), RES_1D_ONLY], LINE_TARGETS, [
      { operation: "below", target: "Price", leftParams: { plot: "KeltnerChannels:Upper" }, right: { column: PRICE }, ...d("Upper band proximity") },
      { operation: "belowPercent", offsetRangeId: "offset_range_0_5", target: "Price", leftParams: { plot: "KeltnerChannels:Upper" }, right: { column: PRICE },
        ...d("Mild upper band proximity") },
      { operation: "abovePercent", offsetRangeId: "offset_range_0_5", target: "Price", leftParams: { plot: "KeltnerChannels:Upper" }, right: { column: PRICE },
        ...d("Upper band deviation") },
      { operation: "below", target: "Price", leftParams: { plot: "KeltnerChannels:Basis" }, right: { column: PRICE }, ...d("Bullish bias") },
      { operation: "above", target: "Price", leftParams: { plot: "KeltnerChannels:Basis" }, right: { column: PRICE }, ...d("Bearish bias") },
      { operation: "belowPercent", offsetRangeId: "offset_range_0_5", target: "Price", leftParams: { plot: "KeltnerChannels:Lower" }, right: { column: PRICE },
        ...d("Lower band proximity") },
      { operation: "abovePercent", offsetRangeId: "offset_range_0_5", target: "Price", leftParams: { plot: "KeltnerChannels:Lower" }, right: { column: PRICE },
        ...d("Mild lower band overextension") },
      { operation: "above", target: "Price", leftParams: { plot: "KeltnerChannels:Lower" }, right: { column: PRICE }, ...d("Lower band overextension") },
    ]),
    fieldOfParams: (p) => `KltChnl.${bandKey(p.plot)}`,
  },
  oscillator("MoneyFlow", "Money flow index", "MFI", [LENGTHS([["14", "MoneyFlow"]]), RES_1D_ONLY], [
    { operation: "above", target: "value", right: { value: 90 }, ...d("Extremely overbought") },
    { operation: "above", target: "value", right: { value: 80 }, ...d("Overbought") },
    { operation: "above", target: "value", right: { value: 70 }, ...d("Slightly overbought") },
    { operation: "below", target: "value", right: { value: 30 }, ...d("Slightly oversold") },
    { operation: "below", target: "value", right: { value: 20 }, ...d("Oversold") },
    { operation: "below", target: "value", right: { value: 10 }, ...d("Extremely oversold") },
  ]),
  pivot("PivotClassic", "Pivot points Classic", "Classic", "Classic"),
  pivot("PivotFibonacci", "Pivot points Fibonacci", "Fibonacci", "Fibonacci"),
  pivot("PivotWoodie", "Pivot points Woodie", "Woodie", "Woodie"),
  pivot("PivotCamarilla", "Pivot points Camarilla", "Camarilla", "Camarilla"),
  pivot("PivotDemark", "Pivot points DeMark", "DeM", "Demark"),
  priceLine("Psar", "Parabolic SAR", "SAR", resOnly("P.SAR"), LINE_TARGETS, [
    { operation: "below", target: "Price", right: { column: PRICE }, ...d("Uptrend") },
    { operation: "belowPercent", offsetRangeId: "offset_range_0_5", target: "Price", right: { column: PRICE }, ...d("Strengthening uptrend") },
    { operation: "above", target: "Price", right: { column: PRICE }, ...d("Downtrend") },
    { operation: "abovePercent", offsetRangeId: "offset_range_0_5", target: "Price", right: { column: PRICE }, ...d("Strengthening downtrend") },
  ]),
  oscillator("RateOfChange", "Rate of change", "ROC", [LENGTHS([["9", "ROC"]]), RES_1D_ONLY], SIGN_PRESETS),
  {
    ...oscillator("StochasticRsi", "Stochastic RSI", "Stoch RSI", [INPUTS("StochasticRsi", "3_3_14_14"), PLOT("StochasticRsi", [{ plot: "Fast", label: "K" }, { plot: "Slow", label: "D" }]), RES_1D_ONLY],
      ZONE_PRESETS("StochasticRsi", "StochasticRsi:3_3_14_14", "Fast", "Slow")),
    fieldOfParams: (p) => (p.plot === "StochasticRsi:Slow" ? "Stoch.RSI.D" : "Stoch.RSI.K"),
  },
  oscillator("UltimateOscillator", "Ultimate oscillator", "UO", [INPUTS("UltimateOscillator", "7_14_28", "UO"), RES_1D_ONLY], [
    { operation: "above", target: "value", right: { value: 80 }, ...d("Strong overbought") },
    { operation: "above", target: "value", right: { value: 70 }, ...d("Overbought") },
    { operation: "below", target: "value", right: { value: 30 }, ...d("Oversold") },
    { operation: "below", target: "value", right: { value: 20 }, ...d("Strong oversold") },
  ]),
  priceLine("VolumeWeightedAveragePrice", "Volume-weighted average price", "VWAP", resOnly("VWAP"),
    LINE_TARGETS, TREND_PRESETS),
  priceLine("VolumeWeightedMovingAverage", "Volume-weighted moving average", "VWMA", [LENGTHS([["20", "VWMA"]]), RES_1D_ONLY], LINE_TARGETS, TREND_PRESETS),
  oscillator("WilliamsPercentRange", "Williams percent range", "Williams %R", [LENGTHS([["14", "W.R"]]), RES_1D_ONLY], [
    { operation: "above", target: "value", right: { value: -20 }, ...d("Overbought") },
    { operation: "below", target: "value", right: { value: -80 }, ...d("Oversold") },
  ]),
  // Valuation
  { id: "MarketCap", title: "Market capitalization", short: "Mkt cap", category: "valuation", align: "right", fmt: "money", width: 110, field: "market_cap_basic", financial: true,
    filter: { type: "Condition", operations: ["between"], defaultOperation: "between", targets: [["value"]], presets: [
      { operation: "between", target: "value", right: { left: 200e9, right: null }, ...d("Mega") },
      { operation: "between", target: "value", right: { left: 10e9, right: 200e9 }, ...d("Large") },
      { operation: "between", target: "value", right: { left: 2e9, right: 10e9 }, ...d("Mid") },
      { operation: "between", target: "value", right: { left: 300e6, right: 2e9 }, ...d("Small") },
      { operation: "between", target: "value", right: { left: 50e6, right: 300e6 }, ...d("Micro") },
      { operation: "between", target: "value", right: { left: null, right: 50e6 }, ...d("Nano") },
    ] } },
  // Dividends (the quarterly and annual fiscal periods have no data source)
  { id: "DividendsYield", title: "Dividend yield %", short: "Div yield %", category: "dividends", align: "right", fmt: "percent", width: 86,
    params: [{ key: "fiscalPeriod", title: "Fiscal period", default: "ttm", options: [
      { value: "ttm", label: "Trailing 12 months", short: "TTM", field: "dividends_yield_current" },
    ] }],
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value"]], presets: [
      { operation: "above", target: "value", right: { value: 15 }, ...d("Exceptional") },
      { operation: "between", target: "value", right: { left: 10, right: 15 }, ...d("Very high") },
      { operation: "between", target: "value", right: { left: 6, right: 10 }, ...d("High") },
      { operation: "between", target: "value", right: { left: 4, right: 6 }, ...d("Moderate") },
      { operation: "between", target: "value", right: { left: 2, right: 4 }, ...d("Low") },
      { operation: "between", target: "value", right: { left: 0, right: 2 }, ...d("Very low") },
      { operation: "equal", target: "value", right: { value: 0 }, ...d("No dividend") },
    ] } },
  ...FUNDAMENTALS,
  ...MORE_FUNDAMENTALS,
  // ETF: assets under management (shares outstanding x price).
  { id: "AssetsUnderManagement", title: "Assets under management", short: "AUM", category: "valuation", align: "right", fmt: "money", width: 110, field: "market_cap_basic", financial: true,
    filter: { type: "Condition", operations: ["between"], defaultOperation: "between", targets: [["value"]] } },
  // ETF fund data (the regulator's fund reports, the fund's name, its distributions).
  { id: "AssetClass", title: "Asset class", short: "Asset class", category: "securityInfo", align: "left", fmt: "text", width: 120, field: "f.asset_class",
    filter: { type: "CheckboxGroup", options: "data" } },
  { id: "ExpenseRatio", title: "Expense ratio", short: "Expense ratio", category: "valuation", align: "right", fmt: "percent", width: 90, field: "f.expense_ratio",
    filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "below", targets: [["value"]] } },
  { id: "TotalHoldings", title: "Total holdings", short: "Holdings", category: "securityInfo", align: "right", fmt: "integer", width: 90, field: "f.holdings",
    filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "above", targets: [["value"]] } },
  topWeight("PercentInTop10", "Top 10 weight (% in top)", "Top 10 weight", "f.weight_top_10"),
  topWeight("PercentInTop25", "Top 25 weight (% in top)", "Top 25 weight", "f.weight_top_25"),
  topWeight("PercentInTop50", "Top 50 weight (% in top)", "Top 50 weight", "f.weight_top_50"),
  { id: "DividendsFrequency", title: "Dividend frequency", short: "Div freq", category: "dividends", align: "left", fmt: "text", width: 100, field: "f.dividends_frequency",
    filter: { type: "CheckboxGroup", options: "data" } },
  { id: "Leveraged", title: "Leveraged", short: "Leveraged", category: "securityInfo", align: "left", fmt: "text", width: 110, field: "f.leveraged", noColumn: true,
    filter: { type: "CheckboxGroup", options: "data" } },
  // The reference: a filter only, the Leverage column shows the ratio with the flag.
  { id: "LeverageRatio", title: "Leverage ratio", short: "Leverage ratio", category: "securityInfo", align: "left", fmt: "text", width: 100, field: "f.leverage_ratio",
    noColumn: true, filter: { type: "CheckboxGroup", options: "data" } },
  { id: "Leverage", title: "Leverage", short: "Leverage", category: "securityInfo", align: "left", fmt: "text", width: 120, field: "f.leverage" },
  // The fund family (the start of the funds' names), the adviser's parent company, the index a passive fund tracks
  // (the annual fund census, the prospectus summaries, the legal entity records).
  { id: "Brand", title: "Brand", short: "Brand", category: "securityInfo", align: "left", fmt: "text", width: 130, field: "f.brand",
    filter: { type: "CheckboxGroup", options: "data" } },
  { id: "Issuer", title: "Issuer", short: "Issuer", category: "securityInfo", align: "left", fmt: "text", width: 220, field: "f.issuer",
    filter: { type: "CheckboxGroup", options: "data" } },
  { id: "IndexTracked", title: "Index tracked", short: "Index", category: "securityInfo", align: "left", fmt: "text", width: 220, field: "f.index_tracked",
    filter: { type: "CheckboxGroup", options: "data" } },
  { id: "Management", title: "Management style", short: "Management style", category: "securityInfo", align: "left", fmt: "text", width: 130,
    field: "f.management", filter: { type: "CheckboxGroup", options: "data", single: true } },
  { id: "DividendTreatment", title: "Dividend treatment", short: "Div treat", category: "dividends", align: "left", fmt: "text", width: 110,
    field: "f.dividend_treatment", filter: { type: "CheckboxGroup", options: "data", single: true } },
  // Money into the fund over the period (its weekly share count changes x the price), a column once the gateway's
  // share count history covers the period.
  { id: "FundFlows", title: "Fund flows", short: "Fund flows", category: "valuation", align: "right", fmt: "signedMoney", width: 110, financial: true,
    params: [{ key: "interval", title: "Date Range", default: "Interval1M", options: [
      { value: "Interval1M", label: "1 month", short: "1M", field: "f.fund_flows_1m" },
      { value: "Interval3M", label: "3 months", short: "3M", field: "f.fund_flows_3m" },
      { value: "IntervalYTD", label: "Year to date", short: "YTD", field: "f.fund_flows_ytd" },
      { value: "Interval1Y", label: "1 year", short: "1Y", field: "f.fund_flows_1y" },
      { value: "Interval3Y", label: "3 years", short: "3Y", field: "f.fund_flows_3y" },
      { value: "Interval5Y", label: "5 years", short: "5Y", field: "f.fund_flows_5y" },
    ] }],
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value"]] } },
];
/** Columns of the ETF Screener only (fund data). */
const ETF_ONLY = new Set(["AssetsUnderManagement", "AssetClass", "ExpenseRatio", "TotalHoldings", "PercentInTop10", "PercentInTop25", "PercentInTop50",
  "DividendsFrequency", "Leveraged", "LeverageRatio", "Leverage", "Brand", "Issuer", "IndexTracked", "Management", "DividendTreatment", "FundFlows"]);

/** Columns of the ETF Screener (the reference ETF catalog restricted to ours): market data, technicals, exchange,
 *  indicated dividend yield and the fund data. The Stock Screener has every other column. */
const ETF_EXTRA = new Set(["Exchange", "DividendsYieldForward"]);
export function columnForType(def: ColumnDef, type: ScreenerType): boolean {
  if (ETF_ONLY.has(def.id)) return type === "etf";
  if (type === "stock") return true;
  if (def.id === "Index" || def.id === "Sector" || def.id === "Industry" || def.id === "MarketCap") return false;
  return def.category === "marketData" || def.category === "technicals" || ETF_EXTRA.has(def.id);
}

export const COLUMN_BY_ID: Record<string, ColumnDef> = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));

/** The sticky first column (the reference app `TickerUniversal`). Sorting by it sends `name`. */
export const TICKER_COLUMN: ColumnRef = { id: "TickerUniversal", params: {} };
export const TICKER_SORT_FIELD = "name";

/** Add filter / Column setup categories, in the reference app order, with their icons. */
export const CATEGORIES: { id: Category; title: string; icon: string }[] = [
  { id: "securityInfo", title: "Security info", icon: "scr-cat-security-info" },
  { id: "marketData", title: "Market data", icon: "scr-cat-market-data" },
  { id: "technicals", title: "Technicals", icon: "scr-cat-technicals" },
  { id: "financials", title: "Financials", icon: "scr-cat-financials" },
  { id: "valuation", title: "Valuation", icon: "scr-cat-valuation" },
  { id: "growth", title: "Growth", icon: "scr-cat-growth" },
  { id: "margins", title: "Margins", icon: "scr-cat-margins" },
  { id: "dividends", title: "Dividends", icon: "scr-cat-dividends" },
];

/** Every filter operation of the screeners (this one's `Operation`s and the Script Screener's, see
 *  script-screen.ts): its label and its icon (scr-op-<icon> 18 px pill, scr-op-lg-<icon> 28 px menu); the
 *  signal operations have none. */
export const FILTER_OPS: Record<FilterOp, { label: string; icon?: string }> & Record<Operation, { label: string; icon: string }> = {
  above: { label: "Above", icon: "above" },
  aboveOrEqual: { label: "Above or equal", icon: "above-or-equal" },
  below: { label: "Below", icon: "below" },
  belowOrEqual: { label: "Below or equal", icon: "below-or-equal" },
  equal: { label: "Equal", icon: "equal" },
  nequal: { label: "Not equal", icon: "not-equal" },
  between: { label: "Between", icon: "between" },
  outside: { label: "Outside", icon: "outside" },
  crosses: { label: "Crosses", icon: "crosses" },
  crossesUp: { label: "Crosses up", icon: "crosses-up" },
  crossesDown: { label: "Crosses down", icon: "crosses-down" },
  true: { label: "True" },
  trueWithin: { label: "True within" },
};

// ── Column refs → fields ──────────────────────────────────────────────────

/** Params of a column with every missing key set to its default. */
export function fullParams(def: ColumnDef, params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of def.params ?? []) out[p.key] = params[p.key] ?? p.default;
  return out;
}

/** Backend field id of a column (null when the column or option is unknown). */
export function fieldOf(col: ColumnRef): string | null {
  const def = COLUMN_BY_ID[col.id];
  if (!def) return null;
  if (def.field) return def.field;
  const p = fullParams(def, col.params);
  if (def.fieldOfParams) return def.fieldOfParams(p);
  for (const pd of def.params ?? []) {
    const opt = optionOf(pd, p[pd.key]);
    if (opt?.field) return opt.field;
  }
  return null;
}

/** Param defs of a column restricted to options the backend has (by field),
 *  or null when the column has no usable option. A param whose options carry
 *  no field (a fixed interval such as "1 day") is kept as is. */
export function offeredParams(def: ColumnDef, has: (field: string) => boolean): ParamDef[] | null {
  const out: ParamDef[] = [];
  for (const p of def.params ?? []) {
    const withField = p.options.some((o) => o.field);
    const options = withField ? p.options.filter((o) => has(o.field)) : p.options;
    if (!options.length) return null;
    out.push({ ...p, options, default: options.some((o) => o.value === p.default) ? p.default : options[0].value });
  }
  return out;
}

export function isOffered(def: ColumnDef, has: (field: string) => boolean): boolean {
  if (def.field) return has(def.field);
  if (def.fieldOfParams) return has(def.fieldOfParams(fullParams(def, {})));
  return offeredParams(def, has) !== null;
}

/** Params shown to the user (more than one option to pick from). */
export function visibleParams(def: ColumnDef, has: (field: string) => boolean): ParamDef[] {
  return (offeredParams(def, has) ?? []).filter((p) => p.options.length > 1);
}

/** Default column ref for a def (params at their offered defaults). */
export function defaultRef(def: ColumnDef, has: (field: string) => boolean): ColumnRef {
  const params: Record<string, string> = {};
  for (const p of offeredParams(def, has) ?? []) params[p.key] = p.default;
  return { id: def.id, params };
}

/** Short labels of the params that differ from a one-day resolution, e.g.
 *  ["1M"] for High 1M, ["50"] for EMA 50. Used for the header second line. */
export function paramShorts(col: ColumnRef): string[] {
  const def = COLUMN_BY_ID[col.id];
  if (!def?.params) return [];
  const p = fullParams(def, col.params);
  const out: string[] = [];
  for (const pd of def.params) {
    const opt = optionOf(pd, p[pd.key]);
    if (!opt || opt.value === "TimeResolution1D") continue;
    out.push(opt.short);
  }
  return out;
}

/** "EMA, 50" / "High, 1M" / "Chg %": the reference app configured short title, in the interface language. */
export function configuredShort(col: ColumnRef): string {
  const def = COLUMN_BY_ID[col.id];
  if (!def) return col.id;
  return formatted(listText([translate(def.short), ...paramShorts(col).map((s) => translate(s))]));
}

/** "Price change %, 1 day": the reference app configured long title (header tooltip). */
export function configuredLong(col: ColumnRef): string {
  const def = COLUMN_BY_ID[col.id];
  if (!def) return col.id;
  const p = fullParams(def, col.params);
  const parts = [translate(def.title)];
  for (const pd of def.params ?? []) {
    const opt = optionOf(pd, p[pd.key]);
    if (opt) parts.push(translate(opt.label));
  }
  return formatted(listText(parts));
}

export function sameColumn(a: ColumnRef, b: ColumnRef): boolean {
  if (a.id !== b.id) return false;
  const def = COLUMN_BY_ID[a.id];
  if (!def) return true;
  const pa = fullParams(def, a.params);
  const pb = fullParams(def, b.params);
  return Object.keys(pa).every((k) => pa[k] === pb[k]);
}

// ── Column sets (the reference app presets restricted to the catalog) ────────────────────
const C = (id: string, params: Record<string, string> = {}): ColumnRef => ({ id, params });
const R1D = { resolution: "TimeResolution1D" };
const TTM = { fiscalPeriod: "ttm" };
const FY = { fiscalPeriod: "fy" };
const FQ = { fiscalPeriod: "fq" };
const CURRENT = { fiscalPeriod: "current" };
const YOY_TTM = { period: "YoYTTM" };
const YOY_FY = { period: "YoYAnnual" };
const FISCAL = [C("RecentFiscalPeriod", CURRENT), C("FiscalPeriodEndDate", CURRENT)];
const STOCH_3_3 = (plot: string) => C("Stochastic", { resolution: "TimeResolution1D", plot, inputsGroup: "Stochastic:14_3_3" });
/** The reference Technicals column set (both screeners). */
const TECHNICALS = [C("TechnicalRating", R1D), C("RatingMa", R1D), C("RatingOscillators", R1D),
  C("RelativeStrengthIndex", { resolution: "TimeResolution1D", length: "14" }), C("Momentum", { resolution: "TimeResolution1D", length: "10" }),
  C("AwesomeOscillator", R1D), C("CommodityChannelIndex", { resolution: "TimeResolution1D", length: "20" }), STOCH_3_3("Stochastic:K"), STOCH_3_3("Stochastic:D"),
  C("Pattern", R1D)];
/** The reference app column-set presets, in the reference app menu order (03/11/2026). Columns without a data
 *  source are left out (analyst rating, estimates...); a preset with no column the backend has is not listed. */
export const COLUMN_SETS: { id: string; title: string; columns: ColumnRef[] }[] = [
  { id: "overview", title: "Overview", columns: [C("Price"), C("Change", R1D), C("Volume", R1D), C("RelativeVolume", R1D), C("MarketCap"), C("PriceToEarnings"),
    C("EpsDiluted", TTM), C("EpsDilutedGrowth", YOY_TTM), C("DividendsYield", TTM), C("Sector")] },
  { id: "performance", title: "Performance", columns: [C("Price"), C("Change", R1D),
    ...["Interval1W", "Interval1M", "Interval3M", "Interval6M", "IntervalYTD", "Interval1Y", "Interval5Y", "Interval10Y"].map((i) => C("Performance", { interval: i })),
    C("Volatility", { interval: "Interval1W" }), C("Volatility", { interval: "Interval1M" })] },
  { id: "technicals", title: "Technicals", columns: TECHNICALS },
  { id: "extendedHours", title: "Extended hours", columns: [C("PreMarketClose"), C("PreMarketChange"), C("PreMarketGap"), C("PreMarketVolume"), C("Price"), C("Change", R1D),
    C("Gap", R1D), C("Volume", R1D), C("VolumeChange", R1D), C("PostMarketClose"), C("PostMarketChange"), C("PostMarketVolume")] },
  { id: "forecasts", title: "Forecasts", columns: [C("MarketCap"), C("Price")] },
  { id: "valuation", title: "Valuation", columns: [C("MarketCap"), C("MarketCapPerf", { interval: "Interval1Y" }), C("PriceToEarnings"), C("PriceToEarningsToGrowth", TTM),
    C("PriceToSales"), C("PriceToBook"), C("PriceToCashFlow"), C("PriceToFreeCashFlow"), C("PriceToCashRatio"), C("Ev"), C("EvToRevenue", TTM), C("EvToEbit", TTM), C("EvToEbitda", TTM)] },
  { id: "dividends", title: "Dividends", columns: [C("DividendsPerShare", FY), C("DividendsPerShare", FQ), C("DividendsYield", TTM), C("DividendsYieldForward"),
    C("DividendPayoutRatio", TTM), C("DividendsPerShareGrowth", YOY_FY), C("ContinuousDivPayout"), C("ContinuousDivGrowth")] },
  { id: "profitability", title: "Profitability", columns: [C("GrossMargin", TTM), C("OperatingMargin", TTM), C("PreTaxMargin", TTM), C("NetMargin", TTM), C("FreeCashFlowMargin", TTM),
    C("ReturnOnAssets", TTM), C("ReturnOnEquity", TTM), C("ReturnOnInvestedCapital", TTM), C("ResearchNDevelopmentRatio", TTM), C("SellingGeneralNAdminExpensesRatio", TTM)] },
  { id: "incomeStatement", title: "Income statement", columns: [...FISCAL, C("TotalRevenue", TTM), C("RevenueGrowth", YOY_TTM), C("GrossProfit", TTM), C("OperatingIncome", TTM),
    C("NetIncome", TTM), C("Ebitda", TTM), C("EpsDiluted", TTM), C("EpsDilutedGrowth", YOY_TTM)] },
  { id: "balanceSheet", title: "Balance sheet", columns: [...FISCAL, C("TotalAssets", FQ), C("TotalCurrentAssets", FQ), C("CashNShortTermInvest", FQ), C("TotalLiabilities", FQ),
    C("TotalDebt", FQ), C("NetDebt", FQ), C("TotalEquity", FQ), C("CurrentRatio", FQ), C("QuickRatio", FQ), C("DebtToEquityRatio", FQ), C("CashToDebt", FQ)] },
  { id: "cashFlow", title: "Cash flow", columns: [...FISCAL, C("CashFromOperating", TTM), C("CashFromInvesting", TTM), C("CashFromFinancing", TTM), C("FreeCashFlow", TTM),
    C("CapitalExpenditures", TTM)] },
  { id: "perShare", title: "Per share", columns: [C("RevenuePerShare", TTM), C("BasicEps", TTM), C("EpsDiluted", TTM), C("OperatingCashFlowPerShare", TTM), C("FreeCashFlowPerShare", TTM),
    C("EBITPerShare", TTM), C("EBITDAPerShare", TTM), C("BookPerShare", FQ), C("TotalDebtPerShare", FQ), C("CashPerShare", FQ)] },
];
/** The reference ETF column sets restricted to ours (NAV performance has no data source; a fund flows period shows
 *  once the share count history covers it). */
export const ETF_COLUMN_SETS: { id: string; title: string; columns: ColumnRef[] }[] = [
  { id: "overview", title: "Overview", columns: [C("Price"), C("Change", R1D), C("VolumePrice", R1D), C("RelativeVolume", R1D), C("AssetsUnderManagement"),
    C("TotalHoldings"), C("ExpenseRatio"), C("AssetClass")] },
  { id: "performance", title: "Performance", columns: [C("Price"), C("Change", R1D),
    ...["Interval1W", "Interval1M", "Interval3M", "Interval6M", "IntervalYTD", "Interval1Y", "Interval5Y", "Interval10Y"].map((i) => C("Performance", { interval: i }))] },
  { id: "technicals", title: "Technicals", columns: TECHNICALS },
  { id: "extendedHours", title: "Extended hours", columns: [C("PreMarketClose"), C("PreMarketChange"), C("PreMarketGap"), C("PreMarketVolume"), C("Price"), C("Change", R1D),
    C("Gap", R1D), C("Volume", R1D), C("VolumeChange", R1D), C("PostMarketClose"), C("PostMarketChange"), C("PostMarketVolume")] },
  { id: "fundFlows", title: "Fund flows", columns: ["Interval1M", "Interval3M", "Interval1Y", "Interval3Y", "IntervalYTD"].map((i) => C("FundFlows", { interval: i })) },
  { id: "dividends", title: "Dividends", columns: [C("Price"), C("DividendsYieldForward"), C("DividendsFrequency"), C("DividendTreatment")] },
  { id: "holdings", title: "Holdings", columns: [C("Issuer"), C("TotalHoldings"), C("PercentInTop10"), C("PercentInTop25"), C("PercentInTop50"),
    C("Management"), C("IndexTracked"), C("Leverage")] },
  { id: "risk", title: "Risk", columns: [C("Beta", { interval: "Interval1Y" }), C("Beta", { interval: "Interval3Y" }), C("Beta", { interval: "Interval5Y" }),
    ...["Interval1D", "Interval1W", "Interval1M"].map((i) => C("Volatility", { interval: i }))] },
];
export const columnSets = (type: ScreenerType) => (type === "etf" ? ETF_COLUMN_SETS : COLUMN_SETS);

export const CUSTOM_SET_ID = "custom";
export const CUSTOM_SET_TITLE = "Custom";

// ── Screen model (the reference app shape) ───────────────────────────────────────────────
export type ConditionFilter = {
  id: string;
  type: "Condition";
  left: ColumnRef;
  operation: Operation | OffsetOperation;
  offsetRangeId?: OffsetRangeId;
  target: string;
  right: { value: number | null } | { left: number | null; right: number | null } | { column: ColumnRef };
};
export type CheckboxFilter = { id: string; type: "CheckboxGroup"; left: ColumnRef; values: string[] };
export type Filter = ConditionFilter | CheckboxFilter;

export type Screen = {
  title: string;
  filters: Filter[];
  /** Only the "custom" set is stored; presets come from COLUMN_SETS. */
  customColumns: ColumnRef[] | null;
  activeColumnSetId: string;
  sort: { sortBy: ColumnRef; sortOrder: "asc" | "desc" };
  /** OpenTrader watchlist id scoping the scan, or null for the whole market. */
  watchlistId: string | null;
  /** Market pill "Primary listing" (unset = on, the reference default). */
  primaryListing?: boolean;
  /** How the results show (unset = table). */
  viewMode?: ViewMode;
  /** The screener it belongs to (unset = the Stock Screener). */
  type?: "etf";
};

/** Screeners: Stock and ETF (the reference app's Bond and crypto screeners have no data source). */
export type ScreenerType = "stock" | "etf";
export const screenType = (s: Pick<Screen, "type">): ScreenerType => s.type ?? "stock";

export type ViewMode = "table" | "chart" | "heatmap";

export const DEFAULT_SCREEN_TITLE = "Untitled screen";

let seq = 0;
export function newFilterId(): string {
  seq = (seq + 1) % 1e6;
  return `f${Date.now().toString(36)}${seq.toString(36)}`;
}

/** Empty (inactive) filter for a column, with its default operation. */
export function emptyFilter(col: ColumnRef): Filter | null {
  const def = COLUMN_BY_ID[col.id];
  const f = def?.filter;
  if (!f) return null;
  if (f.type === "CheckboxGroup") return { id: newFilterId(), type: "CheckboxGroup", left: col, values: [] };
  const op = f.defaultOperation;
  return {
    id: newFilterId(),
    type: "Condition",
    left: col,
    operation: op,
    target: "value",
    right: op === "between" || op === "outside" ? { left: null, right: null } : { value: null },
  };
}

/** Pills of a new screen: the reference app default pills, in its order, that have a
 *  data source (a pill whose column the backend does not hold is not shown). Left out:
 *  Analyst rating and Upcoming earnings date. */
const DEFAULT_PILLS: ColumnRef[] = [
  C("Index"),
  C("Price"),
  C("Change", R1D),
  C("MarketCap"),
  C("PriceToEarnings"),
  C("EpsDilutedGrowth", YOY_TTM),
  C("DividendsYield", TTM),
  C("Sector"),
  C("Performance", { interval: "IntervalYTD" }),
  C("RevenueGrowth", YOY_TTM),
  C("PriceToEarningsToGrowth", TTM),
  C("ReturnOnEquity", TTM),
  C("Beta", { interval: "Interval5Y" }),
  C("EarningsRecent"),
];
/** Default pills of earlier versions (before dividend yield and beta, then
 *  before Index, then before the fundamentals, then before the recent earnings date). A stored screen still equal
 *  to one of those defaults moves to the current one. */
export const LEGACY_DEFAULT_PILLS: ColumnRef[][] = [
  [C("Price"), C("Change", R1D), C("MarketCap"), C("Sector"), C("Performance", { interval: "IntervalYTD" })],
  [C("Price"), C("Change", R1D), C("MarketCap"), C("DividendsYield", TTM), C("Sector"), C("Performance", { interval: "IntervalYTD" }), C("Beta", { interval: "Interval5Y" })],
  [C("Index"), C("Price"), C("Change", R1D), C("MarketCap"), C("DividendsYield", TTM), C("Sector"), C("Performance", { interval: "IntervalYTD" }), C("Beta", { interval: "Interval5Y" })],
  DEFAULT_PILLS.slice(0, -1),
];

/** The reference app default screen ("Untitled screen") restricted to the catalog:
 *  default pills, Overview columns, sorted by market cap. */
export function defaultScreen(title = DEFAULT_SCREEN_TITLE, pills: ColumnRef[] = DEFAULT_PILLS): Screen {
  return {
    title,
    filters: pills.map((c) => emptyFilter(c)).filter((f): f is Filter => f !== null),
    customColumns: null,
    activeColumnSetId: "overview",
    sort: { sortBy: C("MarketCap"), sortOrder: "desc" },
    watchlistId: null,
  };
}

/** The reference ETF default pills that have a data source (Focus, Niche, Holdings region, NAV total return, Strategy
 *  and UCITS have none). */
const ETF_DEFAULT_PILLS: ColumnRef[] = [C("AssetClass"), C("Brand"), C("Performance", { interval: "IntervalYTD" }), C("AssetsUnderManagement"),
  C("Management"), C("DividendTreatment"), C("DividendsYieldForward"), C("DividendsFrequency"), C("Leveraged"), C("ExpenseRatio")];

/** The reference ETF Screener's "Untitled screen": its default pills, Overview, sorted by AUM; primary listing off. */
export function defaultEtfScreen(title = DEFAULT_SCREEN_TITLE): Screen {
  return {
    ...defaultScreen(title, ETF_DEFAULT_PILLS),
    sort: { sortBy: C("AssetsUnderManagement"), sortOrder: "desc" },
    primaryListing: false,
    type: "etf",
  };
}

/** A new screen of a screener type. */
export const newScreen = (type: ScreenerType, title?: string): Screen => (type === "etf" ? defaultEtfScreen(title) : defaultScreen(title));

// ── Popular screens ───────────────────────────────────────────────────────
/** The reference app "Popular screens" (03/11/2026, in its order) whose filters, columns and sort the backend can
 *  serve. Left out: "Healthy growth technology stocks" (the reference sector names; ours are the industry
 *  classification's divisions), "Dividend princes" and "Dividend kings" (25 to 40+ years of dividends; the dividend
 *  history starts in 2003, the reference's about 1980). Each one = the default pills with the screen's own values, its extra filters after them,
 *  its column set and its sort (descending). */
export type PopularScreen = { id: string; title: string; description: string; screen: (pills?: ColumnRef[]) => Screen };

type PopFilter =
  | { col: ColumnRef; operation: Operation; right: ConditionFilter["right"] }
  | { col: ColumnRef; operation: OffsetOperation; offsetRangeId: OffsetRangeId; target: string; right: ConditionFilter["right"] }
  | { col: ColumnRef; values: string[] };

const atLeast = (col: ColumnRef, v: number): PopFilter => ({ col, operation: "between", right: { left: v, right: null } });
const atMost = (col: ColumnRef, v: number): PopFilter => ({ col, operation: "between", right: { left: null, right: v } });
const above = (col: ColumnRef, v: number): PopFilter => ({ col, operation: "above", right: { value: v } });
const below = (col: ColumnRef, v: number): PopFilter => ({ col, operation: "below", right: { value: v } });
const MKT_CAP = C("MarketCap");
const EPS_GROWTH = C("EpsDilutedGrowth", YOY_TTM);

function popular(id: string, title: string, description: string, setId: string, sortBy: ColumnRef, filters: PopFilter[] = []): PopularScreen {
  return {
    id,
    title,
    description,
    screen: (pills) => {
      const s = defaultScreen(title, pills);
      for (const f of filters) {
        const filter: Filter =
          "values" in f
            ? { id: newFilterId(), type: "CheckboxGroup", left: f.col, values: f.values }
            : "offsetRangeId" in f
              ? { id: newFilterId(), type: "Condition", left: f.col, operation: f.operation, offsetRangeId: f.offsetRangeId, target: f.target, right: f.right }
              : { id: newFilterId(), type: "Condition", left: f.col, operation: f.operation, target: "value", right: f.right };
        const at = s.filters.findIndex((x) => sameColumn(x.left, f.col));
        if (at >= 0) s.filters[at] = { ...filter, id: s.filters[at].id };
        else s.filters.push(filter);
      }
      s.activeColumnSetId = setId;
      s.sort = { sortBy, sortOrder: "desc" };
      return s;
    },
  };
}

export const POPULAR_SCREENS: PopularScreen[] = [
  popular("14", "All stocks", "Complete list of stocks by market cap", "overview", MKT_CAP),
  popular("1", "Most capitalized", "Largest companies by market cap", "overview", MKT_CAP, [atLeast(MKT_CAP, 1e10)]),
  popular("2", "Highest net income", "Stocks raking in the cash", "incomeStatement", C("NetIncome", TTM), [atLeast(MKT_CAP, 1e10)]),
  popular("3", "Highest cash", "Companies with the most cash on hand", "balanceSheet", C("CashNShortTermInvest", FQ), [atLeast(MKT_CAP, 1e10)]),
  popular("4", "Close to new-high and undervalued", "Stocks breaking new local high backed by strong fundamentals", "overview", MKT_CAP, [
    atLeast(MKT_CAP, 7.5e8),
    atMost(C("PriceToEarnings"), 20),
    above(EPS_GROWTH, 25),
    { col: C("High", { timebased: "Interval52Weeks" }), operation: "abovePercent", offsetRangeId: "offset_range_0_10", target: "Price", right: { column: PRICE } },
  ]),
  popular("6", "High capital efficiency stocks", "Stocks with industry-high capital efficiency ratios", "overview", MKT_CAP, [
    above(EPS_GROWTH, 15),
    above(C("ReturnOnEquity", FY), 30),
    above(C("ReturnOnInvestedCapital", FY), 20),
    above(C("ReturnOnAssets", FY), 15),
  ]),
  popular("7", "Strong performance small caps", "Small-cap stocks with strong fundamentals", "overview", MKT_CAP, [
    above(C("Change", R1D), 7),
    atMost(MKT_CAP, 1e9),
    above(EPS_GROWTH, 25),
    above(C("EpsDiluted", TTM), 0),
  ]),
  popular("8", "Debt reduction and business growth", "Stocks of companies with both significantly improving debt level and business performance", "overview", MKT_CAP, [
    above(C("RevenueGrowth", YOY_TTM), 15),
    below(C("TotalDebtGrowth", YOY_FY), -15),
    below(C("DebtToEquityRatio", FQ), 1),
    above(C("EbitdaGrowth", YOY_TTM), 15),
  ]),
  popular("11", "Bullish and undervalued", "Technically and fundamentally undervalued stocks", "overview", MKT_CAP, [
    atMost(C("PriceToEarnings"), 20),
    above(EPS_GROWTH, 25),
    above(C("RevenueGrowth", YOY_TTM), 15),
    below(C("PriceToEarningsToGrowth", TTM), 1),
    atMost(C("PriceToSales"), 2),
    { col: C("TechnicalRating", R1D), values: ["Buy", "StrongBuy"] },
  ]),
  popular("12", "Large, efficient and innovative", "Blue chip stocks with industry-high revenues per employee", "overview", MKT_CAP, [
    atLeast(MKT_CAP, 1e10),
    above(C("RevenuePerEmployee", FY), 500000),
    above(C("ResearchNDevelopmentRatio", TTM), 5),
  ]),
  popular("13", "Doubled", "Large cap stocks that've doubled their market cap in the last year", "valuation", C("MarketCapPerf", { interval: "Interval1Y" }), [
    atLeast(MKT_CAP, 1e10),
    above(C("MarketCapPerf", { interval: "Interval1Y" }), 100),
  ]),
];

const AUM = C("AssetsUnderManagement");
/** The reference ETF popular screens that need no fund data we lack (the other 11 filter on asset class, focus,
 *  NAV total return, leverage, fund flows, strategy...). */
export const POPULAR_ETF_SCREENS: PopularScreen[] = [
  { id: "etf-13", title: "ETF vault", description: "All ETFs ranked by total assets under management", screen: () => defaultEtfScreen("ETF vault") },
  {
    id: "etf-12",
    title: "Largest AUM",
    description: "The biggest, baddest ETFs, as ranked by assets under management",
    screen: () => {
      const s = defaultEtfScreen("Largest AUM");
      s.filters = s.filters.map((f) => (sameColumn(f.left, AUM) ? { id: f.id, type: "Condition", left: AUM, operation: "between", target: "value", right: { left: 1e9, right: null } } : f));
      return s;
    },
  },
];
export const popularScreens = (type: ScreenerType) => (type === "etf" ? POPULAR_ETF_SCREENS : POPULAR_SCREENS);
