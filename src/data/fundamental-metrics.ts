/*
 * Fundamentals metrics — the Indicators dialog's Fundamentals tab: each metric
 * of a company's financial statements (income statement, balance sheet, cash
 * flow) and statistics, computed from the statement items the backend serves
 * (`./fundamentals`).
 *
 * A statement metric has a value per fiscal period: quarter (FQ), year (FY)
 * or trailing twelve months (TTM: the sum of the last four quarters of an
 * amount over a period, the last quarter's balance of an amount at a date).
 * A price metric (market capitalization, P/E...) has a value per bar: the
 * bar's close with the latest period known at that bar.
 *
 * A period's value is known from the day its results were released (`date`):
 * the metric steps there.
 */
import type { Fundamentals, FundamentalPeriods } from "./fundamentals";

export type MetricPeriod = "FQ" | "FY" | "TTM";
export type MetricTab = "income" | "balance" | "cashflow" | "statistics";
/** How values are written: an amount of money, money per share, a share count, a percentage, a plain ratio, days. */
export type MetricKind = "money" | "perShare" | "shares" | "percent" | "ratio" | "days";

/** Statement item kinds (the backend's): how TTM is built from quarters. */
const FLOW_ITEMS = new Set([
  "revenue", "cogs", "grossProfit", "sga", "rnd", "operatingExpenses", "costsAndExpenses", "otherOperatingExpenses",
  "operatingIncome", "interestExpense", "interestExpenseDebt", "interestCapitalized", "interestIncome", "nonOperatingIncome",
  "otherNonOperatingIncome", "equityInEarnings", "impairments", "restructuring", "legalExpense", "unrealizedGain",
  "pretaxIncome", "incomeTax", "currentTax", "currentTaxFederal", "currentTaxState", "currentTaxDomestic", "currentTaxForeign", "deferredTax", "deferredTaxDomestic",
  "deferredTaxForeign", "taxCredits", "incomeContinuing", "discontinued", "minorityInterest", "netIncome",
  "preferredDividends", "netIncomeCommonDiluted", "epsBasic", "epsDiluted", "depreciationAmortization", "depreciation",
  "amortizationIntangibles", "amortizationDeferredCharges", "cashFromOperations", "cashFromInvesting", "cashFromFinancing",
  "shareBasedCompensation", "otherNonCashItems", "changeReceivables", "changeOtherReceivables", "changeInventories", "changePayables", "changeAccrued",
  "changeTaxes", "changeOther", "capex", "capexOther", "saleOfFixedAssets", "saleOfBusinesses", "acquisitions",
  "purchaseOfInvestments", "saleOfInvestments", "otherInvesting", "issuanceOfStock", "repurchaseOfStock", "issuanceOfDebt",
  "repaymentOfDebt", "shortTermDebtNet", "dividendsPaid", "commonDividendsPaid", "preferredDividendsPaid", "otherFinancing",
  "dividendsPerShare", "profitLoss", "proceedsShortTermDebt", "repaymentsShortTermDebt", "workingCapitalChange",
]);
/** Weighted average share counts: TTM is the mean of the four quarters. */
const AVERAGE_ITEMS = new Set(["sharesBasic", "sharesDiluted"]);

/** Values of one period, by item key (null: not reported). */
export type ItemGetter = (key: string) => number | null;

/** Sum of values, null when any is missing. */
const sum = (...v: (number | null)[]): number | null => (v.some((x) => x === null) ? null : (v as number[]).reduce((a, b) => a + b, 0));
/** Sum of the values present, null when none is. */
const sumAny = (...v: (number | null)[]): number | null => (v.every((x) => x === null) ? null : v.reduce<number>((a, b) => a + (b ?? 0), 0));
const neg = (v: number | null) => (v === null ? null : -v);
const sub = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
const div = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : a / b);
const pct = (a: number | null, b: number | null) => { const r = div(a, b); return r === null ? null : r * 100; };
const or = (...v: (number | null)[]) => v.find((x) => x !== null) ?? null;

/** Derived statement items shared by several metrics. */
/** Change in % from a year before (of the previous value's magnitude). */
const growth = (now: number | null, before: number | null) => (now === null || before === null || before === 0 ? null : ((now - before) / Math.abs(before)) * 100);

/** Mean of a balance now and a year before (the balance now when the year-ago one is missing). */
const avg = (now: number | null, before: number | null) => (now === null ? null : before === null ? null : (now + before) / 2);

