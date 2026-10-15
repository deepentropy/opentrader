/*
 * Source code of the built-in indicators. The indicator library ships the
 * source of each standard study (`lightweight-charts-indicators/sources`:
 * plain JavaScript in the convention shape that the OakScript worker runs,
 * importing `oakscriptjs` and `lightweight-charts-indicators/helpers`). The
 * table is loaded on demand, when a source is first opened.
 *
 * The editor shows a built-in read-only under the script id
 * `builtin:<registry id>` (its own id space next to the stored scripts); a
 * copy of it is a stored script like any other.
 */
import { indicatorRegistry } from "lightweight-charts-indicators";
import { typeIdOf } from "../chart/indicators/study-id";
import { isStrategyId } from "../chart/indicators/strategy-entries";
import { USER_INDICATOR_PREFIX } from "../chart/indicators/user-scripts";

export const BUILTIN_SCRIPT_PREFIX = "builtin:";

/** Editor script id of the built-in study type `typeId`. */
export const builtinScriptId = (typeId: string): string => BUILTIN_SCRIPT_PREFIX + typeId;

/** The built-in study type an editor script id shows, else null (a stored script). */
export function builtinTypeOf(scriptId: string): string | null {
  return scriptId.startsWith(BUILTIN_SCRIPT_PREFIX) ? scriptId.slice(BUILTIN_SCRIPT_PREFIX.length) : null;
}

const byId = new Map(indicatorRegistry.map((e) => [e.id, e]));

/** Registry ids of the studies with a source in the library: its standard
 *  entries. The app's own built-ins (Volume, the profiles) are not scripts. */
const WITH_SOURCE = new Set(indicatorRegistry.filter((e) => e.group === "standard").map((e) => e.id));

/** The built-in study type of a study instance id that has a source, else null. */
export function builtinWithSource(studyId: string): string | null {
  const id = typeIdOf(studyId);
  return WITH_SOURCE.has(id) ? id : null;
}

/** Scripts whose source the app does not ship (the reference app has them as scripts with a source): the
 *  candlestick patterns, the community ports and the strategies other than the user's own. Their "Source code"
 *  menu row is disabled, the state the reference app gives a script whose source cannot be read. */
export function sourceUnavailable(studyId: string): boolean {
  const id = typeIdOf(studyId);
  if (isStrategyId(id)) return !id.slice("strategy:".length).startsWith(USER_INDICATOR_PREFIX);
  const group = byId.get(id)?.group;
  return group === "candlestick" || group === "community";
}

/** Name of a built-in study (its registry name, as the Indicators dialog lists it). */
export function builtinName(typeId: string): string {
  return byId.get(typeId)?.name ?? typeId;
}

/** The built-ins with a source, by name (Create new > Built-in). */
export function builtinScriptRows(): { typeId: string; name: string }[] {
  return [...WITH_SOURCE].map((typeId) => ({ typeId, name: builtinName(typeId) })).sort((a, b) => a.name.localeCompare(b.name));
}

let table: Promise<(id: string) => string | undefined> | null = null;

/** Source code of built-in `typeId`, undefined when the library has none. */
export async function loadBuiltinSource(typeId: string): Promise<string | undefined> {
  table ??= import("lightweight-charts-indicators/sources").then((m) => m.builtinSource);
  return (await table)(typeId);
}
