/*
 * Screener tools of Settings > Coding agents: screen the US market (or a watchlist, or an index) on the stock
 * screener's fields, list and open the user's screens. The scans run on the same backend table as the screener panel
 * (the whole market every 10 s); the tools keep it loading while an agent uses them and for two minutes after.
 */
import type { Clause, FieldInfo, Operand, ScanRow } from "../bindings";
import {
  COLUMN_BY_ID,
  COLUMN_SETS,
  COLUMNS,
  CUSTOM_SET_ID,
  INDEXES,
  POPULAR_SCREENS,
  TICKER_COLUMN,
  fullParams,
  newFilterId,
  newScreen,
  optionOf,
  sameColumn,
  type ColumnRef,
  type ConditionFilter,
  type Filter,
  type Operation,
  type Screen,
} from "../data/screener-catalog";
import { planScreen, PRIMARY_UNIVERSE_CLAUSE } from "../data/screener-query";
import { onScreenerUpdate, screenerClose, screenerFields, screenerOpen, screenerScan } from "../data/screener-api";
import { screenerPanel, screenerStore } from "../data/screener-store";
import { scriptScreenStore } from "../data/script-screen-store";
import { watchlistStore } from "../data/watchlist-store";
import { AgentError, type AgentTool } from "./mcp";

const OWNER = "agent:screener";
/** The backend keeps loading the table this long after the last screener tool call. */
const KEEP_MS = 120_000;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let ready: Promise<void> | null = null;

/** Start (or keep) the table loading; resolves once it holds the market. */
function useTable(): Promise<void> {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = null;
    ready = null;
    void screenerClose(OWNER).catch(() => {});
  }, KEEP_MS);
  ready ??= (async () => {
    const st = await screenerOpen(OWNER);
    if (st.updatedMs !== null && st.complete) return;
    // The first complete table (with the ticker list and the daily state): wait for its update (at most 30 s).
    await new Promise<void>((resolve) => {
      let off: (() => void) | null = null;
      const timer = setTimeout(done, 30_000);
      function done() {
        clearTimeout(timer);
        off?.();
        resolve();
      }
      void onScreenerUpdate((u) => u.complete && done()).then((f) => (off = f));
    });
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

/** One field an agent can screen on: its id, what it is, and its kind ("number" / "text"). */
export type AgentField = { field: string; title: string; kind: string };

/** The screener's fields, titled as in the screener ("Exponential moving average (50)"), then the others. */
export function agentFields(catalog: FieldInfo[]): AgentField[] {
  const byId = new Map(catalog.filter((f) => f.available).map((f) => [f.id, f]));
  const out: AgentField[] = [];
  const seen = new Set<string>();
  const add = (field: string, title: string) => {
    const f = byId.get(field);
    if (!f || seen.has(field)) return;
    seen.add(field);
    out.push({ field, title, kind: f.kind });
  };
  for (const c of COLUMNS) {
    if (c.field) add(c.field, c.title);
    for (const p of c.params ?? []) {
      for (const o of p.options) if (o.field) add(o.field, p.options.length > 1 ? `${c.title} (${o.label})` : c.title);
    }
  }
  for (const f of byId.values()) add(f.id, f.id);
  return out;
}

const OPS: Record<string, Clause["operation"]> = {
  ">": "greater",
  ">=": "egreater",
  "<": "less",
  "<=": "eless",
  "=": "equal",
  "!=": "nequal",
  between: "in_range",
  outside: "not_in_range",
  in: "in_range",
};

/** A filter of run_screen as a backend clause: `value` a number, [low, high], a list of texts, or {field}. */
export function clauseOf(f: unknown, known: (field: string) => boolean): Clause {
  const x = f as { field?: unknown; op?: unknown; value?: unknown } | null;
  if (!x || typeof x.field !== "string" || !known(x.field)) throw new AgentError(`Unknown filter field ${JSON.stringify(x?.field)}: see list_screener_fields.`);
  const op = typeof x.op === "string" ? OPS[x.op] : undefined;
  if (!op) throw new AgentError(`Filter op must be one of ${Object.keys(OPS).join(", ")}.`);
  const v = x.value;
  let right: Operand;
  if (x.op === "between" || x.op === "outside") {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number")) throw new AgentError(`"${x.op}" takes value [low, high].`);
    right = [Math.min(v[0], v[1]), Math.max(v[0], v[1])];
  } else if (x.op === "in") {
    if (!Array.isArray(v) || !v.length || !v.every((s) => typeof s === "string")) throw new AgentError(`"in" takes a list of texts (a sector, an exchange…).`);
    right = v as string[];
  } else if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { field?: unknown }).field === "string") {
    const other = (v as { field: string }).field;
    if (!known(other)) throw new AgentError(`Unknown field "${other}" in a filter value.`);
    right = other;
  } else if (typeof v === "number" || typeof v === "string") {
    right = v;
  } else {
    throw new AgentError(`Filter value of "${x.field}": a number, a text, or {"field": "<id>"} to compare with another field.`);
  }
  return { left: x.field, operation: op, right };
}

