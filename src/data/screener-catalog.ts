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

export type ColumnRef = { id: string; params: Record<string, string> };

/** Cell / value format. */
export type Fmt =
  | "price" //       14.82 USD
  | "signedPrice" // +0.12 USD, colored
  | "change" //      +6.47%, colored
  | "percent" //     5.22%
  | "volume" //      9.07 M
  | "money" //       4.8 B USD
  | "number" //      1.79
  | "integer" //     25
  | "date" //        27/09/2026 (UNIX seconds)
  | "text";

export type Category = "securityInfo" | "marketData" | "technicals" | "financials" | "valuation" | "growth" | "margins" | "dividends";

/** The reference app filter operations the backend can evaluate (crosses and the % offset
 *  manual operations are left out). */
export type Operation = "above" | "aboveOrEqual" | "below" | "belowOrEqual" | "equal" | "nequal" | "between" | "outside";
/** Operations only used by presets (EMA/SMA deviation from price). */
export type OffsetOperation = "abovePercent" | "belowPercent";
export type OffsetRangeId = "offset_range_0_10" | "offset_range_10" | "offset_range_20";

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
    | { type: "CheckboxGroup"; options: [value: string, label: string][] | "data"; codes?: boolean; adaptive?: boolean };
  /** Text shown for a raw cell value (a list of codes shown as names). */
  cellText?: (raw: string) => string;
  /** Kept out of the Column setup list (the reference app `isExcludedFromColumnsList`). */
  noColumn?: boolean;
  /** A financial amount: shown in the "Convert financials" currency when that setting is on (prices are not). */
  financial?: boolean;
};

