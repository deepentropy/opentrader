/*
 * Stock screener: screen → scan request, and the TradingView filter texts
 * (pill label, preset titles). Grammar follows the TV `/scan` request the
 * desktop app sends (research/screener/data/tv/scan-requests.json).
 */
import type { Clause, Operand, ScanRequest } from "../bindings";
import {
  COLUMN_BY_ID,
  COLUMN_SETS,
  CUSTOM_SET_ID,
  TICKER_SORT_FIELD,
  configuredShort,
  fieldOf,
  type ColumnRef,
  type ConditionFilter,
  type Filter,
  type OffsetRangeId,
  type Operation,
  type Preset,
  type Screen,
} from "./screener-catalog";
import { valueText } from "./screener-format";

// ── Filter state ──────────────────────────────────────────────────────────

/** Active = the filter restricts the scan (TV `isColumnFilterConditionValid`). */
export function isActive(f: Filter): boolean {
  if (f.type === "CheckboxGroup") return f.values.length > 0;
  const r = f.right;
  if ("column" in r) return true;
  if ("value" in r) return r.value !== null;
  if (f.operation === "outside") return r.left !== null && r.right !== null;
  return r.left !== null || r.right !== null;
}

/** Open range: `between` with one bound only (shown as ≥ / ≤). */
function openRangeOp(f: ConditionFilter): Operation | null {
  const r = f.right;
  if (f.operation !== "between" || !("left" in r)) return null;
  if (r.left !== null && r.right === null) return "aboveOrEqual";
  if (r.left === null && r.right !== null) return "belowOrEqual";
  return null;
}

/** Pill operation icon key (see OPERATION_ICON). */
export function pillOperation(f: ConditionFilter): Operation {
  const open = openRangeOp(f);
  if (open) return open;
  if (f.operation === "abovePercent") return "above";
  if (f.operation === "belowPercent") return "below";
  return f.operation;
}

function unitOf(col: ColumnRef): string {
  const fmt = COLUMN_BY_ID[col.id]?.fmt;
  return fmt === "price" || fmt === "signedPrice" || fmt === "money" ? "USD" : "";
}

const OFFSET_LABEL: Record<OffsetRangeId, string> = {
  offset_range_0_10: "0% to 10%",
  offset_range_10: "10% or more",
  offset_range_20: "20% or more",
};

/** Pill texts: primary (column title) + active value, TV style
 *  ("Price" ≥ "5 USD", "ADR" ≥ "5%", "Price" > "EMA, 50"). */
export function pillTexts(f: Filter): { primary: string; value: string | null } {
  const def = COLUMN_BY_ID[f.left.id];
  if (!def) return { primary: f.left.id, value: null };
  if (!isActive(f)) return { primary: def.short, value: null };
  if (f.type === "CheckboxGroup") return { primary: def.short, value: null };
  const fmt = def.fmt;
  // Active pills show the configured title; a trailing " %" moves into the
  // value ("ADR %" → "ADR" + "5%").
  let primary = configuredShort(f.left);
  const percentValue = fmt === "change" || fmt === "percent";
  if (percentValue && f.target === "value") primary = primary.replace(/ %(?=,|$)/, "");
  const unit = unitOf(f.left);
  const u = unit ? ` ${unit}` : "";
  const r = f.right;
  if ("column" in r) return { primary, value: configuredShort(r.column) };
  if (f.operation === "abovePercent" || f.operation === "belowPercent") {
    return { primary, value: f.offsetRangeId ? OFFSET_LABEL[f.offsetRangeId] : "" };
  }
  if ("value" in r) return { primary, value: `${valueText(fmt, r.value as number)}${u}` };
  if (r.left !== null && r.right !== null) {
    return { primary, value: `${valueText(fmt, r.left)} to ${valueText(fmt, r.right)}${u}` };
  }
  const one = (r.left ?? r.right) as number;
  return { primary, value: `${valueText(fmt, one)}${u}` };
}

/** Preset row title (TV `wd`): "Above 30%", "0% to 5%", "10 to 100",
 *  "200 B and above", "Above EMA, 50", "Below Price by 0% to 10%",
 *  "50 above EMA, 100". */
export function presetTitle(columnId: string, p: Preset): string {
  const def = COLUMN_BY_ID[columnId];
  const fmt = def?.fmt ?? "number";
  const r = p.right;
  if ("column" in r) {
    const target = configuredShort(r.column);
    if (p.operation === "abovePercent" || p.operation === "belowPercent") {
      const word = p.operation === "abovePercent" ? "Above" : "Below";
      return `${word} ${target} by ${p.offsetRangeId ? OFFSET_LABEL[p.offsetRangeId] : ""}`;
    }
    const word = p.operation === "above" || p.operation === "aboveOrEqual" ? "above" : "below";
    if (p.leftParams?.length && r.column.id === columnId) return `${p.leftParams.length} ${word} ${target}`;
    return `${word[0].toUpperCase()}${word.slice(1)} ${target}`;
  }
  if ("value" in r) {
    const v = valueText(fmt, r.value);
    switch (p.operation) {
      case "above":
        return `Above ${v}`;
      case "below":
        return `Below ${v}`;
      case "aboveOrEqual":
        return `${v} and above`;
      case "belowOrEqual":
        return `${v} and below`;
      default:
        return v;
    }
  }
  if (r.left !== null && r.right !== null) return `${valueText(fmt, r.left)} to ${valueText(fmt, r.right)}`;
  if (r.left !== null) return `${valueText(fmt, r.left)} and above`;
  return `${valueText(fmt, r.right as number)} and below`;
}

