/*
 * Texts the interface shows that the extractor can't find in the code: written by a library, or held where the
 * scanner doesn't look (a tuple, a field read by another module). The catalog lists them from here; each group says
 * where the text comes from, and a text leaves this list when its source no longer shows it.
 */
import type { FoundText } from "./catalog";

const GROUPS: Record<string, string[]> = {
  "drawing library, labels translated by i18n/drawing-labels.ts": [
    "Left Shoulder",
    "Head",
    "Right Shoulder",
    "SUCCESS",
    "FAILURE",
    "Target",
    "Stop",
    "Amount",
    "Open PnL",
    "Closed PnL",
    "PnL",
    "Qty",
    "Risk/reward ratio",
  ],
  "indicator library, text the studies draw": [
    "Avgs",
    "Pos%",
    "Zero line",
    "No gaps found on the current chart.",
    "The cause could be that some exchanges align the open of new bars on the close of the previous one, resulting in charts with no gaps. Alternatively, your Minimal Deviation might be too high.",
  ],
  "data/alert-condition.ts, band operators (bandOperatorLabel) and OPERATOR_LABELS": [
    "Entering Channel",
    "Exiting Channel",
    "Inside Channel",
    "Outside Channel",
    "Entering rectangle",
    "Exiting rectangle",
    "Inside rectangle",
    "Outside rectangle",
    "alert() function calls only",
  ],
  "window/trading/ticket-labels.ts and TicketFields.tsx, order ticket fields": [
    "Cash amount you will gain if the take profit is executed",
    "Cash amount you will lose if the stop loss is executed",
    "Percentage of equity you will gain if the take profit is executed",
    "Percentage of equity you will lose if the stop loss is executed",
    "Reward % balance",
    "Risk % balance",
    "Shares",
    "Units",
    "Limit price",
    "Stop price",
  ],
  "data/trading/replay-account.ts, order comments and rejections": ["Close position (partial)", "Invalid quantity"],
  "window/oakscript and chart/indicators, script and study errors shown in the console and on the chart": [
    "Protocol mismatch.",
    "Script no longer exists.",
    "Script transform failed.",
    "The script must declare strategy() and run its logic in strategy.eachBar().",
    "This symbol doesn't exist, please pick another one.",
  ],
  "window/drawings/DrawingToolbar.tsx, magnet modes": ["Weak magnet", "Strong magnet"],
  "volume profile, rows layout option": ["Number Of Rows"],
  "window/right-rail/AlertsPanel.tsx, the Log tab (SegmentedControl sense)": ["Log|history"],
};

export const RUN_TIME_TEXTS: FoundText[] = Object.entries(GROUPS).flatMap(([at, texts]) => texts.map((text) => ({ text, at: `run time: ${at}` })));