const D = {
  grossProfit: (g: ItemGetter) => or(g("grossProfit"), sub(g("revenue"), g("cogs"))),
  operatingExpenses: (g: ItemGetter) => or(g("operatingExpenses"), sub(D.grossProfit(g), g("operatingIncome"))),
  ebitda: (g: ItemGetter) => sum(g("operatingIncome"), g("depreciationAmortization")),
  shortTermDebt: (g: ItemGetter) => sumAny(or(g("shortTermBorrowings"), g("commercialPaper")), g("currentLongTermDebt"), g("operatingLeaseLiabilityCurrent"), g("financeLeaseLiabilityCurrent")),
  longTermDebt: (g: ItemGetter) => sumAny(g("longTermDebt"), g("operatingLeaseLiability"), g("financeLeaseLiability")),
  totalDebt: (g: ItemGetter) => sumAny(D.shortTermDebt(g), D.longTermDebt(g)),
  totalLiabilities: (g: ItemGetter) => or(g("totalLiabilities"), sub(g("liabilitiesAndEquity"), g("totalEquity"))),
  /** Equity with the minority interest (redeemable included). */
  totalEquity: (g: ItemGetter) => sumAny(g("shareholdersEquity"), D.minorityInterest(g)),
  minorityInterest: (g: ItemGetter) => sumAny(g("minorityInterestEquity"), g("redeemableMinority")),
  /** Cash and equivalents with restricted cash. */
  cash: (g: ItemGetter) => or(g("cashRestricted"), g("cash")),
  cashAndShortTerm: (g: ItemGetter) => sumAny(D.cash(g), g("shortTermInvestments")),
  /** Net income to common shareholders over the period's weighted average shares. */
  netIncomeCommon: (g: ItemGetter) => or(g("netIncomeCommonDiluted"), sub(g("netIncome"), g("preferredDividends") ?? 0)),
  epsBasic: (g: ItemGetter) => or(div(sub(g("netIncome"), g("preferredDividends") ?? 0), g("sharesBasic")), g("epsBasic")),
  epsDiluted: (g: ItemGetter) => or(div(or(g("netIncomeCommonDiluted"), sub(g("netIncome"), g("preferredDividends") ?? 0)), g("sharesDiluted")), g("epsDiluted")),
  freeCashFlow: (g: ItemGetter) => sub(g("cashFromOperations"), g("capex")),
  sharesOutstanding: (g: ItemGetter) => or(g("sharesOutstanding"), g("sharesOutstandingBalance")),
  commonEquity: (g: ItemGetter) => sub(g("shareholdersEquity"), g("preferredStock") ?? 0),
  /** Long-term debt and shareholders' equity. */
  investedCapital: (g: ItemGetter) => sumAny(D.longTermDebt(g), g("shareholdersEquity")),
  intangiblesAll: (g: ItemGetter) => sumAny(g("goodwill"), g("intangibles")) ?? 0,
  netDebt: (g: ItemGetter) => sub(D.totalDebt(g), D.cashAndShortTerm(g)),
  shortTermDebtNet: (g: ItemGetter) => or(g("shortTermDebtNet"), sub(g("proceedsShortTermDebt"), g("repaymentsShortTermDebt") ?? 0)),
};

export type MetricDef = {
  /** Our key (stable: saved in layouts). */
  key: string;
  /** Name in the dialog and on the chart. */
  name: string;
  /** Legend title when shorter than the name. */
  short?: string;
  tab: MetricTab;
  /** 1 = listed under the metric above it. */
  depth: 0 | 1;
  /** Periods offered (first = the row's default); empty = a price metric (one value per bar). */
  periods: MetricPeriod[];
  kind: MetricKind;
  /** Plot colour. */
  color?: string;
  /** Statement metric: its value for one period. `ya`: the same period a year before; `t`: the twelve months
   *  ending with the period (the TTM at a quarter, the year itself); null when not known. */
  value?: (g: ItemGetter, ya: ItemGetter | null, t: ItemGetter | null) => number | null;
  /** TTM is the sum of the four quarters' values (per-share amounts), not the formula over the summed items. */
  ttmSum?: boolean;
  /** Price metric: its value at a bar from the close and the latest periods (TTM and the last quarter). */
  price?: (close: number, ttm: ItemGetter, q: ItemGetter) => number | null;
  /** Legend / scale decimals (the reference metric's). */
  precision?: number;
};

const QAT: MetricPeriod[] = ["FQ", "FY", "TTM"];
const QA: MetricPeriod[] = ["FQ", "FY"];
const A: MetricPeriod[] = ["FY"];

