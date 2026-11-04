/*
 * Watchlist tools of Settings > Coding agents: read, create, rename and delete the user's watchlists, add and remove
 * symbols, flag them. They call the same store functions as the watchlist's menus (watchlist-store.ts), so every change
 * is saved and shows at once; a list the agent changes becomes the one shown, as when the user picks it.
 */
import { resolveSymbol } from "../data/datafeed";
import type { Row } from "../data/watchlist";
import { isDeletedList, watchlistStore, type WatchList } from "../data/watchlist-store";
import { allFlags, FLAG_COLORS as FLAGS } from "../data/symbol-flags";
import { setActiveRailTab } from "../window/shell/app-dialogs";
import { AgentError, type AgentTool } from "./mcp";

const names = () => watchlistStore.shownLists().map((l) => l.name).join(", ");

/** A list by name (any case), or the one shown when no name is given. */
export function listNamed(name: unknown): WatchList {
  const n = typeof name === "string" ? name.trim().toLowerCase() : "";
  const l = n ? watchlistStore.lists().find((x) => x.name.toLowerCase() === n) : watchlistStore.active();
  if (!l) throw new AgentError(n ? `No watchlist named "${name}". Lists: ${names()}.` : "No watchlist yet: create_watchlist first.");
  return l;
}

/** Symbols as given ("AAPL", "NASDAQ:AAPL") → their full names; the ones that resolve to nothing are left out. */
async function fullNames(raw: unknown): Promise<{ full: string[]; unknown: string[] }> {
  if (!Array.isArray(raw) || !raw.length || !raw.every((s) => typeof s === "string" && s.trim())) {
    throw new AgentError('"symbols": a non-empty array of symbols ("AAPL" or "NASDAQ:AAPL").');
  }
  const out = await Promise.all(
    raw.map(async (s: string) => {
      const t = s.trim().toUpperCase();
      try {
        return { t, full: (await resolveSymbol(t)).fullName.toUpperCase() };
      } catch {
        return { t, full: null };
      }
    }),
  );
  return { full: [...new Set(out.flatMap((o) => (o.full ? [o.full] : [])))], unknown: out.filter((o) => !o.full).map((o) => o.t) };
}

const rowOf = (ticker: string): Row => ({ ticker, short: ticker.split(":").pop() || ticker, last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null });

/** Show a list in the watchlist panel. */
function show(l: WatchList): void {
  watchlistStore.setActive(l.id);
  setActiveRailTab("base");
}

function describe(l: WatchList) {
  const flags = allFlags();
  const sym = (r: Row) => (flags[r.ticker] ? { symbol: r.ticker, flag: flags[r.ticker] } : r.ticker);
  return {
    name: l.name,
    symbols: l.extras.map(sym),
    sections: l.groups.map((g) => ({ name: g.name, symbols: g.rows.map(sym) })),
  };
}

