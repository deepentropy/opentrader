/*
 * Registry ids the indicator library no longer ships, with the entry that
 * replaces them. Stored charts, templates, alerts and favourites are read
 * through these helpers, so a study saved under a retired id comes back as
 * its replacement with the same settings.
 */
import { newStudyId, typeIdOf } from "./study-id";

type Retired = { id: string; inputs?: Record<string, string> };

const RETIRED: Record<string, Retired> = {
  // Library 0.13.0: `rma` was a second entry of the smoothed moving average.
  rma: { id: "smma", inputs: { len: "length" } },
};

const isRetired = (id: string): boolean => typeIdOf(id) in RETIRED;

/** Registry id that replaces a retired type id (the id itself otherwise). */
export function currentTypeId(typeId: string): string {
  return RETIRED[typeId]?.id ?? typeId;
}

/** Inputs of a retired study under the names of its replacement. */
export function currentInputs(typeId: string, inputs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const names = RETIRED[typeId]?.inputs;
  if (!inputs || !names) return inputs;
  return Object.fromEntries(Object.entries(inputs).map(([k, v]) => [names[k] ?? k, v]));
}

/** Settings record with `inputs` (pane study settings) moved to the new input names. */
function currentSettings<T>(typeId: string, settings: T): T {
  const s = settings as { inputs?: Record<string, unknown> } | undefined;
  if (!s || typeof s !== "object" || !s.inputs) return settings;
  return { ...s, inputs: currentInputs(typeId, s.inputs) } as T;
}

/**
 * Study ids of one chart with the retired ones renamed (instance ids kept
 * unique), their settings moved along, and the old -> new id map for the
 * orders that list them.
 */
export function currentStudies<T>(
  ids: string[],
  settings: Record<string, T> | undefined,
): { ids: string[]; settings: Record<string, T> | undefined; renamed: Map<string, string> } {
  const renamed = new Map<string, string>();
  if (!ids.some(isRetired)) return { ids, settings, renamed };
  const taken = ids.filter((id) => !isRetired(id));
  const out = ids.map((id) => {
    if (!isRetired(id)) return id;
    const next = newStudyId(currentTypeId(typeIdOf(id)), taken);
    taken.push(next);
    renamed.set(id, next);
    return next;
  });
  let nextSettings = settings;
  if (settings) {
    nextSettings = { ...settings };
    for (const [from, to] of renamed) {
      if (!(from in settings)) continue;
      delete nextSettings[from];
      nextSettings[to] = currentSettings(typeIdOf(from), settings[from]);
    }
  }
  return { ids: out, settings: nextSettings, renamed };
}
