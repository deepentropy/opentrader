/*
 * Stock screener catalog: the TradingView screener columns that the backend
 * table can fill, with their titles, formats, filter configs, filter presets,
 * column sets and the default screen.
 *
 * Source: TradingView Desktop 3.4.1, read over CDP on 29/09/2026 from the
 * screener's own modules (getColumnConfig, getColumnFilterConfig, column
 * titles, presets data, redux store). Raw captures and the design notes are in
 * research/screener/ (doc/TV-SCREENER-DESIGN-3.4.1.md).
 *
 * A column is a TradingView table column id + params (`{ id: "Ema", params:
 * { length: "50" } }`), stored like TV stores it in a screen. Each param
 * option maps to one backend field id (TradingView scanner name, e.g. EMA50).
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
  | "text";

export type Category = "securityInfo" | "marketData" | "technicals" | "valuation";

/** TV filter operations the backend can evaluate (crosses and the % offset
 *  manual operations are left out). */
export type Operation = "above" | "aboveOrEqual" | "below" | "belowOrEqual" | "equal" | "nequal" | "between" | "outside";
/** Operations only used by presets (EMA/SMA deviation from price). */
export type OffsetOperation = "abovePercent" | "belowPercent";
export type OffsetRangeId = "offset_range_0_10" | "offset_range_10" | "offset_range_20";

export type ParamOption = { value: string; label: string; short: string; field: string };
export type ParamDef = { key: string; title: string; default: string; options: ParamOption[] };

/** One filter preset (a row of the pill popover list). */
export type Preset = {
  operation: Operation | OffsetOperation;
  offsetRangeId?: OffsetRangeId;
  /** "value" or the TV id of the right column. */
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
    | { type: "CheckboxGroup"; options: [value: string, label: string][] };
  /** Kept out of the Column setup list (TV `isExcludedFromColumnsList`). */
  noColumn?: boolean;
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
  },
  { key: "resolution", title: "Interval", default: "TimeResolution1D", options: [{ value: "TimeResolution1D", label: "1 day", short: "1D", field: "" }] },
];

// ── Presets (TV presets data, crosses left out) ───────────────────────────
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

// Price-like right-hand targets (TV groups: Value | Open High Low Price | EMA SMA).
const PRICE_TARGETS = (self: string) => [["value"], ["Open", "High", "Low", "Price"].filter((x) => x !== self), ["Ema", "Ma"]];
const ALL_OPS: Operation[] = ["above", "aboveOrEqual", "below", "belowOrEqual", "between", "outside", "equal"];
const CHANGE_OPS: Operation[] = ["above", "below", "between", "outside", "equal"];

