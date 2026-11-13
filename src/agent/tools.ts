/*
 * The tools of Settings > Coding agents: what an agent can read and do on the chart the user focused last, through
 * the same store functions as the app's own menus and dialogs (so every change is an undo step, saved and shown).
 */
import { emitAppEvent } from "../data/app-events";
import { chartBars, chartComparesFor } from "../data/chart-state-registry";
import { isSupportedResolution, supportedResolutions, toFullSymbol } from "../data/datafeed";
import * as scripts from "../data/oakscript-store";
import { strategyTester } from "../data/strategy-tester-store";
import { exportableCharts } from "../window/chart/chart-export";
import { layoutSnapshot, snapshotTheme } from "../window/chart/layout-snapshot";
import {
  CANDLESTICK_ROWS,
  COMMUNITY_ROWS,
  PROFILE_ROWS,
  STANDARD_ROWS,
  getIndicatorEntry,
  indicatorName,
  loadIndicatorLibrary,
} from "../window/chart/indicators/registry";
import {
  builtinStrategyRows,
  isStrategyId,
  notifyUserStrategyCompiled,
  strategyKeyOf,
  strategyRows,
  userStrategyId,
} from "../window/chart/indicators/strategy-entries";
import { typeIdOf } from "../window/chart/indicators/study-id";
import { notifyScriptCompiled, scriptIdOfStudy, userIndicatorId, userScriptErrors } from "../window/chart/indicators/user-scripts";
import { OakEngineError, getOakEngine, type OakCompiledMeta } from "../window/oakscript/engine";
import { OVERLAY_SPECS, defaultStyleFor } from "lightweight-charts-drawing/core/specs";
import type { Drawing, DrawingKind, NewDrawing } from "lightweight-charts-drawing/core/types";
import type { AppTabs } from "../window/shell/app-tabs";
import type { DrawingStore } from "../window/drawings/drawing-store";
import type { createChartEdits } from "../window/shell/chart-edits";
import { AgentError, type AgentTool } from "./mcp";
import { locateSyntaxError } from "./syntax";
import { createScreenerTools } from "./screener-tools";
import { createJournalTools } from "./journal-tools";
import { createSeriesTools } from "./series-tools";
import { createWatchlistTools } from "./watchlist-tools";
import { createAlertTools } from "./alert-tools";
import { createCommunityTools } from "./community-tools";
import { createFilingsTools } from "./filings-tools";
import { createNotesTools } from "./notes-tools";
import { createLayoutTools, type LayoutHost } from "./layout-tools";

/** What App hands the tools. */
export type AgentHost = {
  tabs: Pick<AppTabs, "activeTab" | "activePaneState" | "tabs" | "activateTab">;
  edits: Pick<ReturnType<typeof createChartEdits>, "addIndicator" | "removeIndicatorFromPane" | "patchStudyInputs">;
  drawings: Pick<DrawingStore, "drawingKeyFor" | "drawingsFor" | "addDrawingToSymbol" | "updateDrawingForSymbol" | "removeDrawingForSymbol">;
  setSymbol: (symbol: string) => void;
  setInterval: (interval: string) => void;
  layouts: LayoutHost["layouts"];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `get()` once it gives a value, else null after `ms`. */
async function waitFor<T>(get: () => T | null | undefined, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== null && v !== undefined) return v;
    if (Date.now() >= end) return null;
    await sleep(100);
  }
}

/** The symbols compared on the chart of a pane (shown ones only: a chart in another tab is not built), for get_chart. */
function comparesOf(symbol: string): { compares?: { symbol: string; label: string; hidden?: true }[] } {
  const list = chartComparesFor(symbol).map((c) => ({ symbol: c.symbol, label: c.label, ...(c.hidden ? { hidden: true as const } : {}) }));
  return list.length ? { compares: list } : {};
}

const str = (args: Record<string, unknown>, key: string, required = true): string => {
  const v = args[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (required) throw new AgentError(`"${key}" is required (a string).`);
  return "";
};
const int = (args: Record<string, unknown>, key: string, def: number, max: number): number => {
  const v = args[key];
  if (v === undefined || v === null) return def;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) throw new AgentError(`"${key}" must be a positive integer.`);
  return Math.min(n, max);
};
const obj = (args: Record<string, unknown>, key: string): Record<string, unknown> | undefined => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new AgentError(`"${key}" must be an object.`);
  return v as Record<string, unknown>;
};