/** The screener column (with its params) that gives a backend field, or null. */
export function columnOfField(field: string): ColumnRef | null {
  for (const c of COLUMNS) {
    if (c.field === field) return { id: c.id, params: {} };
    for (const p of c.params ?? []) {
      const custom = p.custom && field.startsWith(p.custom.prefix) ? field.slice(p.custom.prefix.length) : null;
      const o = p.options.find((x) => x.field === field) ?? (custom && optionOf(p, custom)?.field === field ? optionOf(p, custom) : undefined);
      if (o) return { id: c.id, params: { ...fullParams(c, {}), [p.key]: o.value } };
    }
  }
  return null;
}

const refOf = (field: unknown, what: string): ColumnRef => {
  const ref = typeof field === "string" ? columnOfField(field) : null;
  if (!ref) throw new AgentError(`${what}: "${String(field)}" is not a screener column. See list_screener_fields.`);
  return ref;
};

/** A run_screen filter as a pill of a saved screen (the screener's own filter model). */
export function pillOf(f: unknown): Filter {
  const x = (f ?? {}) as { field?: unknown; op?: unknown; value?: unknown };
  const left = refOf(x.field, "Filter field");
  const def = COLUMN_BY_ID[left.id];
  const cfg = def.filter;
  if (!cfg) throw new AgentError(`"${def.title}" cannot be a filter of a saved screen (run_screen can still filter on it).`);
  const id = newFilterId();
  const v = x.value;
  if (cfg.type === "CheckboxGroup") {
    if (x.op !== "in" && x.op !== "=") throw new AgentError(`"${def.title}" takes op "in" with a list of values.`);
    const values = Array.isArray(v) ? v : [v];
    if (!values.length || !values.every((s) => typeof s === "string")) throw new AgentError(`"${def.title}": value is a list of texts.`);
    return { id, type: "CheckboxGroup", left, values: values as string[] };
  }
  const num = (n: unknown) => {
    if (typeof n !== "number" || !Number.isFinite(n)) throw new AgentError(`Filter "${def.title}": the value must be a number.`);
    return n;
  };
  const cond = (operation: ConditionFilter["operation"], right: ConditionFilter["right"], target = "value"): Filter => {
    if (operation !== "between" && !cfg.operations.includes(operation as Operation)) {
      throw new AgentError(`"${def.title}" in a saved screen takes ${cfg.operations.join(", ")} (>, <, between, outside, =).`);
    }
    return { id, type: "Condition", left, operation, target, right };
  };
  // Another column on the right ("close > EMA200"): one of the targets the screener offers for this column.
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { field?: unknown }).field === "string") {
    const column = refOf((v as { field: string }).field, "Filter value");
    if (!cfg.targets.flat().includes(column.id)) {
      throw new AgentError(`"${def.title}" can be compared in a saved screen with: ${cfg.targets.flat().filter((t) => t !== "value").join(", ") || "values only"}.`);
    }
    const op = x.op === ">" ? "above" : x.op === "<" ? "below" : null;
    if (!op) throw new AgentError('A comparison with another column takes op ">" or "<".');
    return cond(op, { column }, column.id);
  }
  switch (x.op) {
    case ">":
      return cond("above", { value: num(v) });
    case "<":
      return cond("below", { value: num(v) });
    // At least / at most: an open range, as the screener's presets write them.
    case ">=":
      return cond("between", { left: num(v), right: null });
    case "<=":
      return cond("between", { left: null, right: num(v) });
    case "=":
      return cond("equal", { value: num(v) });
    case "between":
    case "outside": {
      if (!Array.isArray(v) || v.length !== 2) throw new AgentError(`"${x.op}" takes value [low, high].`);
      const [a, b] = [num(v[0]), num(v[1])];
      return cond(x.op, { left: Math.min(a, b), right: Math.max(a, b) });
    }
    default:
      throw new AgentError(`A saved screen's filter op is one of >, >=, <, <=, =, between, outside, in.`);
  }
}