function m(tab: MetricTab, depth: 0 | 1, key: string, name: string, periods: MetricPeriod[], kind: MetricKind, value: MetricDef["value"], extra: Partial<MetricDef> = {}): MetricDef {
  return { key, name, tab, depth, periods, kind, value, ...extra };
}
const item = (key: string) => (g: ItemGetter) => g(key);
const negItem = (key: string) => (g: ItemGetter) => neg(g(key));

export const METRICS: MetricDef[] = [
  // ── Income statement ─────────────────────────────────────────────────────
  m("income", 0, "revenue", "Total revenue", QAT, "money", item("revenue")),
  m("income", 0, "cogs", "Cost of goods sold", QAT, "money", negItem("cogs"), { short: "COGS" }),
  m("income", 1, "depAmortCogs", "Deprecation and amortization", QAT, "money", negItem("depreciationAmortization")),
  m("income", 1, "depreciation", "Depreciation", A, "money", (g) => neg(or(g("depreciation"), g("depreciationAmortization")))),
  m("income", 1, "amortizationDeferredCharges", "Amortization of deferred charges", A, "money", item("amortizationDeferredCharges")),
  m("income", 1, "otherCogs", "Other cost of goods sold", QAT, "money", (g) => neg(sub(g("cogs"), g("depreciationAmortization") ?? 0)), { short: "Other COGS" }),
  m("income", 0, "grossProfit", "Gross profit", QAT, "money", D.grossProfit),
  m("income", 0, "operatingExpenses", "Operating expenses (excl. COGS)", QAT, "money", (g) => neg(D.operatingExpenses(g))),
  m("income", 1, "sga", "Selling/general/admin expenses (total)", QAT, "money", (g) => neg(sumAny(g("sga"), g("rnd"))), { short: "SGA" }),
  m("income", 1, "rnd", "Research & development", QAT, "money", negItem("rnd")),
  m("income", 1, "sgaOther", "Selling/general/admin expenses (other)", QAT, "money", negItem("sga"), { short: "Other SGA" }),
  m("income", 1, "otherOperatingExpenses", "Other operating expenses (total)", QAT, "money", negItem("otherOperatingExpenses")),
  m("income", 0, "operatingIncome", "Operating income", QAT, "money", item("operatingIncome")),
  m("income", 0, "nonOperatingIncome", "Non-operating income (total)", QAT, "money", (g) => or(g("nonOperatingIncome"), sub(g("pretaxIncome"), g("operatingIncome")))),
  m("income", 1, "interestExpense", "Interest expense, net of interest capitalized", QAT, "money", negItem("interestExpense")),
  m("income", 1, "interestCapitalized", "Interest capitalized", QAT, "money", item("interestCapitalized")),
  m("income", 1, "interestIncome", "Non-operating interest income", QAT, "money", item("interestIncome")),
  m("income", 0, "pretaxIncome", "Pretax income", QAT, "money", item("pretaxIncome")),
  m("income", 0, "equityInEarnings", "Equity in earnings", QAT, "money", item("equityInEarnings")),
  m("income", 0, "incomeTax", "Taxes", QAT, "money", negItem("incomeTax")),
  m("income", 1, "currentTax", "Income tax (current)", A, "money", (g) => neg(or(g("currentTax"), sumAny(g("currentTaxFederal"), g("currentTaxState"), g("currentTaxForeign"))))),
  m("income", 1, "currentTaxForeign", "Income tax (current - foreign)", A, "money", negItem("currentTaxForeign")),
  m("income", 1, "deferredTaxForeign", "Income tax (deferred - foreign)", A, "money", negItem("deferredTaxForeign")),
  m("income", 1, "taxCredits", "Income tax credits", A, "money", item("taxCredits")),
  m("income", 0, "minorityInterest", "Non-controlling/minority interest", QAT, "money", negItem("minorityInterest")),
  m("income", 0, "incomeContinuing", "Net income before discontinued operations", QAT, "money", (g) => or(g("incomeContinuing"), sub(g("netIncome"), g("discontinued") ?? 0))),
  m("income", 0, "discontinued", "Discontinued operations", QAT, "money", item("discontinued")),
  m("income", 0, "netIncome", "Net income", QAT, "money", item("netIncome")),
  m("income", 0, "preferredDividends", "Preferred dividends", QAT, "money", item("preferredDividends")),
  m("income", 0, "netIncomeCommonDiluted", "Diluted net income available to common stockholders", QAT, "money", (g) => or(g("netIncomeCommonDiluted"), sub(g("netIncome"), g("preferredDividends") ?? 0))),
  m("income", 0, "epsBasic", "Basic earnings per share (basic EPS)", QAT, "perShare", D.epsBasic, { ttmSum: true, precision: 4 }),
  m("income", 0, "epsDiluted", "Diluted earnings per share (diluted EPS)", QAT, "perShare", D.epsDiluted, { ttmSum: true, precision: 4 }),
  m("income", 0, "sharesBasic", "Average basic shares outstanding", QA, "shares", item("sharesBasic")),
  m("income", 0, "sharesDiluted", "Diluted shares outstanding", QA, "shares", item("sharesDiluted")),
  m("income", 0, "ebitda", "EBITDA", QAT, "money", D.ebitda),
  m("income", 0, "ebit", "EBIT", QAT, "money", item("operatingIncome")),
  m("income", 0, "totalOperatingExpenses", "Total operating expenses", QAT, "money", (g) => neg(or(g("costsAndExpenses"), sub(g("revenue"), g("operatingIncome"))))),

  // ── Balance sheet ────────────────────────────────────────────────────────
  m("balance", 0, "totalAssets", "Total assets", QA, "money", item("totalAssets")),
  m("balance", 1, "currentAssets", "Total current assets", QA, "money", item("currentAssets")),
  m("balance", 1, "cashAndShortTermInvestments", "Cash and short term investments", QA, "money", D.cashAndShortTerm),
  m("balance", 1, "receivables", "Total receivables (net)", QA, "money", (g) => or(sumAny(g("accountsReceivable"), g("otherReceivables")), g("receivables"))),
  m("balance", 1, "accountsReceivable", "Accounts receivable (trade, net)", QA, "money", item("accountsReceivable")),
  m("balance", 1, "doubtfulAccounts", "Bad debt / Doubtful accounts", A, "money", negItem("doubtfulAccounts")),
  m("balance", 1, "otherReceivables", "Other receivables", QA, "money", item("otherReceivables")),
  m("balance", 1, "inventory", "Total inventory", QA, "money", item("inventory")),
  m("balance", 1, "inventoryWip", "Inventories (work in progress)", QA, "money", item("inventoryWip")),
  m("balance", 1, "inventoryOther", "Inventories (progress payments & other)", QA, "money", item("inventoryOther")),
  m("balance", 1, "inventoryRaw", "Inventories (raw materials)", QA, "money", item("inventoryRaw")),
  m("balance", 1, "prepaidExpenses", "Prepaid expenses", QA, "money", item("prepaidExpenses")),
  m("balance", 1, "otherCurrentAssets", "Other current assets (total)", QA, "money", item("otherCurrentAssets")),
  m("balance", 1, "nonCurrentAssets", "Total non-current assets", QA, "money", (g) => or(g("nonCurrentAssets"), sub(g("totalAssets"), g("currentAssets")))),
  m("balance", 1, "longTermInvestments", "Long term investments", QA, "money", (g) => sumAny(g("longTermInvestments"), g("equityMethodInvestments"), g("noteReceivableLongTerm"), g("otherInvestments"))),
  m("balance", 1, "noteReceivableLongTerm", "Note receivable (long term)", QA, "money", item("noteReceivableLongTerm")),
  m("balance", 1, "equityMethodInvestments", "Investments in unconsolidated subsidiaries", QA, "money", item("equityMethodInvestments")),
  m("balance", 1, "otherInvestments", "Other investments", QA, "money", (g) => or(g("otherInvestments"), g("longTermInvestments"))),
  m("balance", 1, "ppeNet", "Net property/plant/equipment", QA, "money", item("ppeNet")),
  m("balance", 1, "ppeConstruction", "Property/plant/equipment (construction in progress)", A, "money", item("ppeConstruction")),
  m("balance", 1, "deferredTaxAssets", "Deferred tax assets", QA, "money", item("deferredTaxAssets")),
  m("balance", 1, "deferredCharges", "Deferred charges", QA, "money", item("deferredCharges")),
  m("balance", 0, "totalLiabilities", "Total liabilities", QA, "money", D.totalLiabilities),
  m("balance", 1, "currentLiabilities", "Total current liabilities", QA, "money", item("currentLiabilities")),
  m("balance", 1, "shortTermDebt", "Short term debt", QA, "money", D.shortTermDebt),
  m("balance", 1, "notesPayable", "Notes payable", A, "money", item("notesPayable")),
  m("balance", 1, "accountsPayable", "Accounts payable", QA, "money", item("accountsPayable")),
  m("balance", 1, "incomeTaxPayable", "Income tax payable", QA, "money", item("incomeTaxPayable")),
  m("balance", 1, "dividendsPayable", "Dividends payable", A, "money", item("dividendsPayable")),
  m("balance", 1, "accruedPayroll", "Accrued payroll", QA, "money", (g) => or(g("accruedPayroll"), sumAny(g("accruedSalaries"), g("otherEmployeeLiabilities")))),
  m("balance", 1, "deferredRevenueCurrent", "Deferred income (current)", QA, "money", item("deferredRevenueCurrent")),
  m("balance", 1, "otherCurrentLiabilities", "Other current liabilities", QA, "money", item("otherCurrentLiabilities")),
  m("balance", 1, "nonCurrentLiabilities", "Total non-current liabilities", QA, "money", (g) => or(g("nonCurrentLiabilities"), sub(D.totalLiabilities(g), g("currentLiabilities")))),
  m("balance", 1, "longTermDebtWithLeases", "Long term debt", QA, "money", D.longTermDebt),
  m("balance", 1, "longTermDebt", "Long term debt (excl. lease liabilities)", QA, "money", item("longTermDebt")),
  m("balance", 1, "operatingLeaseLiability", "Operating lease liabilities", QA, "money", item("operatingLeaseLiability")),
  m("balance", 1, "deferredRevenueNonCurrent", "Deferred income (non-current)", QA, "money", item("deferredRevenueNonCurrent")),
  m("balance", 0, "totalEquity", "Total equity", QA, "money", D.totalEquity),
  m("balance", 1, "shareholdersEquity", "Shareholders' equity", QA, "money", item("shareholdersEquity")),
  m("balance", 1, "commonEquity", "Common equity (total)", QA, "money", (g) => sub(g("shareholdersEquity"), g("preferredStock") ?? 0)),
  m("balance", 1, "retainedEarnings", "Retained earnings", QA, "money", item("retainedEarnings")),
  m("balance", 1, "paidInCapital", "Paid in capital", QA, "money", (g) => sumAny(g("commonStockValue"), g("additionalPaidInCapital"))),
  m("balance", 1, "commonStockValue", "Common stock par / Carrying value", QA, "money", item("commonStockValue")),
  m("balance", 1, "additionalPaidInCapital", "Additional paid-in capital / Capital surplus", QA, "money", item("additionalPaidInCapital")),
  m("balance", 1, "otherEquity", "Other common equity", QA, "money", item("otherEquity")),
  m("balance", 1, "preferredStock", "Preferred stock (carrying value)", QA, "money", item("preferredStock")),
  m("balance", 1, "minorityInterestEquity", "Minority interest", QA, "money", D.minorityInterest),
  m("balance", 0, "liabilitiesAndEquity", "Total liabilities & shareholders' equities", QA, "money", (g) => or(g("liabilitiesAndEquity"), g("totalAssets"))),
  m("balance", 0, "totalDebt", "Total debt", QA, "money", D.totalDebt),
  m("balance", 0, "netDebt", "Net debt", QA, "money", (g) => sub(D.totalDebt(g), D.cashAndShortTerm(g))),

  // ── Cash flow ────────────────────────────────────────────────────────────
  m("cashflow", 0, "cashFromOperations", "Cash flow from operating activities", QAT, "money", item("cashFromOperations")),
  m("cashflow", 1, "netIncomeCashFlow", "Net income (cash flow)", QAT, "money", (g) => or(g("profitLoss"), g("netIncome"))),
  m("cashflow", 1, "depreciationAmortization", "Depreciation & amortization (cash flow)", QAT, "money", item("depreciationAmortization")),
  m("cashflow", 1, "changeReceivables", "Change in accounts receivable", QAT, "money", (g) => neg(sumAny(g("changeReceivables"), g("changeOtherReceivables")))),
  m("cashflow", 1, "changeTaxes", "Change in taxes payable", QAT, "money", item("changeTaxes")),
  m("cashflow", 1, "changePayables", "Change in accounts payable", QAT, "money", item("changePayables")),
  m("cashflow", 1, "changeAccrued", "Change in accrued expenses", QAT, "money", item("changeAccrued")),
  m("cashflow", 1, "changeInventories", "Change in inventories", QAT, "money", negItem("changeInventories")),
  m("cashflow", 0, "cashFromInvesting", "Cash flow from investing activities", QAT, "money", item("cashFromInvesting")),
  m("cashflow", 1, "saleOfAssets", "Sale of fixed assets & businesses", QAT, "money", (g) => sumAny(g("saleOfFixedAssets"), g("saleOfBusinesses"))),
  m("cashflow", 1, "purchaseOfInvestments", "Purchase of investments", QAT, "money", negItem("purchaseOfInvestments")),
  m("cashflow", 1, "capexTotal", "Capital expenditures", QAT, "money", (g) => neg(sumAny(g("capex"), g("capexOther")))),
  m("cashflow", 1, "capex", "Capital expenditures (fixed assets)", QAT, "money", negItem("capex")),
  m("cashflow", 0, "cashFromFinancing", "Cash flow from financing activities", QAT, "money", item("cashFromFinancing")),
  m("cashflow", 1, "stockNet", "Issuance/retirement of stock (net)", QAT, "money", (g) => sumAny(g("issuanceOfStock"), neg(g("repurchaseOfStock")))),
  m("cashflow", 1, "repurchaseOfStock", "Repurchase of common & preferred stock", QAT, "money", negItem("repurchaseOfStock")),
  m("cashflow", 1, "debtNet", "Issuance/retirement of debt (net)", QAT, "money", (g) => sumAny(g("issuanceOfDebt"), neg(g("repaymentOfDebt")), D.shortTermDebtNet(g))),
  m("cashflow", 1, "longTermDebtNet", "Issuance/retirement of long term debt", QAT, "money", (g) => sumAny(g("issuanceOfDebt"), neg(g("repaymentOfDebt")))),
  m("cashflow", 1, "repaymentOfDebt", "Reduction of long term debt", QAT, "money", negItem("repaymentOfDebt")),
  m("cashflow", 1, "shortTermDebtNet", "Issuance/retirement of short term debt", QAT, "money", (g) => D.shortTermDebtNet(g)),
  m("cashflow", 1, "dividendsPaid", "Total cash dividends paid", QAT, "money", negItem("dividendsPaid")),
  m("cashflow", 1, "preferredDividendsPaid", "Preferred dividends paid", QA, "money", negItem("preferredDividendsPaid")),
  m("cashflow", 0, "freeCashFlow", "Free cash flow", QAT, "money", D.freeCashFlow),

  // ── Statistics ───────────────────────────────────────────────────────────
  { key: "marketCap", name: "Market capitalization", tab: "statistics", depth: 0, periods: [], kind: "money",
    price: (c, _t, q) => { const s = D.sharesOutstanding(q); return s === null ? null : c * s; } },
  m("statistics", 0, "sharesOutstanding", "Total common shares outstanding", QA, "shares", D.sharesOutstanding),
  m("statistics", 0, "dividendsPerShare", "Dividends per share (common stock primary issue)", QAT, "perShare", item("dividendsPerShare")),
  { key: "priceEarnings", name: "Price to earnings ratio", short: "P/E ratio", tab: "statistics", depth: 0, periods: [], kind: "ratio", precision: 3,
    price: (c, t) => div(c, t("epsDiluted")) },
  { key: "priceSales", name: "Price to sales ratio", tab: "statistics", depth: 0, periods: [], kind: "ratio",
    price: (c, t, q) => div(c * (q("sharesDiluted") ?? NaN), t("revenue")) },
  { key: "priceCashFlow", name: "Price to cash flow ratio", tab: "statistics", depth: 0, periods: [], kind: "ratio",
    price: (c, t, q) => div(c * (q("sharesDiluted") ?? NaN), t("cashFromOperations")) },
  { key: "priceBook", name: "Price to book ratio", tab: "statistics", depth: 0, periods: [], kind: "ratio",
    price: (c, _t, q) => div(c * (D.sharesOutstanding(q) ?? NaN), D.commonEquity(q)) },
  { key: "enterpriseValue", name: "Enterprise value", tab: "statistics", depth: 0, periods: [], kind: "money",
    price: (c, _t, q) => { const s = D.sharesOutstanding(q); return s === null ? null : sumAny(c * s, D.totalDebt(q), D.minorityInterest(q), neg(D.cashAndShortTerm(q))); } },
  { key: "priceFreeCashFlow", name: "Price to free cash flow ratio", tab: "statistics", depth: 0, periods: [], kind: "ratio",
    price: (c, t, q) => div(c * (q("sharesDiluted") ?? NaN), D.freeCashFlow(t)) },
  { key: "earningsYield", name: "Earnings yield %", tab: "statistics", depth: 0, periods: [], kind: "percent", precision: 3,
    price: (c, t) => { const e = t("epsDiluted"); return e === null || c === 0 ? null : (e / c) * 100; } },
  m("statistics", 0, "returnOnAssets", "Return on assets %", QA, "percent", (g, ya, t) => pct(t?.("netIncome") ?? null, avg(g("totalAssets"), ya?.("totalAssets") ?? null))),
  m("statistics", 0, "returnOnEquity", "Return on equity %", QA, "percent", (g, ya, t) => pct(t?.("netIncome") ?? null, avg(g("shareholdersEquity"), ya?.("shareholdersEquity") ?? null))),
  m("statistics", 0, "returnOnCommonEquity", "Return on common equity %", QA, "percent", (g, ya, t) => pct(t ? D.netIncomeCommon(t) : null, avg(D.commonEquity(g), ya ? D.commonEquity(ya) : null))),
  m("statistics", 0, "returnOnInvestedCapital", "Return on invested capital %", QA, "percent", (g, ya, t) => pct(t?.("netIncome") ?? null, avg(D.investedCapital(g), ya ? D.investedCapital(ya) : null))),
  m("statistics", 0, "returnOnTangibleAssets", "Return on tangible assets %", QA, "percent", (g, ya, t) => pct(t?.("netIncome") ?? null, avg(sub(g("totalAssets"), D.intangiblesAll(g)), ya ? sub(ya("totalAssets"), D.intangiblesAll(ya)) : null))),
  m("statistics", 0, "grossMargin", "Gross margin %", QAT, "percent", (g) => pct(D.grossProfit(g), g("revenue"))),
  m("statistics", 0, "operatingMargin", "Operating margin %", QA, "percent", (g) => pct(g("operatingIncome"), g("revenue"))),
  m("statistics", 0, "ebitdaMargin", "EBITDA margin %", QAT, "percent", (g) => pct(D.ebitda(g), g("revenue"))),
  m("statistics", 0, "netMargin", "Net margin %", QAT, "percent", (g) => pct(g("netIncome"), g("revenue"))),
  m("statistics", 0, "fcfMargin", "Free cash flow margin %", QA, "percent", (g) => pct(D.freeCashFlow(g), g("revenue"))),
  m("statistics", 0, "quickRatio", "Quick ratio", QA, "ratio", (g) => div(sub(g("currentAssets"), g("inventory") ?? 0), g("currentLiabilities"))),
  m("statistics", 0, "currentRatio", "Current ratio", QA, "ratio", (g) => div(g("currentAssets"), g("currentLiabilities"))),
  m("statistics", 0, "inventoryTurnover", "Inventory turnover", QA, "ratio", (g, ya, t) => div(t?.("cogs") ?? null, avg(g("inventory"), ya?.("inventory") ?? null))),
  m("statistics", 0, "assetTurnover", "Asset turnover", QA, "ratio", (g, ya, t) => div(t?.("revenue") ?? null, avg(g("totalAssets"), ya?.("totalAssets") ?? null))),
  m("statistics", 0, "debtToAssets", "Debt to assets ratio", QA, "ratio", (g) => div(D.totalDebt(g), g("totalAssets"))),
  m("statistics", 0, "debtToEquity", "Debt to equity ratio", QA, "ratio", (g) => div(D.totalDebt(g), D.totalEquity(g))),
  m("statistics", 0, "ltDebtToAssets", "Long term debt to total assets ratio", QA, "ratio", (g) => div(D.longTermDebt(g), g("totalAssets"))),
  m("statistics", 0, "ltDebtToEquity", "Long term debt to total equity ratio", QA, "ratio", (g) => div(D.longTermDebt(g), D.totalEquity(g))),
  m("statistics", 0, "netDebtToEbitda", "Net debt to EBITDA ratio", QA, "ratio", (g, _ya, t) => div(D.netDebt(g), t ? D.ebitda(t) : null)),
  m("statistics", 0, "debtToRevenue", "Debt to revenue ratio", QA, "ratio", (g, _ya, t) => div(D.totalDebt(g), t?.("revenue") ?? null)),
  m("statistics", 0, "fcfPerShare", "Free cash flow per share", QA, "perShare", (g) => div(D.freeCashFlow(g), g("sharesDiluted"))),
  m("statistics", 0, "equityToAssets", "Equity to assets ratio", QA, "ratio", (g) => div(g("shareholdersEquity"), g("totalAssets"))),
  m("statistics", 0, "revenueGrowth", "Revenue one year growth %", QAT, "percent", (g, ya) => growth(g("revenue"), ya?.("revenue") ?? null)),
  m("statistics", 0, "cashToDebt", "Cash to debt ratio", QA, "ratio", (g) => div(D.cashAndShortTerm(g), D.totalDebt(g))),
  m("statistics", 0, "cogsToRevenue", "COGS to revenue ratio", QA, "ratio", (g) => div(g("cogs"), g("revenue"))),
  m("statistics", 0, "rndToRevenue", "Research & development to revenue ratio %", QA, "percent", (g) => pct(g("rnd"), g("revenue"))),
];