export function createWatchlistTools(): AgentTool[] {
  return [
    {
      name: "list_watchlists",
      title: "List watchlists",
      description:
        "The user's watchlists: name, symbol count, sections, whether it is the one shown and flagged as a favourite. The colour lists (Red list…) hold the symbols flagged with that colour.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => ({
        watchlists: watchlistStore.shownLists().map((l) => ({
          name: l.name,
          symbols: l.extras.length + l.groups.reduce((n, g) => n + g.rows.length, 0),
          sections: l.groups.map((g) => g.name),
          ...(l.id === watchlistStore.activeId() ? { shown: true } : {}),
          ...(l.favorite ? { favorite: true } : {}),
        })),
      }),
    },
    {
      name: "get_watchlist",
      title: "Get watchlist",
      description: "The symbols of a watchlist (default: the one shown): the ones with no section first, then each section with its symbols, with their colour flag.",
      inputSchema: { type: "object", properties: { name: { type: "string", description: "Watchlist name (default: the one shown)." } } },
      annotations: { readOnlyHint: true },
      run: async (args) => describe(listNamed(args.name)),
    },
    {
      name: "create_watchlist",
      title: "Create watchlist",
      description:
        "Create a watchlist and show it. symbols: put with no section; sections: [{name, symbols}] (section names are upper-cased, as in the app). A name already in use takes \" 2\".",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          symbols: { type: "array", items: { type: "string" } },
          sections: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string" }, symbols: { type: "array", items: { type: "string" } } }, required: ["name"] },
          },
        },
        required: ["name"],
      },
      run: async (args) => {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) throw new AgentError('"name" is required.');
        const items: (Row | string)[] = [];
        const unknown: string[] = [];
        if (args.symbols !== undefined) {
          const r = await fullNames(args.symbols);
          items.push(...r.full.map(rowOf));
          unknown.push(...r.unknown);
        }
        if (args.sections !== undefined) {
          if (!Array.isArray(args.sections)) throw new AgentError('"sections": an array of {name, symbols}.');
          for (const s of args.sections as { name?: unknown; symbols?: unknown }[]) {
            const sec = typeof s?.name === "string" ? s.name.trim().toUpperCase() : "";
            if (!sec) throw new AgentError("Each section needs a name.");
            items.push(sec);
            if (Array.isArray(s.symbols) && s.symbols.length) {
              const r = await fullNames(s.symbols);
              items.push(...r.full.map(rowOf));
              unknown.push(...r.unknown);
            }
          }
        }
        const made = watchlistStore.createListWith(items, name);
        const l = listNamed(made);
        show(l);
        return { ...describe(l), ...(unknown.length ? { unknownSymbols: unknown } : {}) };
      },
    },
    {
      name: "add_to_watchlist",
      title: "Add to watchlist",
      description:
        "Add symbols to a watchlist (default: the one shown) and show it: at the end of the list, or at the end of a section (made when the list has none of that name). Symbols already in the list are skipped.",
      inputSchema: {
        type: "object",
        properties: {
          symbols: { type: "array", items: { type: "string" } },
          name: { type: "string", description: "Watchlist name (default: the one shown)." },
          section: { type: "string" },
        },
        required: ["symbols"],
      },
      run: async (args) => {
        const l = listNamed(args.name);
        if (isDeletedList(l.id)) throw new AgentError('"Deleted symbols" only takes the symbols removed from the other lists.');
        const { full, unknown } = await fullNames(args.symbols);
        show(l);
        const sec = typeof args.section === "string" ? args.section.trim().toUpperCase() : "";
        if (sec) watchlistStore.addSectionTo(l.id, sec);
        const cur = listNamed(l.name);
        const rows = sec ? cur.groups.find((g) => g.name === sec)?.rows : null;
        const last = rows?.[rows.length - 1]?.ticker;
        const added = watchlistStore.addSymbols(full.map(rowOf), sec ? (last ? { section: sec, after: last } : { section: sec }) : null);
        return {
          watchlist: cur.name,
          added,
          ...(full.length > added.length ? { alreadyThere: full.filter((s) => !added.includes(s)) } : {}),
          ...(unknown.length ? { unknownSymbols: unknown } : {}),
        };
      },
    },
    {
      name: "remove_from_watchlist",
      title: "Remove from watchlist",
      description: 'Remove symbols from a watchlist (default: the one shown). They go to the "Deleted symbols" list, where the user can take them back.',
      inputSchema: {
        type: "object",
        properties: { symbols: { type: "array", items: { type: "string" } }, name: { type: "string" } },
        required: ["symbols"],
      },
      annotations: { destructiveHint: true },
      run: async (args) => {
        const l = listNamed(args.name);
        if (!Array.isArray(args.symbols) || !args.symbols.length) throw new AgentError('"symbols": a non-empty array.');
        const removed: string[] = [];
        const missing: string[] = [];
        for (const s of args.symbols) {
          const t = String(s).trim().toUpperCase();
          const short = t.split(":").pop() ?? t;
          // Matched on the full name or the ticker, as the list holds it.
          const row = [...l.extras, ...l.groups.flatMap((g) => g.rows)].find((r) => r.ticker === t || r.ticker.split(":").pop() === short);
          if (!row) {
            missing.push(t);
            continue;
          }
          watchlistStore.removeRowFrom(l.id, row.ticker);
          removed.push(row.ticker);
        }
        return { watchlist: l.name, removed, ...(missing.length ? { notInList: missing } : {}) };
      },
    },
    {
      name: "rename_watchlist",
      title: "Rename watchlist",
      description: "Rename a watchlist.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, newName: { type: "string" } }, required: ["name", "newName"] },
      run: async (args) => {
        const l = listNamed(args.name);
        const next = typeof args.newName === "string" ? args.newName.trim() : "";
        if (!next) throw new AgentError('"newName" is required.');
        if (isDeletedList(l.id) || l.id.startsWith("color-")) throw new AgentError(`"${l.name}" cannot be renamed.`);
        if (watchlistStore.lists().some((x) => x.id !== l.id && x.name.toLowerCase() === next.toLowerCase())) throw new AgentError(`A watchlist is already named "${next}".`);
        watchlistStore.renameList(l.id, next);
        return { renamed: l.name, to: next };
      },
    },
    {
      name: "delete_watchlist",
      title: "Delete watchlist",
      description: "Delete a watchlist. The colour lists, \"Deleted symbols\" and the last list cannot be deleted. Ask the user first: it cannot be undone.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      annotations: { destructiveHint: true },
      run: async (args) => {
        const l = listNamed(args.name);
        if (l.id.startsWith("color-") || isDeletedList(l.id)) throw new AgentError(`"${l.name}" cannot be deleted.`);
        if (watchlistStore.lists().filter((x) => !x.id.startsWith("color-") && !isDeletedList(x.id)).length <= 1) throw new AgentError("The last watchlist cannot be deleted.");
        watchlistStore.deleteList(l.id);
        return { deleted: l.name };
      },
    },
    {
      name: "open_watchlist",
      title: "Open watchlist",
      description: "Show a watchlist in the watchlist panel.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: async (args) => {
        const l = listNamed(args.name);
        show(l);
        return { shown: l.name };
      },
    },
    {
      name: "flag_symbols",
      title: "Flag symbols",
      description: `Flag symbols with a colour (${FLAGS.join(", ")}), or remove their flag (color: null). A flag belongs to the symbol: it shows in every list and adds it to that colour's list.`,
      inputSchema: {
        type: "object",
        properties: { symbols: { type: "array", items: { type: "string" } }, color: { type: ["string", "null"], enum: [...FLAGS, null] } },
        required: ["symbols", "color"],
      },
      run: async (args) => {
        const color = args.color === null ? null : FLAGS.find((c) => c === args.color);
        if (color === undefined) throw new AgentError(`"color": one of ${FLAGS.join(", ")}, or null to remove the flag.`);
        const { full, unknown } = await fullNames(args.symbols);
        for (const s of full) watchlistStore.setRowFlag(s, color);
        return { flagged: full, color, ...(unknown.length ? { unknownSymbols: unknown } : {}) };
      },
    },
  ];
}