/** A saved screen from save_screen's arguments: the default pills, the filters on them (or added after them), the
 *  columns (a column set, or the given fields as a custom set) and the sort. */
export function screenOf(args: Record<string, unknown>, title: string, watchlistId: string | null): Screen {
  const s = newScreen("stock", title);
  for (const f of Array.isArray(args.filters) ? args.filters : []) {
    const pill = pillOf(f);
    const at = s.filters.findIndex((x) => sameColumn(x.left, pill.left));
    if (at >= 0) s.filters[at] = { ...pill, id: s.filters[at].id };
    else s.filters.push(pill);
  }
  const scope = args.scope as { index?: unknown } | undefined;
  if (scope && typeof scope === "object" && typeof scope.index === "string") {
    const code = scope.index.toUpperCase();
    if (!INDEXES.some(([c]) => c === code)) throw new AgentError(`Index codes: ${INDEXES.map(([c]) => c).join(", ")}.`);
    const at = s.filters.findIndex((x) => x.left.id === "Index");
    const pill: Filter = { id: at >= 0 ? s.filters[at].id : newFilterId(), type: "CheckboxGroup", left: { id: "Index", params: {} }, values: [code] };
    if (at >= 0) s.filters[at] = pill;
    else s.filters.unshift(pill);
  }
  s.watchlistId = watchlistId;
  if (typeof args.columnSet === "string") {
    if (!COLUMN_SETS.some((c) => c.id === args.columnSet)) throw new AgentError(`columnSet: ${COLUMN_SETS.map((c) => c.id).join(", ")}.`);
    s.activeColumnSetId = args.columnSet;
  } else if (Array.isArray(args.columns) && args.columns.length) {
    s.customColumns = args.columns.map((c) => refOf(c, "Column"));
    s.activeColumnSetId = CUSTOM_SET_ID;
  }
  const sort = args.sort as { field?: unknown; order?: unknown } | undefined;
  if (sort && typeof sort.field === "string") {
    s.sort = { sortBy: sort.field === "name" ? TICKER_COLUMN : refOf(sort.field, "Sort field"), sortOrder: sort.order === "asc" ? "asc" : "desc" };
  }
  return s;
}

/** Rows of a scan as {symbol, name, <field>: value}. */
function rowsOf(rows: ScanRow[], fields: string[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = { symbol: r.s };
    fields.forEach((f, i) => (o[f === "description" ? "name" : f] = r.d[i]));
    return o;
  });
}

/** Tickers of a watchlist (by name) or of an index (its code: SPX, NDX...). */
async function scopeTickers(scope: unknown): Promise<string[] | null> {
  if (scope === undefined || scope === null || scope === "market") return null;
  const s = scope as { watchlist?: unknown; index?: unknown };
  if (typeof s.watchlist === "string") {
    const l = watchlistStore.lists().find((x) => x.name.toLowerCase() === (s.watchlist as string).toLowerCase());
    if (!l) throw new AgentError(`No watchlist named "${s.watchlist}". Lists: ${watchlistStore.lists().map((x) => x.name).join(", ")}.`);
    return [...new Set([...l.groups.flatMap((g) => g.rows), ...l.extras].map((r) => r.ticker.split(":").pop() ?? r.ticker))];
  }
  if (typeof s.index === "string") {
    const code = s.index.toUpperCase();
    if (!INDEXES.some(([c]) => c === code)) throw new AgentError(`Index codes: ${INDEXES.map(([c, n]) => `${c} (${n})`).join(", ")}.`);
    const res = await screenerScan({ columns: [], filter: [{ left: "indexes", operation: "in_range", right: [code] }], sort: null, range: [0, 10_000], tickers: null });
    return res.rows.map((r) => r.s);
  }
  throw new AgentError('"scope": "market", {"watchlist": "<name>"} or {"index": "SPX"}.');
}