const BY_KEY = new Map(METRICS.map((d) => [d.key, d]));
export function metricDef(key: string): MetricDef | undefined {
  return BY_KEY.get(key);
}

// ── Values per period ──────────────────────────────────────────────────────

/** One value of a metric: the period, the day it became public (YYYY-MM-DD) and the value. */
export type MetricPoint = { end: string; date: string; fy: number | null; fp: string | null; value: number };

/** Getter over one period of a statement set. */
function getterAt(p: FundamentalPeriods, i: number): ItemGetter {
  return (key) => p.items?.[key]?.[i] ?? null;
}

/** Getter over the four quarters ending at quarter `i` (TTM); null for amounts when a quarter is missing. */
function ttmGetterAt(q: FundamentalPeriods, i: number): ItemGetter | null {
  if (i < 3) return null;
  // The four quarters must be consecutive (about a year apart).
  const end = Date.parse(q.end?.[i] ?? "");
  const first = Date.parse(q.end?.[i - 3] ?? "");
  if (!(end - first > 250 * 86400e3 && end - first < 300 * 86400e3)) return null;
  return (key) => {
    const s = q.items?.[key];
    if (!s) return null;
    if (FLOW_ITEMS.has(key)) return sum(s[i - 3], s[i - 2], s[i - 1], s[i]);
    if (AVERAGE_ITEMS.has(key)) { const t = sum(s[i - 3], s[i - 2], s[i - 1], s[i]); return t === null ? null : t / 4; }
    return s[i] ?? null;
  };
}