const SECTORS: [string, string][] = [
  ["Commercial Services", "Commercial services"], ["Communications", "Communications"], ["Consumer Durables", "Consumer durables"],
  ["Consumer Non-Durables", "Consumer non-durables"], ["Consumer Services", "Consumer services"], ["Distribution Services", "Distribution services"],
  ["Electronic Technology", "Electronic technology"], ["Energy Minerals", "Energy minerals"], ["Finance", "Finance"], ["Government", "Government"],
  ["Health Services", "Health services"], ["Health Technology", "Health technology"], ["Industrial Services", "Industrial services"],
  ["Miscellaneous", "Miscellaneous"], ["Non-Energy Minerals", "Non-energy minerals"], ["Process Industries", "Process industries"],
  ["Producer Manufacturing", "Producer manufacturing"], ["Retail Trade", "Retail trade"], ["Technology Services", "Technology services"],
  ["Transportation", "Transportation"], ["Utilities", "Utilities"],
];
// TV value → display label (sentence case) is the same rule for industries:
// only the first letter of each word after the first one is lowered, except
// acronyms and words after a slash or colon keep TV's case. The explicit list
// below is the TV list verbatim.
const INDUSTRIES: [string, string][] = ([
  "Advertising/Marketing Services|Advertising/Marketing services", "Aerospace & Defense|Aerospace & defense",
  "Agricultural Commodities/Milling|Agricultural commodities/Milling", "Air Freight/Couriers|Air freight/Couriers", "Airlines|Airlines",
  "Alternative Power Generation|Alternative power generation", "Aluminum|Aluminum", "Apparel/Footwear|Apparel/Footwear",
  "Apparel/Footwear Retail|Apparel/Footwear retail", "Auto Parts: OEM|Auto parts: OEM", "Automotive Aftermarket|Automotive aftermarket",
  "Beverages: Alcoholic|Beverages: alcoholic", "Beverages: Non-Alcoholic|Beverages: non-alcoholic", "Biotechnology|Biotechnology",
  "Broadcasting|Broadcasting", "Building Products|Building products", "Cable/Satellite TV|Cable/Satellite TV", "Casinos/Gaming|Casinos/Gaming",
  "Catalog/Specialty Distribution|Catalog/Specialty distribution", "Chemicals: Agricultural|Chemicals: agricultural",
  "Chemicals: Major Diversified|Chemicals: major diversified", "Chemicals: Specialty|Chemicals: specialty", "Coal|Coal",
  "Commercial Printing/Forms|Commercial printing/Forms", "Computer Communications|Computer communications",
  "Computer Peripherals|Computer peripherals", "Computer Processing Hardware|Computer processing hardware",
  "Construction Materials|Construction materials", "Consumer Sundries|Consumer sundries", "Containers/Packaging|Containers/Packaging",
  "Contract Drilling|Contract drilling", "Data Processing Services|Data processing services", "Department Stores|Department stores",
  "Discount Stores|Discount stores", "Drugstore Chains|Drugstore chains", "Electric Utilities|Electric utilities",
  "Electrical Products|Electrical products", "Electronic Components|Electronic components",
  "Electronic Equipment/Instruments|Electronic equipment/Instruments", "Electronic Production Equipment|Electronic production equipment",
  "Electronics Distributors|Electronics distributors", "Electronics/Appliance Stores|Electronics/Appliance stores",
  "Electronics/Appliances|Electronics/Appliances", "Engineering & Construction|Engineering & construction",
  "Environmental Services|Environmental services", "Finance/Rental/Leasing|Finance/Rental/Leasing",
  "Financial Conglomerates|Financial conglomerates", "Financial Publishing/Services|Financial publishing/Services",
  "Food Distributors|Food distributors", "Food Retail|Food retail", "Food: Major Diversified|Food: major diversified",
  "Food: Meat/Fish/Dairy|Food: meat/fish/dairy", "Food: Specialty/Candy|Food: specialty/candy", "Forest Products|Forest products",
  "Gas Distributors|Gas distributors", "General Government|General government", "Home Furnishings|Home furnishings",
  "Home Improvement Chains|Home improvement chains", "Homebuilding|Homebuilding", "Hospital/Nursing Management|Hospital/Nursing management",
  "Hotels/Resorts/Cruise lines|Hotels/Resorts/Cruise lines", "Household/Personal Care|Household/Personal care",
  "Industrial Conglomerates|Industrial conglomerates", "Industrial Machinery|Industrial machinery",
  "Industrial Specialties|Industrial specialties", "Information Technology Services|Information technology services",
  "Insurance Brokers/Services|Insurance brokers/Services", "Integrated Oil|Integrated oil", "Internet Retail|Internet retail",
  "Internet Software/Services|Internet software/Services", "Investment Banks/Brokers|Investment banks/Brokers",
  "Investment Managers|Investment managers", "Investment Trusts/Mutual Funds|Investment trusts", "Life/Health Insurance|Life/Health insurance",
  "Major Banks|Major banks", "Major Telecommunications|Major telecommunications", "Managed Health Care|Managed health care",
  "Marine Shipping|Marine shipping", "Media Conglomerates|Media conglomerates", "Medical Distributors|Medical distributors",
  "Medical Specialties|Medical specialties", "Medical/Nursing Services|Medical/Nursing services", "Metal Fabrication|Metal fabrication",
  "Miscellaneous|Miscellaneous", "Miscellaneous Commercial Services|Miscellaneous commercial services",
  "Miscellaneous Manufacturing|Miscellaneous manufacturing", "Motor Vehicles|Motor vehicles", "Movies/Entertainment|Movies/Entertainment",
  "Multi-Line Insurance|Multi-line insurance", "Office Equipment/Supplies|Office equipment/Supplies",
  "Oil & Gas Pipelines|Oil & gas pipelines", "Oil & Gas Production|Oil & gas production", "Oil Refining/Marketing|Oil refining/Marketing",
  "Oilfield Services/Equipment|Oilfield services/Equipment", "Other Consumer Services|Other consumer services",
  "Other Consumer Specialties|Other consumer specialties", "Other Metals/Minerals|Other metals/Minerals",
  "Other Transportation|Other transportation", "Packaged Software|Packaged software", "Personnel Services|Personnel services",
  "Pharmaceuticals: Generic|Pharmaceuticals: generic", "Pharmaceuticals: Major|Pharmaceuticals: major",
  "Pharmaceuticals: Other|Pharmaceuticals: other", "Precious Metals|Precious metals", "Property/Casualty Insurance|Property/Casualty insurance",
  "Publishing: Books/Magazines|Publishing: books/magazines", "Publishing: Newspapers|Publishing: newspapers", "Pulp & Paper|Pulp & paper",
  "Railroads|Railroads", "Real Estate Development|Real estate development", "Real Estate Investment Trusts|Real estate investment trusts",
  "Recreational Products|Recreational products", "Regional Banks|Regional banks", "Restaurants|Restaurants", "Savings Banks|Savings banks",
  "Semiconductors|Semiconductors", "Services to the Health Industry|Services to the health industry", "Specialty Insurance|Specialty insurance",
  "Specialty Stores|Specialty stores", "Specialty Telecommunications|Specialty telecommunications", "Steel|Steel",
  "Telecommunications Equipment|Telecommunications equipment", "Textiles|Textiles", "Tobacco|Tobacco", "Tools & Hardware|Tools & hardware",
  "Trucking|Trucking", "Trucks/Construction/Farm Machinery|Trucks/Construction/Farm machinery", "Water Utilities|Water utilities",
  "Wholesale Distributors|Wholesale distributors", "Wireless Telecommunications|Wireless telecommunications",
] as const).map((s) => s.split("|") as [string, string]);

