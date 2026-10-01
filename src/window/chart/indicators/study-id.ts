/*
 * Study instance ids. One study type (registry id: "rsi", "user:<scriptId>",
 * "strategy:<key>") can be on a chart several times, each instance with its
 * own settings. The first instance keeps the type id and the next ones get
 * "#2", "#3"…, so layouts saved before instances existed keep their ids.
 */

const INSTANCE_SUFFIX = /#\d+$/;

/** Registry id of a study instance id. */
export const typeIdOf = (id: string): string => id.replace(INSTANCE_SUFFIX, "");

/** A new instance id of `typeId`, not in `taken`. */
export function newStudyId(typeId: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(typeId)) return typeId;
  for (let n = 2; ; n++) {
    const id = `${typeId}#${n}`;
    if (!used.has(id)) return id;
  }
}