/** Rounds to 6 significant digits (enough to read, a third of the tokens). */
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Number(v.toPrecision(6)) : null);

/** The inputs of a registry entry, as an agent needs them. */
function describeInputs(inputConfig: unknown[] | undefined) {
  return (inputConfig ?? []).map((c) => {
    const i = c as Record<string, unknown>;
    const out: Record<string, unknown> = { id: i.id, title: i.title, type: i.type, default: i.defval };
    for (const k of ["options", "min", "max", "step"]) if (i[k] !== undefined) out[k] = i[k];
    return out;
  });
}

function compileError(e: unknown): { message: string; line?: number; column?: number } {
  if (e instanceof OakEngineError) return { message: e.detail.message, line: e.detail.line, column: e.detail.col };
  return { message: e instanceof Error ? e.message : String(e) };
}

function metaSummary(meta: OakCompiledMeta) {
  return {
    kind: meta.strategy ? "strategy" : "indicator",
    title: meta.title,
    overlay: meta.overlay,
    inputs: describeInputs(meta.inputConfig),
    plots: (meta.plotConfig ?? []).map((p) => {
      const c = p as Record<string, unknown>;
      return { id: c.id, title: c.title };
    }),
  };
}

export function createAgentTools(host: AgentHost): AgentTool[] {
  const pane = () => host.tabs.activePaneState();
  const tab = () => host.tabs.activeTab();
  const drawingKey = () => host.drawings.drawingKeyFor(pane(), tab().id);
  /** The focused chart's export source (bars and study values by time). */
  const activeExport = () => {
    const charts = exportableCharts();
    return (charts.find((c) => c.source.active()) ?? charts[0])?.source ?? null;
  };
  /** Once the focused chart has the bars of its symbol and interval: how many (the chart shows them). */
  const loaded = async () => {
    // The change reaches the chart on its next frame.
    await sleep(50);
    const p = pane();
    const bars = await waitFor(() => chartBars(p.symbol, p.interval, p.session), 15000);
    return bars ? { bars: bars.length } : { bars: 0, note: "No bars yet: the chart is still loading or has no data for it." };
  };
  const requireStudy = (id: string) => {
    if (!pane().indicators.includes(id)) {
      throw new AgentError(`No study "${id}" on the focused chart. Its studies: ${pane().indicators.join(", ") || "none"}.`);
    }
  };

  /** Compile a saved script and tell the charts and the editor (as a save in the editor does). */
  async function compile(scriptId: string) {
    const script = scripts.loadScript(scriptId);
    if (!script) throw new AgentError(`No script "${scriptId}". Call list_scripts.`);
    try {
      const meta = await getOakEngine().compile(scriptId, script.source);
      notifyScriptCompiled(scriptId, meta);
      notifyUserStrategyCompiled(scriptId, meta);
      return { scriptId, name: script.name, compiled: true as const, ...metaSummary(meta) };
    } catch (e) {
      const error: { message: string; line?: number; column?: number; syntax?: string } = compileError(e);
      // A syntax error comes without its place: the editor's JavaScript service finds it.
      if (error.line === undefined) {
        const place = await locateSyntaxError(script.source).catch(() => null);
        if (place) Object.assign(error, { line: place.line, column: place.column, syntax: place.message });
      }
      return { scriptId, name: script.name, compiled: false as const, error };
    }
  }

  /** Add a study type to the focused chart and give its instance id. */
  function addStudy(typeId: string): string {
    const before = new Set(pane().indicators);
    host.edits.addIndicator(typeId);
    const added = pane().indicators.find((id) => !before.has(id));
    if (!added) throw new AgentError(`"${typeId}" was not added. Call list_indicators for the ids.`);
    return added;
  }

  /** Throws on input ids the study type does not have. */
  function checkInputs(id: string, inputs: Record<string, unknown>) {
    const known = new Set((getIndicatorEntry(id)?.inputConfig ?? []).map((c) => (c as { id: string }).id));
    const unknown = Object.keys(inputs).filter((k) => !known.has(k));
    if (unknown.length) throw new AgentError(`Unknown input(s) ${unknown.join(", ")}. Inputs: ${[...known].join(", ") || "none"}.`);
  }

  /** Set inputs of a study on the focused chart (one undo step, as the Settings dialog's Ok); the chart draws them
   *  from the saved settings. */
  function setInputs(studyId: string, inputs: Record<string, unknown>) {
    checkInputs(studyId, inputs);
    const t = tab();
    host.edits.patchStudyInputs(t.id, t.activePane, studyId, inputs);
  }

  const tools: AgentTool[] = [
    // ── Chart ──────────────────────────────────────────────────────────
    {
      name: "get_chart",
      title: "Get chart",
      description:
        "The focused chart tab: its layout, the focused pane, and for each pane the symbol, interval, chart type, session, studies (id, type, name, input values) and compared symbols (symbol, label). Call it first.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => {
        await loadIndicatorLibrary();
        const t = tab();
        return {
          layout: t.layout,
          focusedPane: t.activePane,
          panes: t.panes.map((p, index) => ({
            index,
            symbol: p.symbol,
            interval: p.interval,
            chartType: p.chartType,
            session: p.session,
            studies: p.indicators.map((id) => {
              const scriptId = scriptIdOfStudy(id);
              const errors = scriptId ? userScriptErrors(scriptId) : [];
              return {
                id,
                type: typeIdOf(id),
                name: getIndicatorEntry(id)?.name ?? indicatorName(id) ?? id,
                inputs: p.indicatorSettings?.[id]?.inputs ?? {},
                ...(p.indicatorSettings?.[id]?.hidden ? { hidden: true } : {}),
                ...(errors.length ? { error: errors[0] } : {}),
              };
            }),
            ...comparesOf(p.symbol),
          })),
        };
      },
    },
    {
      name: "set_symbol",
      title: "Set symbol",
      description: 'Show a symbol on the focused chart ("AAPL" or "NASDAQ:AAPL"). Linked charts follow, as when the user picks it.',
      inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      run: async (args) => {
        const asked = str(args, "symbol");
        const symbol = await toFullSymbol(asked).catch(() => {
          throw new AgentError(`Unknown symbol "${asked}".`);
        });
        host.setSymbol(symbol);
        return { symbol, ...(await loaded()) };
      },
    },
    {
      name: "set_interval",
      title: "Set interval",
      description: 'Change the focused chart\'s interval. Ids: minutes as a number ("1", "5", "60", "240"), "1D", "1W", "1M", seconds as "1S".',
      inputSchema: { type: "object", properties: { interval: { type: "string" } }, required: ["interval"] },
      run: async (args) => {
        const interval = str(args, "interval");
        if (!isSupportedResolution(interval)) throw new AgentError(`Interval "${interval}" is not served. Served: ${supportedResolutions().join(", ")}.`);
        host.setInterval(interval);
        return { interval, ...(await loaded()) };
      },
    },
    {
      name: "get_bars",
      title: "Get bars",
      description: "The latest OHLCV bars of the focused chart, oldest first. time = bar open, UNIX seconds. Live data may be delayed.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", description: "Bars to return (default 100, max 5000)." } } },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const limit = int(args, "limit", 100, 5000);
        const p = pane();
        const bars = await waitFor(() => chartBars(p.symbol, p.interval, p.session), 15000);
        if (!bars) throw new AgentError(`No bars loaded for ${p.symbol} on ${p.interval} yet.`);
        return {
          symbol: p.symbol,
          interval: p.interval,
          loaded: bars.length,
          columns: ["time", "open", "high", "low", "close", "volume"],
          rows: bars.slice(-limit).map((b) => [b.time, num(b.open), num(b.high), num(b.low), num(b.close), b.volume === undefined ? null : Math.round(b.volume)]),
        };
      },
    },
    {
      name: "get_chart_data",
      title: "Get chart data",
      description:
        "The values of the focused chart by bar, oldest first: the main series and every visible study output and compared symbol (one column each, as the chart's data export). Use it to check what a study computes.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", description: "Bars to return (default 50, max 2000)." } } },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const limit = int(args, "limit", 50, 2000);
        const source = activeExport();
        if (!source) throw new AgentError("No chart is shown.");
        // Studies just added or changed compute on the next frames.
        await sleep(300);
        const { times, columns } = source.data();
        const last = times.slice(-limit);
        return {
          chart: source.title(),
          columns: ["time", ...columns.map((c) => c.title)],
          rows: last.map((t) => [t, ...columns.map((c) => num(c.values.get(t)))]),
        };
      },
    },
    {
      name: "screenshot",
      title: "Screenshot",
      description: "A PNG image of the focused chart tab as the user sees it (all charts of its layout, legends, studies, drawings).",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => {
        const source = activeExport();
        const grid = source?.host()?.closest<HTMLElement>(".chart-grid");
        if (!source || !grid) throw new AgentError("No chart is shown.");
        await sleep(300);
        const theme = document.documentElement.classList.contains("theme-light") ? "light" : "dark";
        const canvas = await layoutSnapshot(grid, snapshotTheme(theme), source.timeZone());
        if (!canvas) throw new AgentError("The chart could not be pictured.");
        const data = canvas.toDataURL("image/png").split(",")[1] ?? "";
        return { content: [{ type: "image", data, mimeType: "image/png" }] };
      },
    },

    // ── Indicators and strategies ──────────────────────────────────────
    {
      name: "list_indicators",
      title: "List indicators",
      description: "Find built-in indicators, strategies and the user's scripts by name or id. Gives ids for add_indicator.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: 'Words of the name or id ("rsi", "moving average"). Empty: all.' },
          limit: { type: "integer", description: "Default 50, max 500." },
        },
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        await loadIndicatorLibrary();
        const words = str(args, "query", false).toLowerCase().split(/\s+/).filter(Boolean);
        const limit = int(args, "limit", 50, 500);
        const rows: { id: string; name: string; group: string }[] = [
          ...STANDARD_ROWS.map((r) => ({ id: r.id, name: r.name, group: "indicator" })),
          ...PROFILE_ROWS.map((r) => ({ id: r.id, name: r.name, group: "volume profile" })),
          ...CANDLESTICK_ROWS.map((r) => ({ id: r.id, name: r.name, group: "candlestick pattern" })),
          ...COMMUNITY_ROWS.map((r) => ({ id: r.id, name: r.name, group: "community indicator" })),
          ...builtinStrategyRows().map((r) => ({ id: r.id, name: r.name, group: "strategy" })),
          ...strategyRows().map((r) => ({ id: r.id, name: r.name, group: "community strategy" })),
          ...scripts.listScripts().map((s) => {
            const strategy = !!scripts.loadScript(s.id)?.meta?.strategy;
            return { id: strategy ? userStrategyId(s.id) : userIndicatorId(s.id), name: s.name, group: strategy ? "my strategy" : "my script" };
          }),
        ].filter((r) => !r.id.startsWith("tool:"));
        const hits = rows.filter((r) => words.every((w) => r.name.toLowerCase().includes(w) || r.id.toLowerCase().includes(w)));
        return { total: hits.length, indicators: hits.slice(0, limit) };
      },
    },
    {
      name: "describe_indicator",
      title: "Describe indicator",
      description:
        "An indicator's or strategy's help text (about: what it computes, how to read it, its main inputs), inputs (id, type, default, options, range) " +
        "and outputs, by id from list_indicators. Explain an indicator from its about, not from memory.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        await loadIndicatorLibrary();
        const id = str(args, "id");
        const e = getIndicatorEntry(id);
        if (!e) throw new AgentError(`Unknown indicator "${id}". Call list_indicators.`);
        // The library's help texts load on the first explanation (about 700 kB).
        const { aboutIndicator } = await import("lightweight-charts-indicators/about");
        const about = aboutIndicator(typeIdOf(id)) ?? e.description;
        return {
          id: typeIdOf(id),
          name: e.name,
          overlay: e.overlay,
          strategy: isStrategyId(typeIdOf(id)),
          ...(about ? { about } : {}),
          inputs: describeInputs(e.inputConfig),
          plots: (e.plotConfig ?? []).map((p) => ({ id: p.id, title: p.title })),
        };
      },
    },
    {
      name: "add_indicator",
      title: "Add indicator",
      description: "Add an indicator or strategy to the focused chart (one more instance each call), optionally with inputs. Gives the study id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id from list_indicators." },
          inputs: { type: "object", description: "Input id → value (describe_indicator)." },
        },
        required: ["id"],
      },
      run: async (args) => {
        await loadIndicatorLibrary();
        const typeId = typeIdOf(str(args, "id"));
        if (!getIndicatorEntry(typeId)) throw new AgentError(`Unknown indicator "${typeId}". Call list_indicators.`);
        const inputs = obj(args, "inputs");
        if (inputs) checkInputs(typeId, inputs);
        const studyId = addStudy(typeId);
        if (inputs && Object.keys(inputs).length) setInputs(studyId, inputs);
        return { studyId };
      },
    },
    {
      name: "set_indicator_inputs",
      title: "Set indicator inputs",
      description: "Change inputs of a study on the focused chart (study id from get_chart). Other inputs keep their values.",
      inputSchema: {
        type: "object",
        properties: { studyId: { type: "string" }, inputs: { type: "object", description: "Input id → value." } },
        required: ["studyId", "inputs"],
      },
      run: async (args) => {
        await loadIndicatorLibrary();
        const studyId = str(args, "studyId");
        requireStudy(studyId);
        setInputs(studyId, obj(args, "inputs") ?? {});
        return { studyId, inputs: pane().indicatorSettings?.[studyId]?.inputs ?? {} };
      },
    },
    {
      name: "remove_indicator",
      title: "Remove indicator",
      description: "Remove a study from the focused chart (with the studies built on it). The user can undo it.",
      inputSchema: { type: "object", properties: { studyId: { type: "string" } }, required: ["studyId"] },
      annotations: { destructiveHint: true },
      run: async (args) => {
        const studyId = str(args, "studyId");
        requireStudy(studyId);
        const t = tab();
        host.edits.removeIndicatorFromPane(t.id, t.activePane, studyId);
        return { removed: studyId };
      },
    },
    {
      name: "get_strategy_report",
      title: "Get strategy report",
      description:
        "The Strategy Tester results of a strategy on the focused chart: performance (net profit, drawdown, profit factor, trades…) and the latest trades. Waits while it runs. Amounts are in the report currency; *Percent values are fractions (0.05 = 5%).",
      inputSchema: {
        type: "object",
        properties: {
          studyId: { type: "string", description: "Strategy study id (get_chart). Default: the chart's first strategy." },
          trades: { type: "integer", description: "Latest trades to include (default 20, max 500)." },
        },
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const studyId = str(args, "studyId", false) || pane().indicators.find((id) => isStrategyId(typeIdOf(id)));
        if (!studyId) throw new AgentError("No strategy on the focused chart.");
        requireStudy(studyId);
        if (!isStrategyId(typeIdOf(studyId))) throw new AgentError(`"${studyId}" is not a strategy.`);
        const key = strategyKeyOf(studyId);
        const run = await waitFor(() => {
          const r = strategyTester.run(strategyTester.activeChartId(), key);
          return r && r.status !== "running" ? r : null;
        }, 60000);
        if (!run) throw new AgentError("The strategy has not finished running (the chart may still be loading).");
        if (run.status === "error" || !run.report) return { status: "error", error: run.error };
        const r = run.report;
        const trades = int(args, "trades", 20, 500);
        return {
          status: "done",
          bars: run.bars,
          currency: r.currency,
          range: { from: Math.floor(r.range.from / 1000), to: Math.floor(r.range.to / 1000) },
          performance: r.performance,
          totalTrades: r.trades.length,
          // Times in UNIX seconds, as everywhere else in these tools.
          latestTrades: r.trades.slice(-trades).map((t) => ({
            ...t,
            entry: { ...t.entry, time: Math.floor(t.entry.time / 1000) },
            exit: { ...t.exit, time: Math.floor(t.exit.time / 1000) },
          })),
        };
      },
    },

    // ── Scripts ────────────────────────────────────────────────────────
    {
      name: "list_scripts",
      title: "List scripts",
      description: "The user's scripts (OakScript editor): id, name, indicator or strategy, and whether the focused chart shows it.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => {
        const on = new Set(pane().indicators.map(typeIdOf));
        return scripts.listScripts().map((s) => {
          const meta = scripts.loadScript(s.id)?.meta;
          return {
            id: s.id,
            name: s.name,
            kind: meta ? (meta.strategy ? "strategy" : "indicator") : "not compiled",
            onChart: on.has(userIndicatorId(s.id)) || on.has(userStrategyId(s.id)),
          };
        });
      },
    },
    {
      name: "read_script",
      title: "Read script",
      description: "The source of a script.",
      inputSchema: { type: "object", properties: { scriptId: { type: "string" } }, required: ["scriptId"] },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const s = scripts.loadScript(str(args, "scriptId"));
        if (!s) throw new AgentError("No such script. Call list_scripts.");
        return { id: s.id, name: s.name, source: s.source };
      },
    },
    {
      name: "write_script",
      title: "Write script",
      description:
        "Save a script's source (a new script without scriptId) and compile it. Gives the compile result: its inputs and plots, or the error with line and column to fix. A chart showing the script redraws it.",
      inputSchema: {
        type: "object",
        properties: {
          scriptId: { type: "string", description: "Script to overwrite. Absent: a new script." },
          name: { type: "string", description: "Script name (new script, or rename)." },
          source: { type: "string", description: "The whole script source." },
        },
        required: ["source"],
      },
      run: async (args) => {
        const source = args.source;
        if (typeof source !== "string" || !source.trim()) throw new AgentError('"source" is required.');
        const name = str(args, "name", false);
        let id = str(args, "scriptId", false);
        if (id) {
          if (!scripts.loadScript(id)) throw new AgentError(`No script "${id}". Call list_scripts, or omit scriptId for a new one.`);
          scripts.saveSource(id, source);
          if (name) scripts.renameScript(id, name);
        } else {
          id = scripts.createScript(name || undefined, source).id;
        }
        // An open editor shows the new text.
        emitAppEvent("oakscript-source-changed", { scriptId: id, source });
        return compile(id);
      },
    },
    {
      name: "compile_script",
      title: "Compile script",
      description: "Compile a saved script: its inputs and plots, or the error with line and column.",
      inputSchema: { type: "object", properties: { scriptId: { type: "string" } }, required: ["scriptId"] },
      run: async (args) => compile(str(args, "scriptId")),
    },
    {
      name: "add_script_to_chart",
      title: "Add script to chart",
      description:
        "Add a script to the focused chart (an indicator, or a strategy that then runs in the Strategy Tester). Compiles it first when needed. Gives the study id; check its values with get_chart_data and errors with get_chart.",
      inputSchema: { type: "object", properties: { scriptId: { type: "string" } }, required: ["scriptId"] },
      run: async (args) => {
        const scriptId = str(args, "scriptId");
        const compiled = await compile(scriptId);
        if (!compiled.compiled) return compiled;
        const studyId = addStudy(compiled.kind === "strategy" ? userStrategyId(scriptId) : userIndicatorId(scriptId));
        // A run error shows on the chart: give it when the first run fails.
        await sleep(500);
        const errors = userScriptErrors(scriptId);
        return { studyId, kind: compiled.kind, ...(errors.length ? { runError: errors[0] } : {}) };
      },
    },

    // ── Drawings ───────────────────────────────────────────────────────
    {
      name: "list_drawings",
      title: "List drawings",
      description: "The drawings on the focused chart: id, kind, points (time in UNIX seconds, price), text, style.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => host.drawings.drawingsFor(drawingKey()),
    },
    {
      name: "add_drawing",
      title: "Add drawing",
      description:
        'Draw on the focused chart. kind: a drawing tool ("trend-line", "horizontal-line", "rectangle", "fib-retracement", "text", "long-position"… see the opentrader://drawings/tools resource for each kind and its point count). points: [{time (UNIX seconds of a bar), price}]. style: overrides of the default style (color, width, lineStyle…).',
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string" },
          points: {
            type: "array",
            items: { type: "object", properties: { time: { type: "number" }, price: { type: "number" } }, required: ["time", "price"] },
          },
          text: { type: "string" },
          style: { type: "object" },
        },
        required: ["kind", "points"],
      },
      run: async (args) => {
        const kind = str(args, "kind") as DrawingKind;
        const spec = OVERLAY_SPECS[kind];
        if (!spec) throw new AgentError(`Unknown drawing kind "${kind}". See the opentrader://drawings/tools resource.`);
        const points = parsePoints(args.points);
        if (points.length < spec.pointCount) throw new AgentError(`"${kind}" needs ${spec.pointCount} point(s), got ${points.length}.`);
        const style = obj(args, "style");
        const text = str(args, "text", false);
        const d = {
          kind,
          points,
          ...(text ? { text } : {}),
          ...(style ? { style: { ...defaultStyleFor(kind), ...style } } : {}),
        } as unknown as NewDrawing;
        const id = host.drawings.addDrawingToSymbol(drawingKey(), d);
        return { drawingId: id };
      },
    },
    {
      name: "update_drawing",
      title: "Update drawing",
      description: "Move a drawing (points), change its text or its style (merged into the current style).",
      inputSchema: {
        type: "object",
        properties: {
          drawingId: { type: "string" },
          points: { type: "array", items: { type: "object", properties: { time: { type: "number" }, price: { type: "number" } } } },
          text: { type: "string" },
          style: { type: "object" },
        },
        required: ["drawingId"],
      },
      run: async (args) => {
        const key = drawingKey();
        const id = str(args, "drawingId");
        const cur = host.drawings.drawingsFor(key).find((d) => d.id === id);
        if (!cur) throw new AgentError(`No drawing "${id}" on the focused chart. Call list_drawings.`);
        const next = { ...cur } as Drawing & { text?: string };
        if (args.points !== undefined) {
          const points = parsePoints(args.points);
          if (points.length !== cur.points.length) throw new AgentError(`"${cur.kind}" has ${cur.points.length} point(s).`);
          (next as { points: unknown }).points = points;
        }
        if (typeof args.text === "string") next.text = args.text;
        const style = obj(args, "style");
        if (style) next.style = { ...cur.style, ...style } as Drawing["style"];
        host.drawings.updateDrawingForSymbol(key, next, `change ${cur.kind}`);
        return { drawingId: id };
      },
    },
    {
      name: "remove_drawing",
      title: "Remove drawing",
      description: "Remove a drawing from the focused chart. The user can undo it.",
      inputSchema: { type: "object", properties: { drawingId: { type: "string" } }, required: ["drawingId"] },
      annotations: { destructiveHint: true },
      run: async (args) => {
        const id = str(args, "drawingId");
        if (!host.drawings.drawingsFor(drawingKey()).some((d) => d.id === id)) throw new AgentError(`No drawing "${id}". Call list_drawings.`);
        host.drawings.removeDrawingForSymbol(drawingKey(), id);
        return { removed: id };
      },
    },
    // ── Screener ───────────────────────────────────────────────────────
    ...createScreenerTools(),
    // ── Trade journal ──────────────────────────────────────────────────
    ...createJournalTools(),
    // ── Imported series ────────────────────────────────────────────────
    ...createSeriesTools(),
    // ── Watchlists ─────────────────────────────────────────────────────
    ...createWatchlistTools(),
    // ── Alerts ─────────────────────────────────────────────────────────
    ...createAlertTools(() => ({ symbol: pane().symbol, interval: pane().interval, session: pane().session, drawings: () => host.drawings.drawingsFor(drawingKey()) })),
    // ── Layouts and tabs ───────────────────────────────────────────────
    ...createLayoutTools({ tabs: host.tabs, layouts: host.layouts }),
    // ── Community (read only) ──────────────────────────────────────────
    ...createCommunityTools(),
    // ── Company fundamentals and filings (read only) ───────────────────
    ...createFilingsTools(() => pane().symbol),
    // ── Symbol notes ───────────────────────────────────────────────────
    ...createNotesTools(() => pane().symbol),
  ];
  return tools;
}

function parsePoints(v: unknown): { time: number; price: number }[] {
  if (!Array.isArray(v) || v.length === 0) throw new AgentError('"points" must be a non-empty array of {time, price}.');
  return v.map((p, i) => {
    const time = Number((p as { time?: unknown })?.time);
    const price = Number((p as { price?: unknown })?.price);
    if (!Number.isFinite(time) || !Number.isFinite(price)) throw new AgentError(`Point ${i + 1} needs a numeric time (UNIX seconds) and price.`);
    // Milliseconds given by mistake.
    return { time: time > 1e11 ? Math.floor(time / 1000) : time, price };
  });
}