/** TV value → table label for text enums (sector/industry cells). */
export const ENUM_LABEL: Record<string, string> = Object.fromEntries([...SECTORS, ...INDUSTRIES]);

// ── Column catalog ────────────────────────────────────────────────────────
export const COLUMNS: ColumnDef[] = [
  // Security info
  { id: "Sector", title: "Sector", short: "Sector", category: "securityInfo", align: "left", fmt: "text", width: 175, field: "sector", filter: { type: "CheckboxGroup", options: SECTORS } },
  { id: "Industry", title: "Industry", short: "Industry", category: "securityInfo", align: "left", fmt: "text", width: 200, field: "industry", filter: { type: "CheckboxGroup", options: INDUSTRIES } },
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
    params: [{ key: "length", title: "Length", default: "14", options: [
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
  { id: "MarketCap", title: "Market capitalization", short: "Mkt cap", category: "valuation", align: "right", fmt: "money", width: 110, field: "market_cap_basic",
    filter: { type: "Condition", operations: ["between"], defaultOperation: "between", targets: [["value"]], presets: [
      { operation: "between", target: "value", right: { left: 200e9, right: null }, ...d("Mega") },
      { operation: "between", target: "value", right: { left: 10e9, right: 200e9 }, ...d("Large") },
      { operation: "between", target: "value", right: { left: 2e9, right: 10e9 }, ...d("Mid") },
      { operation: "between", target: "value", right: { left: 300e6, right: 2e9 }, ...d("Small") },
      { operation: "between", target: "value", right: { left: 50e6, right: 300e6 }, ...d("Micro") },
      { operation: "between", target: "value", right: { left: null, right: 50e6 }, ...d("Nano") },
    ] } },
];

export const COLUMN_BY_ID: Record<string, ColumnDef> = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));

/** The sticky first column (TV `TickerUniversal`). Sorting by it sends `name`. */
export const TICKER_COLUMN: ColumnRef = { id: "TickerUniversal", params: {} };
export const TICKER_SORT_FIELD = "name";

/** Add filter / Column setup categories, in TV order, with their icons. */
export const CATEGORIES: { id: Category; title: string; icon: string }[] = [
  { id: "securityInfo", title: "Security info", icon: "scr-cat-security-info" },
  { id: "marketData", title: "Market data", icon: "scr-cat-market-data" },
  { id: "technicals", title: "Technicals", icon: "scr-cat-technicals" },
  { id: "valuation", title: "Valuation", icon: "scr-cat-valuation" },
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
    const opt = pd.options.find((o) => o.value === p[pd.key]);
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
    const opt = pd.options.find((o) => o.value === p[pd.key]);
    if (!opt || opt.value === "TimeResolution1D") continue;
    out.push(opt.short);
  }
  return out;
}