/** The metric's values per period, ascending. Periods without a value are left out. */
export function metricPoints(f: Fundamentals, def: MetricDef, period: MetricPeriod): MetricPoint[] {
  if (!def.value) return [];
  const p = period === "FY" ? f.annual : f.quarterly;
  if (!p?.end) return [];
  const out: MetricPoint[] = [];
  /** Index of the same period a year before `i` (four quarters, or one year, back; about 365 days apart). */
  const yearAgo = (i: number): number | null => {
    const j = i - (period === "FY" ? 1 : 4);
    if (j < 0) return null;
    const d = (Date.parse(p.end![i]) - Date.parse(p.end![j])) / 86400e3;
    return d > 340 && d < 390 ? j : null;
  };
  const getter = (i: number) => (period === "TTM" ? ttmGetterAt(p, i) : getterAt(p, i));
  for (let i = 0; i < p.end.length; i++) {
    const g = getter(i);
    if (!g) continue;
    const j = yearAgo(i);
    const ya = j === null ? null : getter(j);
    const t = period === "FQ" ? ttmGetterAt(p, i) : g;
    const v = period === "TTM" && def.ttmSum ? sum(...[3, 2, 1, 0].map((k) => def.value!(getterAt(p, i - k), null, null))) : def.value(g, ya, t);
    if (v === null || !Number.isFinite(v)) continue;
    out.push({ end: p.end[i], date: p.date?.[i] ?? p.end[i], fy: p.fy?.[i] ?? null, fp: p.fp?.[i] ?? null, value: v });
  }
  return out;
}

/** Price metric inputs: the TTM and last-quarter getters of each quarter, with the day it became public. */
export function priceInputs(f: Fundamentals): { date: string; ttm: ItemGetter; q: ItemGetter }[] {
  const q = f.quarterly;
  if (!q?.end) return [];
  const out = [];
  for (let i = 0; i < q.end.length; i++) {
    const sums = ttmGetterAt(q, i);
    if (!sums) continue;
    // Per-share amounts: the sum of the four quarters' values.
    const quarters = [3, 2, 1, 0].map((k) => getterAt(q, i - k));
    const ttm: ItemGetter = (key) =>
      key === "epsDiluted" ? sum(...quarters.map(D.epsDiluted)) : key === "epsBasic" ? sum(...quarters.map(D.epsBasic)) : sums(key);
    out.push({ date: q.date?.[i] ?? q.end[i], ttm, q: getterAt(q, i) });
  }
  return out;
}
