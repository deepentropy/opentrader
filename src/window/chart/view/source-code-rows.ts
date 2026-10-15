/*
 * "Source code..." row of a study's menu (legend More, right click on its
 * plot). Reference rules (its study context menu): the row is in its own
 * section after the placement rows, with no icon, for every study that is a
 * script; disabled when the script's source cannot be read. Studies that are
 * not scripts (Volume, the profiles, compared symbols) have none.
 *
 * "About this script..." is not offered: for a built-in the reference opens
 * its own help-center article (the app has no such articles), and a user's
 * own script has no About row there either.
 */
import type { CtxNode } from "../ChartContextMenu";
import { emitAppEvent } from "../../../data/app-events";
import { OAKSCRIPT_OPEN_EVENT } from "../indicators/user-scripts";
import { editorScriptOfStudy } from "../../oakscript/editor-state";
import { sourceUnavailable } from "../../oakscript/builtin-sources";

/** The study menu's source rows for study `id` (empty when it is not a script). */
export function sourceCodeMenuRows(id: string): CtxNode[] {
  const scriptId = editorScriptOfStudy(id);
  if (!scriptId && !sourceUnavailable(id)) return [];
  return [
    {
      kind: "item",
      id: "source-code",
      label: "Source code…",
      disabled: !scriptId,
      onSelect: () => { if (scriptId) emitAppEvent(OAKSCRIPT_OPEN_EVENT, { scriptId }); },
    },
  ];
}
