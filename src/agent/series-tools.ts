/*
 * Imported series tools of Settings > Coding agents (#266): read bars given as CSV text into a "LOCAL:<NAME>"
 * symbol, list them, remove one (the same store as the symbol search's Local tab, data/local-series).
 */
import { deleteLocalSeries, importLocalSeries, localSeriesList, localSymbol } from "../data/local-series";
import { AgentError, type AgentTool } from "./mcp";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createSeriesTools(): AgentTool[] {
  return [
    {
      name: "import_series",
      title: "Import bars (CSV)",
      description:
        "Read bars given as CSV text into the symbol LOCAL:<name> (replacing a series of that name), for charts, studies, " +
        "scripts, the Strategy Tester and bar replay, with no live data. Columns: time, open, high, low, close, volume (or " +
        "time and one value), a header line optional; times are UNIX seconds or ms, dates, \"YYYY-MM-DD HH:MM[:SS]\" or ISO " +
        "with an offset. The bar size is found from the times; the chart offers it and every larger interval. " +
        "Show it with set_symbol. In scripts, request.seed(source, name, expression) reads it too.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Ticker: A-Z, 0-9, '.', '_' or '-', at most 42." },
          csv: { type: "string", description: "The file's text." },
          timeZone: { type: "string", description: 'IANA zone of times written without an offset and of the days (default "UTC").' },
          description: { type: "string" },
        },
        required: ["name", "csv"],
      },
      run: async (args) => {
        if (typeof args.name !== "string" || typeof args.csv !== "string") throw new AgentError("name and csv are required strings.");
        const timeZone = typeof args.timeZone === "string" && args.timeZone.trim() ? args.timeZone.trim() : "UTC";
        try {
          new Intl.DateTimeFormat("en-US", { timeZone });
        } catch {
          throw new AgentError(`timeZone: unknown zone "${timeZone}".`);
        }
        try {
          const { series, skipped } = await importLocalSeries({
            name: args.name,
            csv: args.csv,
            timeZone,
            description: typeof args.description === "string" ? args.description : undefined,
          });
          return { symbol: localSymbol(series.name), barSize: series.base, bars: series.bars, first: series.first, last: series.last, hasVolume: series.hasVolume, skippedLines: skipped };
        } catch (e) {
          throw new AgentError(message(e));
        }
      },
    },
    {
      name: "list_series",
      title: "List imported series",
      description: "The imported series (LOCAL:<name> symbols): bar size, bar count, first and last bar time (UNIX seconds), time zone.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => ({
        series: localSeriesList().map((s) => ({
          symbol: localSymbol(s.name),
          description: s.description,
          barSize: s.base,
          bars: s.bars,
          first: s.first,
          last: s.last,
          timeZone: s.timezone,
          hasVolume: s.hasVolume,
        })),
      }),
    },
    {
      name: "delete_series",
      title: "Delete an imported series",
      description: "Remove an imported series and its bars (cannot be undone: ask the user first).",
      inputSchema: { type: "object", properties: { name: { type: "string", description: "Its name, with or without LOCAL:." } }, required: ["name"] },
      annotations: { destructiveHint: true },
      run: async (args) => {
        const name = typeof args.name === "string" ? args.name.trim().replace(/^LOCAL:/i, "").toUpperCase() : "";
        if (!localSeriesList().some((s) => s.name === name)) throw new AgentError(`No imported series "${name}": see list_series.`);
        try {
          await deleteLocalSeries(name);
        } catch (e) {
          throw new AgentError(message(e));
        }
        return { removed: localSymbol(name) };
      },
    },
  ];
}
