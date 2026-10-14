/**
 * Regression net of the backtester: every built-in strategy, every TypeScript port and every OakScript strategy
 * script runs with its default inputs and properties on three synthetic series (daily, 5-minute regular session,
 * penny stock), and once more on the daily and penny series with commission and slippage set; the summary of each run (performance, trades, filled orders, or the runtime error) is compared
 * with its file snapshot in __snapshots__/golden.
 *
 * The engine was validated against the reference reports privately; these snapshots pin that behaviour. A change
 * in a snapshot is a change in fills, sizes or statistics: review it, then update with `npx vitest run -u`.
 */
import { describe, expect, it } from "vitest";
import { calculateTechnicalRatingsStandard } from "lightweight-charts-indicators";
import { BUILTIN_STRATEGIES } from "../builtins";
import { provideTechnicalRatings } from "../builtins/technical-ratings";
import { runOakScriptStrategy, type ScriptStrategy } from "../oakscript";
import { runBacktest } from "../run";
import { SCRIPT_STRATEGIES } from "../scripts";
import { STRATEGIES } from "../strategies";
import { datasets, describeError, summarize, type Dataset } from "./golden";

provideTechnicalRatings(calculateTechnicalRatingsStandard);

function snapshotPath(ds: Dataset, family: string, key: string): string {
  return `./__snapshots__/golden/${ds.name}/${family}.${key}.txt`;
}

function header(ds: Dataset, family: string, key: string): string[] {
  const b = ds.bars;
  return [`${family}/${key} on ${ds.name}: ${b.length} bars, first ${b[0].time}, last ${b[b.length - 1].time}`];
}

function runScript(s: ScriptStrategy, ds: Dataset): string[] {
  try {
    const run = runOakScriptStrategy(s.body, ds.bars, { chart: ds.chart, properties: ds.properties });
    if (!run.report) return ["no report (the script did not run as a strategy)"];
    return summarize(run.report);
  } catch (e) {
    return [describeError(e)];
  }
}

const families: { family: string; strategies: ScriptStrategy[] }[] = [
  { family: "builtin", strategies: BUILTIN_STRATEGIES },
  { family: "script", strategies: SCRIPT_STRATEGIES },
];

for (const ds of datasets()) {
  describe(`golden backtests on ${ds.name}`, () => {
    for (const { family, strategies } of families) {
      for (const s of strategies) {
        it(`${family} ${s.key}`, async () => {
          const text = [...header(ds, family, s.key), ...runScript(s, ds)].join("\n") + "\n";
          await expect(text).toMatchFileSnapshot(snapshotPath(ds, family, s.key));
        });
      }
    }
    for (const def of STRATEGIES) {
      it(`port ${def.key}`, async () => {
        let lines: string[];
        try {
          lines = summarize(runBacktest(ds.bars, def, { symbol: ds.symbol, properties: ds.properties }));
        } catch (e) {
          lines = [describeError(e)];
        }
        const text = [...header(ds, "port", def.key), ...lines].join("\n") + "\n";
        await expect(text).toMatchFileSnapshot(snapshotPath(ds, "port", def.key));
      });
    }
  });
}