// ── Param option sets ─────────────────────────────────────────────────────
const RES_1D = (field: string): ParamDef[] => [
  { key: "resolution", title: "Interval", default: "TimeResolution1D", options: [{ value: "TimeResolution1D", label: "1 day", short: "1D", field }] },
];
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
const MA_PRESETS = (id: "Ema" | "Ma"): Preset[] => [
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

// Price-like right-hand targets (the reference app groups: Value | Open High Low Price | EMA SMA).
const PRICE_TARGETS = (self: string) => [["value"], ["Open", "High", "Low", "Price"].filter((x) => x !== self), ["Ema", "Ma"]];
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
type FundSpec = [id: string, title: string, short: string, category: Category, fmt: Fmt, source: string | ParamDef[], financial?: boolean];
const fund = ([id, title, short, category, fmt, source, financial]: FundSpec): ColumnDef => ({
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
const FUNDAMENTALS: ColumnDef[] = ([
  // Security info
  ["RecentFiscalPeriod", "Recent fiscal period", "Fiscal period", "securityInfo", "text", FP(["current", "f.fiscal_period"])],
  ["FiscalPeriodEndDate", "Fiscal period end date", "Fiscal period end", "securityInfo", "date", FP(["current", "f.fiscal_period_end"])],
  // Financials: income statement, balance sheet, cash flow
  ["TotalRevenue", "Total revenue", "Revenue", "financials", "money", FP(["ttm", "f.revenue_ttm"]), true],
  ["GrossProfit", "Gross profit", "Gross profit", "financials", "money", FP(["ttm", "f.gross_profit_ttm"]), true],
  ["OperatingIncome", "Operating income", "Op income", "financials", "money", FP(["ttm", "f.operating_income_ttm"]), true],
  ["NetIncome", "Net income", "Net income", "financials", "money", FP(["ttm", "f.net_income_ttm"]), true],
  ["Ebitda", "EBITDA", "EBITDA", "financials", "money", FP(["ttm", "f.ebitda_ttm"]), true],
  ["EpsDiluted", "Earnings per share diluted", "EPS dil", "financials", "price", FP(["ttm", "f.eps_dil_ttm"]), true],
  ["BasicEps", "Basic earnings per share", "EPS basic", "financials", "price", FP(["ttm", "f.eps_basic_ttm"]), true],
  ["TotalAssets", "Total assets", "Total assets", "financials", "money", FP(["fq", "f.total_assets_fq"]), true],
  ["TotalCurrentAssets", "Total current assets", "Current assets", "financials", "money", FP(["fq", "f.current_assets_fq"]), true],
  ["CashNShortTermInvest", "Cash and short-term investments", "Cash on hand", "financials", "money", FP(["fq", "f.cash_fq"]), true],
  ["TotalLiabilities", "Total liabilities", "Total liabilities", "financials", "money", FP(["fq", "f.total_liabilities_fq"]), true],
  ["TotalDebt", "Total debt", "Total debt", "financials", "money", FP(["fq", "f.total_debt_fq"]), true],
  ["NetDebt", "Net debt", "Net debt", "financials", "money", FP(["fq", "f.net_debt_fq"]), true],
  ["TotalEquity", "Total equity", "Total equity", "financials", "money", FP(["fq", "f.total_equity_fq"]), true],
  ["CashFromOperating", "Cash flow from operating activities", "Operating CF", "financials", "money", FP(["ttm", "f.cfo_ttm"]), true],
  ["CashFromInvesting", "Cash flow from investing activities", "Investing CF", "financials", "money", FP(["ttm", "f.cfi_ttm"]), true],
  ["CashFromFinancing", "Cash flow from financing activities", "Financing CF", "financials", "money", FP(["ttm", "f.cff_ttm"]), true],
  ["FreeCashFlow", "Free cash flow", "FCF", "financials", "money", FP(["ttm", "f.fcf_ttm"]), true],
  ["CapitalExpenditures", "Capital expenditures", "CapEx", "financials", "money", FP(["ttm", "f.capex_ttm"]), true],
  // Valuation (price ratios computed with the live price)
  ["PriceToEarnings", "Price to earnings ratio", "P/E", "valuation", "number", "f.pe"],
  ["PriceToEarningsToGrowth", "Price to earning to growth", "PEG", "valuation", "number", FP(["ttm", "f.peg"])],
  ["PriceToSales", "Price to sales ratio", "P/S", "valuation", "number", "f.ps"],
  ["PriceToBook", "Price to book ratio", "P/B", "valuation", "number", "f.pb"],
  ["PriceToCashFlow", "Price to cash flow ratio", "P/CF", "valuation", "number", "f.pcf"],
  ["PriceToFreeCashFlow", "Price to free cash flow ratio", "P/FCF", "valuation", "number", "f.pfcf"],
  ["PriceToCashRatio", "Price to cash ratio", "Price/cash", "valuation", "number", "f.pcash"],
  ["Ev", "Enterprise value", "EV", "valuation", "money", "f.ev", true],
  ["EvToRevenue", "Enterprise value to revenue ratio", "EV/revenue", "valuation", "number", FP(["ttm", "f.ev_revenue"])],
  ["EvToEbit", "Enterprise value to EBIT ratio", "EV/EBIT", "valuation", "number", FP(["ttm", "f.ev_ebit"])],
  ["EvToEbitda", "Enterprise value to EBITDA ratio", "EV/EBITDA", "valuation", "number", FP(["ttm", "f.ev_ebitda"])],
  ["MarketCapPerf", "Market capitalization performance %", "Mkt cap perf %", "valuation", "change",
    [{ key: "interval", title: "Date Range", default: "Interval1Y", options: [{ value: "Interval1Y", label: "1 year", short: "1Y", field: "f.market_cap_perf_1y" }] }]],
  // Growth
  ["RevenueGrowth", "Revenue growth %", "Revenue growth", "growth", "change", YOY("YoYTTM", "f.revenue_growth_ttm_yoy")],
  ["EpsDilutedGrowth", "Earnings per share diluted growth %", "EPS dil growth", "growth", "change", YOY("YoYTTM", "f.eps_dil_growth_ttm_yoy")],
  ["EbitdaGrowth", "EBITDA growth %", "EBITDA growth %", "growth", "change", YOY("YoYTTM", "f.ebitda_growth_ttm_yoy")],
  ["TotalDebtGrowth", "Total debt growth %", "Total debt growth %", "growth", "change", YOY("YoYAnnual", "f.total_debt_growth_fy_yoy")],
  // Margins and ratios
  ["GrossMargin", "Gross margin %", "Gross margin", "margins", "percent", FP(["ttm", "f.gross_margin_ttm"])],
  ["OperatingMargin", "Operating margin %", "Op margin %", "margins", "percent", FP(["ttm", "f.operating_margin_ttm"])],
  ["PreTaxMargin", "Pretax margin %", "Pretax margin", "margins", "percent", FP(["ttm", "f.pretax_margin_ttm"])],
  ["NetMargin", "Net margin %", "Net margin %", "margins", "percent", FP(["ttm", "f.net_margin_ttm"])],
  ["FreeCashFlowMargin", "Free cash flow margin %", "FCF margin", "margins", "percent", FP(["ttm", "f.fcf_margin_ttm"])],
  ["ReturnOnAssets", "Return on assets %", "ROA", "margins", "percent", FP(["ttm", "f.roa_ttm"], ["fy", "f.roa_fy"])],
  ["ReturnOnEquity", "Return on equity %", "ROE", "margins", "percent", FP(["ttm", "f.roe_ttm"], ["fy", "f.roe_fy"])],
  ["ReturnOnInvestedCapital", "Return on invested capital %", "ROIC", "margins", "percent", FP(["ttm", "f.roic_ttm"], ["fy", "f.roic_fy"])],
  ["ResearchNDevelopmentRatio", "Research and development ratio", "R&D ratio", "margins", "percent", FP(["ttm", "f.rnd_ratio_ttm"])],
  ["SellingGeneralNAdminExpensesRatio", "Selling, general, and admin expenses ratio", "SG&A ratio", "margins", "percent", FP(["ttm", "f.sga_ratio_ttm"])],
  ["CurrentRatio", "Current ratio", "Current ratio", "margins", "number", FP(["fq", "f.current_ratio_fq"])],
  ["QuickRatio", "Quick ratio", "Quick ratio", "margins", "number", FP(["fq", "f.quick_ratio_fq"])],
  ["DebtToEquityRatio", "Debt to equity ratio", "Debt/equity", "margins", "number", FP(["fq", "f.debt_to_equity_fq"])],
  ["CashToDebt", "Cash to debt ratio", "Cash/debt", "margins", "number", FP(["fq", "f.cash_to_debt_fq"])],
  ["RevenuePerShare", "Revenue per share", "Revenue per share", "margins", "price", FP(["ttm", "f.revenue_ps_ttm"]), true],
  ["OperatingCashFlowPerShare", "Operating cash flow per share", "Op cash flow per share", "margins", "price", FP(["ttm", "f.ocf_ps_ttm"]), true],
  ["FreeCashFlowPerShare", "Free cash flow per share", "FCF per share", "margins", "price", FP(["ttm", "f.fcf_ps_ttm"]), true],
  ["EBITPerShare", "EBIT per share", "EBIT per share", "margins", "price", FP(["ttm", "f.ebit_ps_ttm"]), true],
  ["EBITDAPerShare", "EBITDA per share", "EBITDA per share", "margins", "price", FP(["ttm", "f.ebitda_ps_ttm"]), true],
  ["BookPerShare", "Book value per share", "Book per share", "margins", "price", FP(["fq", "f.book_ps_fq"]), true],
  ["TotalDebtPerShare", "Total debt per share", "Total debt per share", "margins", "price", FP(["fq", "f.debt_ps_fq"]), true],
  ["CashPerShare", "Cash per share", "Cash per share", "margins", "price", FP(["fq", "f.cash_ps_fq"]), true],
  // Dividends
  ["DividendsPerShare", "Dividends per share", "Div per share", "dividends", "price", FP(["fy", "f.dps_fy"], ["fq", "f.dps_fq"]), true],
  ["DividendsYieldForward", "Dividend yield % (indicated)", "Div yield % (indicated)", "dividends", "percent", "f.div_yield_indicated"],
  ["DividendPayoutRatio", "Dividend payout ratio %", "Div payout ratio %", "dividends", "percent", FP(["ttm", "f.payout_ratio_ttm"])],
  ["DividendsPerShareGrowth", "Dividends per share growth %", "DPS growth %", "dividends", "change", YOY("YoYAnnual", "f.dps_growth_fy_yoy")],
  ["ContinuousDivPayout", "Continuous dividend payout", "Cont div payout", "dividends", "integer", "f.cont_div_payout"],
  ["ContinuousDivGrowth", "Continuous dividend growth", "Cont div growth", "dividends", "integer", "f.cont_div_growth"],
] as FundSpec[]).map(fund);

// ── Column catalog ────────────────────────────────────────────────────────
export const COLUMNS: ColumnDef[] = [
  // Security info
  { id: "Index", title: "Index", short: "Index", category: "securityInfo", align: "left", fmt: "text", width: 175, field: "indexes",
    filter: { type: "CheckboxGroup", options: INDEXES, codes: true, adaptive: true }, cellText: indexNames },
  { id: "Sector", title: "Sector", short: "Sector", category: "securityInfo", align: "left", fmt: "text", width: 175, field: "sector", filter: { type: "CheckboxGroup", options: "data" } },
  { id: "Industry", title: "Industry", short: "Industry", category: "securityInfo", align: "left", fmt: "text", width: 200, field: "industry", filter: { type: "CheckboxGroup", options: "data" } },
  { id: "Exchange", title: "Exchange", short: "Exchange", category: "securityInfo", align: "left", fmt: "text", width: 99, field: "exchange" },
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
  { id: "Change", title: "Price change %", short: "Chg %", category: "marketData", align: "right", fmt: "change", width: 80, params: RES_1D("change"),
    filter: { type: "Condition", operations: CHANGE_OPS, defaultOperation: "above", targets: [["value", "ChangeFromOpen", "Gap", "Change"]], presets: BANDS } },
  { id: "ChangeAbs", title: "Price change", short: "Chg", category: "marketData", align: "right", fmt: "signedPrice", width: 86, params: RES_1D("change_abs"),
    filter: { type: "Condition", operations: CHANGE_OPS, defaultOperation: "above", targets: [["value"]], presets: [
      { operation: "below", target: "value", right: { value: 1 } },
      { operation: "between", target: "value", right: { left: 1, right: 10 } },
      { operation: "between", target: "value", right: { left: 10, right: 100 } },
      { operation: "above", target: "value", right: { value: 100 } },
    ] } },
  { id: "ChangeFromOpen", title: "Change from open %", short: "Chg from open %", category: "marketData", align: "right", fmt: "change", width: 90, params: RES_1D("change_from_open"),
    filter: { type: "Condition", operations: CHANGE_OPS, defaultOperation: "above", targets: [["value"]], presets: BANDS } },
  { id: "Gap", title: "Gap %", short: "Gap %", category: "marketData", align: "right", fmt: "change", width: 74, params: RES_1D("gap"),
    filter: { type: "Condition", operations: CHANGE_OPS, defaultOperation: "above", targets: [["value"]], presets: BANDS } },
  { id: "High", title: "High", short: "High", category: "marketData", align: "right", fmt: "price", width: 99,
    params: TIMEBASED({ "1D": "high", "1M": "High.1M", "3M": "High.3M", "6M": "High.6M", "52W": "price_52_week_high" }),
    filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "aboveOrEqual", targets: PRICE_TARGETS("High") } },
  { id: "Low", title: "Low", short: "Low", category: "marketData", align: "right", fmt: "price", width: 99,
    params: TIMEBASED({ "1D": "low", "1M": "Low.1M", "3M": "Low.3M", "6M": "Low.6M", "52W": "price_52_week_low" }),
    filter: { type: "Condition", operations: ALL_OPS, defaultOperation: "aboveOrEqual", targets: PRICE_TARGETS("Low") } },
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
  { id: "VolumePrice", title: "Price × volume (turnover)", short: "Price × vol", category: "marketData", align: "right", fmt: "money", width: 99, params: RES_1D("Value.Traded"),
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value"]], presets: [
      { operation: "above", target: "value", right: { value: 1e9 } },
      { operation: "above", target: "value", right: { value: 1e8 } },
      { operation: "above", target: "value", right: { value: 1e7 } },
      { operation: "below", target: "value", right: { value: 1e6 } },
    ] } },
  { id: "Volatility", title: "Volatility", short: "Volatility", category: "marketData", align: "right", fmt: "percent", width: 86,
    params: [{ key: "interval", title: "Date Range", default: "Interval1D", options: [{ value: "Interval1D", label: "1 day", short: "1D", field: "Volatility.D" }] }],
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
  { id: "Volume", title: "Volume", short: "Vol", category: "marketData", align: "right", fmt: "volume", width: 90, params: RES_1D("volume"),
    filter: { type: "Condition", operations: ["above", "below", "between", "outside", "equal"], defaultOperation: "above", targets: [["value", "AverageVolume", "Volume"]] } },
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
  // ETF: assets under management (shares outstanding x price).
  { id: "AssetsUnderManagement", title: "Assets under management", short: "AUM", category: "valuation", align: "right", fmt: "money", width: 110, field: "market_cap_basic", financial: true,
    filter: { type: "Condition", operations: ["between"], defaultOperation: "between", targets: [["value"]] } },
];

/** Columns of the ETF Screener (the reference ETF catalog restricted to ours): market data, technicals, exchange,
 *  indicated dividend yield and AUM. The Stock Screener has every other column. */
const ETF_EXTRA = new Set(["Exchange", "DividendsYieldForward", "AssetsUnderManagement"]);
export function columnForType(def: ColumnDef, type: ScreenerType): boolean {
  if (def.id === "AssetsUnderManagement") return type === "etf";
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

export const OPERATION_LABEL: Record<Operation, string> = {
  above: "Above",
  aboveOrEqual: "Above or equal",
  below: "Below",
  belowOrEqual: "Below or equal",
  equal: "Equal",
  nequal: "Not equal",
  between: "Between",
  outside: "Outside",
};
/** 18 px pill icon / 28 px menu icon per operation. */
export const OPERATION_ICON: Record<Operation, string> = {
  above: "above",
  aboveOrEqual: "above-or-equal",
  below: "below",
  belowOrEqual: "below-or-equal",
  equal: "equal",
  nequal: "not-equal",
  between: "between",
  outside: "outside",
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

/** "EMA, 50" / "High, 1M" / "Chg %": the reference app configured short title. */
export function configuredShort(col: ColumnRef): string {
  const def = COLUMN_BY_ID[col.id];
  if (!def) return col.id;
  return [def.short, ...paramShorts(col)].join(", ");
}

/** "Price change %, 1 day": the reference app configured long title (header tooltip). */
export function configuredLong(col: ColumnRef): string {
  const def = COLUMN_BY_ID[col.id];
  if (!def) return col.id;
  const p = fullParams(def, col.params);
  const parts = [def.title];
  for (const pd of def.params ?? []) {
    const opt = optionOf(pd, p[pd.key]);
    if (opt) parts.push(opt.label);
  }
  return parts.join(", ");
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
/** The reference app column-set presets, in the reference app menu order (03/11/2026). Columns without a data
 *  source are left out (ratings, estimates, extended hours, 10-year and all-time performance...); a preset
 *  with no column the backend has is not listed. */
export const COLUMN_SETS: { id: string; title: string; columns: ColumnRef[] }[] = [
  { id: "overview", title: "Overview", columns: [C("Price"), C("Change", R1D), C("Volume", R1D), C("RelativeVolume", R1D), C("MarketCap"), C("PriceToEarnings"),
    C("EpsDiluted", TTM), C("EpsDilutedGrowth", YOY_TTM), C("DividendsYield", TTM), C("Sector")] },
  { id: "performance", title: "Performance", columns: [C("Price"), C("Change", R1D),
    ...["Interval1W", "Interval1M", "Interval3M", "Interval6M", "IntervalYTD", "Interval1Y", "Interval5Y"].map((i) => C("Performance", { interval: i }))] },
  { id: "technicals", title: "Technicals", columns: [C("RelativeStrengthIndex", { resolution: "TimeResolution1D", length: "14" })] },
  { id: "extendedHours", title: "Extended hours", columns: [C("Price"), C("Change", R1D), C("Gap", R1D), C("Volume", R1D)] },
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
/** The reference ETF column sets restricted to ours (Fund flows, NAV performance and Holdings have no data source). */
export const ETF_COLUMN_SETS: { id: string; title: string; columns: ColumnRef[] }[] = [
  { id: "overview", title: "Overview", columns: [C("Price"), C("Change", R1D), C("VolumePrice", R1D), C("RelativeVolume", R1D), C("AssetsUnderManagement")] },
  { id: "performance", title: "Performance", columns: [C("Price"), C("Change", R1D),
    ...["Interval1W", "Interval1M", "Interval3M", "Interval6M", "IntervalYTD", "Interval1Y", "Interval5Y"].map((i) => C("Performance", { interval: i }))] },
  { id: "technicals", title: "Technicals", columns: [C("RelativeStrengthIndex", { resolution: "TimeResolution1D", length: "14" })] },
  { id: "extendedHours", title: "Extended hours", columns: [C("Price"), C("Change", R1D), C("Gap", R1D), C("Volume", R1D)] },
  { id: "dividends", title: "Dividends", columns: [C("Price"), C("DividendsYieldForward")] },
  { id: "risk", title: "Risk", columns: [C("Beta", { interval: "Interval1Y" }), C("Beta", { interval: "Interval3Y" }), C("Beta", { interval: "Interval5Y" }),
    C("Volatility", { interval: "Interval1D" })] },
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
 *  Analyst rating, Recent and Upcoming earnings date. */
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
];
/** Default pills of earlier versions (before dividend yield and beta, then
 *  before Index, then before the fundamentals). A stored screen still equal to
 *  one of those defaults moves to the current one. */
export const LEGACY_DEFAULT_PILLS: ColumnRef[][] = [
  [C("Price"), C("Change", R1D), C("MarketCap"), C("Sector"), C("Performance", { interval: "IntervalYTD" })],
  [C("Price"), C("Change", R1D), C("MarketCap"), C("DividendsYield", TTM), C("Sector"), C("Performance", { interval: "IntervalYTD" }), C("Beta", { interval: "Interval5Y" })],
  [C("Index"), C("Price"), C("Change", R1D), C("MarketCap"), C("DividendsYield", TTM), C("Sector"), C("Performance", { interval: "IntervalYTD" }), C("Beta", { interval: "Interval5Y" })],
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

/** The reference ETF default pills that have a data source (Asset class, Focus, Niche, Holdings region, Brand,
 *  NAV total return, Management style, Strategy, Div treat, Div freq, Leveraged, Expense ratio and UCITS have none). */
const ETF_DEFAULT_PILLS: ColumnRef[] = [C("Performance", { interval: "IntervalYTD" }), C("AssetsUnderManagement"), C("DividendsYieldForward")];

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
 *  history starts in 2003), "Bullish and undervalued" (technical rating) and "Large, efficient and innovative"
 *  (revenue per employee). Each one = the default pills with the screen's own values, its extra filters after them,
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
