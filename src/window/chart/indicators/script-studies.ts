/*
 * The studies of the user's own scripts (OakScript editor) on a chart, by id. A deleted script has no source left to
 * run, so its studies go with it: off the charts, and out of whatever brings studies back (stored tabs, saved
 * layouts, templates, undo steps). A data plugin's script is another matter: it comes back with its plugin.
 */
import { scriptExists } from "../../../data/oakscript-store";
import { isPluginScriptId } from "../../../data/plugin-scripts";
import { typeIdOf } from "./study-id";

export const USER_INDICATOR_PREFIX = "user:";

/** Script of a study on the chart (an OakScript indicator "user:<id>" or
 *  strategy "strategy:user:<id>", any instance), else null. */
export function scriptIdOfStudy(studyId: string): string | null {
  const id = typeIdOf(studyId);
  if (id.startsWith(USER_INDICATOR_PREFIX)) return id.slice(USER_INDICATOR_PREFIX.length);
  if (id.startsWith("strategy:" + USER_INDICATOR_PREFIX)) return id.slice(("strategy:" + USER_INDICATOR_PREFIX).length);
  return null;
}

/** The study runs a script the user deleted. */
export function ofDeletedScript(studyId: string): boolean {
  const script = scriptIdOfStudy(studyId);
  return script !== null && !isPluginScriptId(script) && !scriptExists(script);
}

type Settings = Record<string, { inputs?: Record<string, unknown> } | undefined>;

/** The studies `gone` names, and the studies built on them (a source input "<study id>$<plot>"), of a chart saved with
 *  these settings. The sources are read from the saved inputs alone: the deleted script's entry is gone. */
export function withStudiesOn(ids: readonly string[], settings: object | undefined, gone: (id: string) => boolean): Set<string> {
  const out = new Set(ids.filter(gone));
  const built = (id: string) =>
    Object.values((settings as Settings | undefined)?.[id]?.inputs ?? {}).some((v) => {
      const source = typeof v === "string" ? /^(.+)\$\d+$/.exec(v)?.[1] : undefined;
      return source !== undefined && (out.has(source) || gone(source));
    });
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of ids) {
      if (out.has(id) || !built(id)) continue;
      out.add(id);
      grew = true;
    }
  }
  return out;
}

/** A chart's studies and settings without the studies `removed`. */
export function withoutStudies<T>(
  ids: string[],
  settings: Record<string, T> | undefined,
  removed: ReadonlySet<string>,
): { ids: string[]; settings: Record<string, T> | undefined } {
  if (removed.size === 0) return { ids, settings };
  return {
    ids: ids.filter((id) => !removed.has(id)),
    settings: settings && Object.fromEntries(Object.entries(settings).filter(([id]) => !removed.has(id))),
  };
}

/** A chart's studies without those of deleted scripts (and the ones built on them). */
export function withoutDeletedScripts<T>(ids: string[], settings: Record<string, T> | undefined) {
  return withoutStudies(ids, settings, withStudiesOn(ids, settings, ofDeletedScript));
}