/** "EMA, 50" / "High, 1M" / "Chg %": TV configured short title. */
export function configuredShort(col: ColumnRef): string {
  const def = COLUMN_BY_ID[col.id];
  if (!def) return col.id;
  return [def.short, ...paramShorts(col)].join(", ");
}

/** "Price change %, 1 day": TV configured long title (header tooltip). */
export function configuredLong(col: ColumnRef): string {
  const def = COLUMN_BY_ID[col.id];
  if (!def) return col.id;
  const p = fullParams(def, col.params);
  const parts = [def.title];
  for (const pd of def.params ?? []) {
    const opt = pd.options.find((o) => o.value === p[pd.key]);
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

// ── Column sets (TV presets restricted to the catalog) ────────────────────
const C = (id: string, params: Record<string, string> = {}): ColumnRef => ({ id, params });
const R1D = { resolution: "TimeResolution1D" };
/** TV column-set presets, in TV menu order. Columns without a data source
 *  are left out; a preset with no column left is not listed. */
export const COLUMN_SETS: { id: string; title: string; columns: ColumnRef[] }[] = [
  { id: "overview", title: "Overview", columns: [C("Price"), C("Change", R1D), C("Volume", R1D), C("RelativeVolume", R1D), C("MarketCap"), C("Sector")] },
  { id: "performance", title: "Performance", columns: [C("Price"), C("Change", R1D),
    ...["Interval1W", "Interval1M", "Interval3M", "Interval6M", "IntervalYTD", "Interval1Y"].map((i) => C("Performance", { interval: i }))] },
  { id: "technicals", title: "Technicals", columns: [C("RelativeStrengthIndex", { resolution: "TimeResolution1D", length: "14" })] },
  { id: "extendedHours", title: "Extended hours", columns: [C("Price"), C("Change", R1D), C("Gap", R1D), C("Volume", R1D)] },
  { id: "forecasts", title: "Forecasts", columns: [C("MarketCap"), C("Price")] },
  { id: "valuation", title: "Valuation", columns: [C("MarketCap")] },
];
export const CUSTOM_SET_ID = "custom";
export const CUSTOM_SET_TITLE = "Custom";

// ── Screen model (TV shape) ───────────────────────────────────────────────
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
};

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

/** TV default screen ("Untitled screen") restricted to the catalog: Price,
 *  Chg % 1D, Mkt cap, Sector and Perf % YTD pills, Overview columns, sorted by
 *  market cap. */
export function defaultScreen(title = DEFAULT_SCREEN_TITLE): Screen {
  const pills = [C("Price"), C("Change", R1D), C("MarketCap"), C("Sector"), C("Performance", { interval: "IntervalYTD" })];
  return {
    title,
    filters: pills.map((c) => emptyFilter(c)).filter((f): f is Filter => f !== null),
    customColumns: null,
    activeColumnSetId: "overview",
    sort: { sortBy: C("MarketCap"), sortOrder: "desc" },
    watchlistId: null,
  };
}
