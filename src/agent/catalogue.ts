/*
 * Settings > Coding agents: the catalogue of what add_indicator takes (every built-in indicator and strategy, by
 * group), as one resource an agent can read instead of paging list_indicators.
 */
import { CANDLESTICK_ROWS, COMMUNITY_ROWS, PROFILE_ROWS, STANDARD_ROWS, loadIndicatorLibrary } from "../window/chart/indicators/registry";
import { builtinStrategyRows, strategyRows } from "../window/chart/indicators/strategy-entries";
import type { AgentResource } from "./mcp";

export function indicatorCatalogueResource(): AgentResource {
  return {
    uri: "opentrader://indicators/catalogue",
    name: "indicators/catalogue",
    description: "Every built-in indicator and strategy id with its name, by group (ids for add_indicator)",
    mimeType: "text/markdown",
    read: async () => {
      await loadIndicatorLibrary();
      const section = (title: string, rows: { id: string; name: string }[]) =>
        `## ${title}\n\n${rows.filter((r) => !r.id.startsWith("tool:")).map((r) => `- \`${r.id}\` ${r.name}`).join("\n")}`;
      return [
        "# Indicators and strategies\n\nIds for add_indicator and describe_indicator. The user's own scripts: list_scripts.",
        section("Indicators", STANDARD_ROWS),
        section("Volume profiles", PROFILE_ROWS),
        section("Candlestick patterns", CANDLESTICK_ROWS),
        section("Strategies", builtinStrategyRows()),
        section("Community indicators", COMMUNITY_ROWS),
        section("Community strategies", strategyRows()),
      ].join("\n\n");
    },
  };
}
