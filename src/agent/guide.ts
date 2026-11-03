/*
 * What Settings > Coding agents teaches an agent: the server instructions (the workflow), the reference material
 * (the libraries' own agent guides, as installed with this build; the indicator catalogue; the drawing tools) and
 * the prompts.
 */
import { OVERLAY_SPECS } from "lightweight-charts-drawing/core/specs";
import type { AgentPrompt, AgentResource } from "./mcp";

export const AGENT_INSTRUCTIONS = `OpenTrader is a desktop charting app. These tools act on the chart tab the user focused last, through the app's own
commands: every change shows at once, is saved, and the user can undo it.

Start with get_chart (symbol, interval, studies of each pane).

Writing an indicator or a strategy (OakScript: JavaScript with a Pine Script v6 style API):
1. Read the oakscriptjs guide first (resource opentrader://guides/oakscriptjs/SKILL.md, then the files it links): it has
   complete examples. The user's own scripts: list_scripts / read_script.
2. write_script saves and compiles: fix the errors it gives (line, column) and write again until it compiles.
3. add_script_to_chart, then check: get_chart (run error of the study), get_chart_data (the values by bar), screenshot (the look).
   A strategy runs in the Strategy Tester: get_strategy_report.
4. When the user's script is already on the chart, write_script on its id redraws it: don't add it twice.

Rules:
- Don't remove the user's studies, drawings or scripts unless asked; prefer a new script to overwriting one.
- Times are UNIX seconds (bar open). Symbols are EXCHANGE:TICKER ("NASDAQ:AAPL"). Live data may be delayed.
- Library indicators: list_indicators, describe_indicator, then add_indicator with inputs.
- Drawings: the kinds and their point counts are in opentrader://drawings/tools.
- Screening the US market: list_screener_fields, then run_screen (filters, sort, scope: market, a watchlist or an
  index); the user's screens: list_screens, run_screen with screen, open_screen to show one in the screener panel.
- Trade journal: import_trades (symbol, entry, exit per trade), list_journal_trades (P&L, run-up, drawdown read on the
  bars; wait: true until computed), show_journal_trade to show one on the chart or replay it from its entry.`;

// The libraries' agent guides (skills/ in each package), bundled as text; empty until a library ships one.
const oakGuides = import.meta.glob("../../node_modules/oakscriptjs/skills/**/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const indicatorGuides = import.meta.glob("../../node_modules/lightweight-charts-indicators/skills/**/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const drawingGuides = import.meta.glob("../../../lightweight-charts-drawing/skills/**/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const LIBRARY_GUIDES: { lib: string; about: string; files: Record<string, string> }[] = [
  { lib: "oakscriptjs", about: "Writing OakScript indicators and strategies", files: oakGuides },
  { lib: "lightweight-charts-indicators", about: "The built-in indicators: finding, calling and adding them", files: indicatorGuides },
  { lib: "lightweight-charts-drawing", about: "Drawings: the model, the tools, their points and styles", files: drawingGuides },
];

/** `.../skills/<skill>/<rest>` → `<rest>` (one skill per library). */
const skillPath = (file: string) => file.slice(file.indexOf("/skills/") + "/skills/".length).replace(/^[^/]+\//, "");

export function libraryGuideResources(): AgentResource[] {
  return LIBRARY_GUIDES.flatMap(({ lib, about, files }) =>
    Object.entries(files)
      // SKILL.md first: the entry point.
      .sort(([a], [b]) => Number(skillPath(b) === "SKILL.md") - Number(skillPath(a) === "SKILL.md") || a.localeCompare(b))
      .map(([file, text]) => ({
        uri: `opentrader://guides/${lib}/${skillPath(file)}`,
        name: `${lib}/${skillPath(file)}`,
        description: skillPath(file) === "SKILL.md" ? `${about} (start here)` : `${about}: ${skillPath(file)}`,
        mimeType: "text/markdown",
        read: () => text,
      })),
  );
}

export function drawingToolsResource(): AgentResource {
  return {
    uri: "opentrader://drawings/tools",
    name: "drawings/tools",
    description: "Every drawing kind for add_drawing and the number of points it takes",
    mimeType: "application/json",
    read: () =>
      JSON.stringify(
        Object.values(OVERLAY_SPECS).map((s) => ({ kind: s.kind, points: s.pointCount })),
        null,
        0,
      ),
  };
}

export const AGENT_PROMPTS: AgentPrompt[] = [
  {
    name: "new_indicator",
    description: "Write a new OakScript indicator and put it on the chart",
    arguments: [{ name: "idea", description: "What the indicator shows", required: true }],
    text: (a) =>
      `Write a new OakScript indicator for OpenTrader: ${a.idea}\n\nFollow the server instructions: read the oakscriptjs guide, write_script until it compiles, add_script_to_chart, then check get_chart_data and a screenshot. Report what it plots and its inputs.`,
  },
  {
    name: "new_strategy",
    description: "Write a new OakScript strategy and read its Strategy Tester report",
    arguments: [{ name: "idea", description: "The entry and exit rules", required: true }],
    text: (a) =>
      `Write a new OakScript strategy for OpenTrader: ${a.idea}\n\nFollow the server instructions: read the oakscriptjs guide, write_script until it compiles, add_script_to_chart, then get_strategy_report. Summarise net profit, drawdown, profit factor and the number of trades, and say what you would test next.`,
  },
  {
    name: "fix_script",
    description: "Find and fix the error of a script on the chart",
    arguments: [{ name: "scriptId", description: "The script (default: the one on the chart with an error)" }],
    text: (a) =>
      `Fix ${a.scriptId ? `the script ${a.scriptId}` : "the script on the focused chart that has an error"} in OpenTrader.\n\nCall get_chart to see the error, read_script, fix it with write_script (it compiles), then check get_chart again and take a screenshot.`,
  },
];