export function createScreenerTools(): AgentTool[] {
  // Read each time: a new daily state adds fields (the fundamentals).
  const fields = (): Promise<FieldInfo[]> => screenerFields();

  return [
    {
      name: "list_screener_fields",
      title: "List screener fields",
      description:
        "The fields run_screen can filter, sort and return: id, title and kind. Ids as in the screener (close, change, volume, market_cap_basic, EMA50, RSI, sector, indexes...). Prices of the US market, data delayed 15 minutes.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => ({ fields: agentFields(await fields()) }),
    },
    {
      name: "run_screen",
      title: "Run a screen",
      description:
        'Screen US stocks on the screener fields. filters: [{field, op, value}] with op ">", ">=", "<", "<=", "=", "!=", "between" ([low, high]), "outside", "in" (a list of texts); value can be {"field": "<id>"} to compare two fields (close > EMA200). scope: "market" (default), {"watchlist": "<name>"} or {"index": "SPX"|"NDX"|"DJI"|...}. Or screen: the name of a saved or popular screen (list_screens), run as the user set it up. Returns the total and the first rows (limit, default 50, max 500).',
      inputSchema: {
        type: "object",
        properties: {
          filters: { type: "array", items: { type: "object" } },
          columns: { type: "array", items: { type: "string" }, description: 'Fields to return (default: close, change, volume, market_cap_basic).' },
          sort: { type: "object", properties: { field: { type: "string" }, order: { type: "string", enum: ["asc", "desc"] } } },
          scope: {},
          screen: { type: "string" },
          limit: { type: "integer" },
        },
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        await useTable();
        const cat = await fields();
        const known = new Set(cat.filter((f) => f.available).map((f) => f.id));
        const has = (f: string) => known.has(f);
        const limit = Math.min(500, Math.max(1, Math.floor(Number(args.limit ?? 50)) || 50));
        if (typeof args.screen === "string") {
          const name = args.screen.toLowerCase();
          const saved = screenerStore.savedScreens().find((s) => s.screen.title.toLowerCase() === name);
          const popular = POPULAR_SCREENS.find((p) => p.title.toLowerCase() === name);
          const screen = saved?.screen ?? popular?.screen();
          if (!screen) throw new AgentError(`No screen named "${args.screen}": see list_screens.`);
          const plan = planScreen(screen, has, await scopeTickers(screen.watchlistId ? { watchlist: watchlistStore.lists().find((l) => l.id === screen.watchlistId)?.name } : null));
          const res = await screenerScan({ columns: plan.fields, filter: plan.filter, sort: plan.sort, range: [0, limit], tickers: plan.tickers });
          return { screen: screen.title, total: res.totalCount, rows: rowsOf(res.rows, plan.fields) };
        }
        const filters = Array.isArray(args.filters) ? args.filters.map((f) => clauseOf(f, has)) : [];
        const cols = (Array.isArray(args.columns) && args.columns.length ? args.columns : ["close", "change", "volume", "market_cap_basic"]).filter(
          (c): c is string => typeof c === "string",
        );
        const unknown = cols.filter((c) => !has(c));
        if (unknown.length) throw new AgentError(`Unknown column field(s): ${unknown.join(", ")}. See list_screener_fields.`);
        const out = has("description") ? [...cols, "description"] : cols;
        const sortArg = args.sort as { field?: unknown; order?: unknown } | undefined;
        const sortField = typeof sortArg?.field === "string" ? sortArg.field : null;
        if (sortField && sortField !== "name" && !has(sortField)) throw new AgentError(`Unknown sort field "${sortField}".`);
        const res = await screenerScan({
          columns: out,
          filter: [...(has(PRIMARY_UNIVERSE_CLAUSE.left) ? [PRIMARY_UNIVERSE_CLAUSE] : []), ...filters],
          sort: sortField ? { sortBy: sortField, sortOrder: sortArg?.order === "asc" ? "asc" : "desc" } : null,
          range: [0, limit],
          tickers: await scopeTickers(args.scope),
        });
        return { total: res.totalCount, rows: rowsOf(res.rows, out) };
      },
    },
    {
      name: "list_screens",
      title: "List screens",
      description: "The user's saved stock screens, the popular screens, and the user's saved script screens (indicator scans).",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => ({
        saved: screenerStore.savedScreens().map((s) => s.screen.title),
        popular: POPULAR_SCREENS.map((p) => ({ name: p.title, description: p.description })),
        scriptScreens: scriptScreenStore.saved().map((s) => s.name),
      }),
    },
    {
      name: "open_screen",
      title: "Open a screen",
      description: "Show a saved or popular stock screen, or a saved script screen, in the screener panel (opens the panel).",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: async (args) => {
        const name = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
        const saved = screenerStore.savedScreens().find((s) => s.screen.title.toLowerCase() === name);
        const popular = POPULAR_SCREENS.find((p) => p.title.toLowerCase() === name);
        const script = scriptScreenStore.saved().find((s) => s.name.toLowerCase() === name);
        if (!saved && !popular && !script) throw new AgentError(`No screen named "${args.name}": see list_screens.`);
        if (saved || popular) {
          scriptScreenStore.setKind("stock");
          if (saved) screenerStore.open(saved.id);
          else screenerStore.openPopular(popular!.id);
        } else {
          scriptScreenStore.setKind("script");
          scriptScreenStore.open(script!.id);
        }
        screenerPanel.setOpen(true);
        return { opened: saved?.screen.title ?? popular?.title ?? script!.name, kind: saved || popular ? "stock" : "script" };
      },
    },
    {
      name: "save_screen",
      title: "Save a screen",
      description:
        'Save a stock screen under a name and show it in the screener panel. filters as in run_screen (op ">", ">=", "<", "<=", "=", "between", "outside", or "in" for Sector, Industry, Index); scope: {"watchlist": "<name>"} or {"index": "SPX"}; columns: fields to show, or columnSet: overview, performance, valuation, dividends, profitability, incomeStatement, balanceSheet, cashFlow, perShare, technicals, extendedHours. A screen of that name is replaced only with replace: true. Returns how many symbols it finds.',
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          filters: { type: "array", items: { type: "object" } },
          columns: { type: "array", items: { type: "string" } },
          columnSet: { type: "string" },
          sort: { type: "object", properties: { field: { type: "string" }, order: { type: "string", enum: ["asc", "desc"] } } },
          scope: {},
          replace: { type: "boolean" },
        },
        required: ["name"],
      },
      run: async (args) => {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) throw new AgentError('"name" is required.');
        const scope = args.scope as { watchlist?: unknown } | undefined;
        let watchlistId: string | null = null;
        if (scope && typeof scope === "object" && typeof scope.watchlist === "string") {
          const l = watchlistStore.lists().find((x) => x.name.toLowerCase() === (scope.watchlist as string).toLowerCase());
          if (!l) throw new AgentError(`No watchlist named "${scope.watchlist}".`);
          watchlistId = l.id;
        }
        const screen = screenOf(args, name, watchlistId);
        const same = screenerStore.savedScreens().find((s) => s.screen.title.toLowerCase() === name.toLowerCase());
        if (same && args.replace !== true) throw new AgentError(`A screen is already named "${same.screen.title}": pass replace: true to replace it, or another name.`);
        // As the screener does it: open the saved screen, change it (one undo step), save.
        if (same) screenerStore.open(same.id);
        else screenerStore.createNew(name);
        screenerStore.update(() => screen);
        screenerStore.save();
        scriptScreenStore.setKind("stock");
        screenerPanel.setOpen(true);
        await useTable();
        const cat = await fields();
        const known = new Set(cat.filter((f) => f.available).map((f) => f.id));
        const plan = planScreen(screen, (f) => known.has(f), await scopeTickers(watchlistId ? { watchlist: scope!.watchlist } : null));
        const res = await screenerScan({ columns: plan.fields, filter: plan.filter, sort: plan.sort, range: [0, 10], tickers: plan.tickers });
        return { saved: name, replaced: !!same, total: res.totalCount, first: res.rows.map((r) => r.s) };
      },
    },
    {
      name: "delete_screen",
      title: "Delete a screen",
      description: "Delete one of the user's saved stock screens. Ask the user first: it cannot be undone.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      annotations: { destructiveHint: true },
      run: async (args) => {
        const name = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
        const saved = screenerStore.savedScreens().find((s) => s.screen.title.toLowerCase() === name);
        if (!saved) throw new AgentError(`No saved screen named "${args.name}": see list_screens.`);
        screenerStore.remove(saved.id);
        return { deleted: saved.screen.title };
      },
    },
  ];
}