/** The filter a preset produces on a pill (left params synced like TV
 *  `syncConfig`, except where the preset fixes them). */
export function presetFilter(base: Filter, p: Preset): ConditionFilter {
  const left: ColumnRef = { id: base.left.id, params: { ...base.left.params, ...(p.leftParams ?? {}) } };
  const r = p.right;
  return {
    id: base.id,
    type: "Condition",
    left,
    operation: p.operation,
    offsetRangeId: p.offsetRangeId,
    target: p.target,
    right: "column" in r ? { column: r.column } : "value" in r ? { value: r.value } : { left: r.left, right: r.right },
  };
}

// ── Compile ───────────────────────────────────────────────────────────────

const OP: Record<Exclude<Operation, "between" | "outside">, Clause["operation"]> = {
  above: "greater",
  aboveOrEqual: "egreater",
  below: "less",
  belowOrEqual: "eless",
  equal: "equal",
  nequal: "nequal",
};

/** Clauses of one active filter; null when a field is missing. */
export function filterClauses(f: Filter): Clause[] | null {
  const left = fieldOf(f.left);
  if (!left) return null;
  if (f.type === "CheckboxGroup") return [{ left, operation: "in_range", right: f.values }];
  const r = f.right;
  let right: Operand;
  if ("column" in r) {
    const rf = fieldOf(r.column);
    if (!rf) return null;
    right = rf;
  } else if ("value" in r) {
    if (r.value === null) return [];
    right = r.value;
  } else {
    const { left: lo, right: hi } = r;
    if (f.operation === "outside") return lo !== null && hi !== null ? [{ left, operation: "not_in_range", right: [lo, hi] }] : [];
    if (lo !== null && hi !== null) return [{ left, operation: "in_range", right: [lo, hi] }];
    if (lo !== null) return [{ left, operation: "egreater", right: lo }];
    if (hi !== null) return [{ left, operation: "eless", right: hi }];
    return [];
  }
  if (f.operation === "abovePercent" || f.operation === "belowPercent") {
    // Left deviates from the right field by a % band (TV offset ranges).
    const up = f.operation === "abovePercent";
    switch (f.offsetRangeId) {
      case "offset_range_0_10":
        return [{ left, operation: "in_range%", right: up ? [right, 1, 1.1] : [right, 0.9, 1] }];
      case "offset_range_10":
        return [{ left, operation: up ? "above%" : "below%", right: [right, 10] }];
      case "offset_range_20":
        return [{ left, operation: up ? "above%" : "below%", right: [right, 20] }];
      default:
        return [];
    }
  }
  if (f.operation === "between" || f.operation === "outside") return [];
  return [{ left, operation: OP[f.operation], right }];
}

/** Columns of the active column set (custom or preset). */
export function activeColumns(s: Screen): ColumnRef[] {
  if (s.activeColumnSetId === CUSTOM_SET_ID && s.customColumns) return s.customColumns;
  return COLUMN_SETS.find((c) => c.id === s.activeColumnSetId)?.columns ?? COLUMN_SETS[0].columns;
}

/** TV's implicit stock-screen universe (scan `filter2`: common and preferred
 *  stock, depositary receipts, funds that are not ETF / mutual) as Massive
 *  reference `type` codes. Sent with every scan when the field exists. */
export const UNIVERSE_CLAUSE: Clause = { left: "type", operation: "in_range", right: ["CS", "PFD", "SP", "ADRC", "FUND", "UNIT"] };

/** Extra hidden columns requested for every row (tooltip, currency unit). */
export const EXTRA_FIELDS = ["description", "currency"] as const;

export type Plan = {
  /** Visible columns that the backend knows, in order. */
  columns: ColumnRef[];
  /** Request field ids: visible columns first, then the extra fields. */
  fields: string[];
  filter: Clause[];
  sort: ScanRequest["sort"];
  tickers: string[] | null;
};

/** Build the scan plan of a screen. `has` tells whether a field id exists in
 *  the backend catalog (`screenerFields()`); unknown ids are never sent. */
export function planScreen(s: Screen, has: (field: string) => boolean, tickers: string[] | null): Plan {
  const columns = activeColumns(s).filter((c) => {
    const f = fieldOf(c);
    return f !== null && has(f);
  });
  const fields = columns.map((c) => fieldOf(c) as string);
  for (const x of EXTRA_FIELDS) if (has(x)) fields.push(x);
  const filter: Clause[] = has(UNIVERSE_CLAUSE.left) ? [UNIVERSE_CLAUSE] : [];
  for (const f of s.filters) {
    if (!isActive(f)) continue;
    const cl = filterClauses(f);
    if (!cl) continue;
    if (cl.every((c) => has(c.left) && (typeof c.right !== "string" || has(c.right)) && (!Array.isArray(c.right) || typeof c.right[0] !== "string" || f.type === "CheckboxGroup" || has(c.right[0] as string)))) {
      filter.push(...cl);
    }
  }
  let sort: ScanRequest["sort"] = null;
  if (s.sort.sortBy.id === "TickerUniversal") sort = { sortBy: TICKER_SORT_FIELD, sortOrder: s.sort.sortOrder };
  else {
    const sf = fieldOf(s.sort.sortBy);
    if (sf && has(sf)) sort = { sortBy: sf, sortOrder: s.sort.sortOrder };
  }
  return { columns, fields, filter, sort, tickers };
}
