/*
 * Script logs (#323): which script's log.*() messages the Logs panel shows (the right-side panel "script_logs"), and
 * where they come from: the last result of the script's study on the charts (an indicator or a strategy).
 */
import { createSignal } from "solid-js";
import type { LogEntry } from "oakscriptjs/script";
import { emitAppEvent } from "../../../data/app-events";
import { userScriptLogs } from "../../chart/indicators/user-scripts";
import { userStrategyLogs } from "../../chart/indicators/strategy-entries";

/** The right-side panel of the logs (it has no button on the rail). */
export const SCRIPT_LOGS_PANEL = "script_logs";

/** The script whose logs are shown: its id, the study they come from (any of the script's when absent). */
export type LogsTarget = { scriptId: string; studyId?: string };

const [logsTarget, setLogsTarget] = createSignal<LogsTarget | null>(null);
export { logsTarget };

/** Opens the Logs panel on the messages of script `scriptId` (of its study `studyId` when given). */
export function openScriptLogs(target: LogsTarget): void {
  setLogsTarget(target);
  emitAppEvent("chart-open-panel", { id: SCRIPT_LOGS_PANEL });
}

/** The messages of the target's last result; null: the script has no result on a chart. */
export function readScriptLogs(target: LogsTarget): LogEntry[] | null {
  return userScriptLogs(target.scriptId, target.studyId) ?? userStrategyLogs(target.scriptId, target.studyId);
}
