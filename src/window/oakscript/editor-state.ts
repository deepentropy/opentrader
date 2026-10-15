/*
 * Which script the OakScript editor shows while it is open (null = closed):
 * a stored script id or a built-in `builtin:<registry id>`. The study legends
 * read it for their "Opened in OakScript Editor" status.
 */
import { createSignal } from "solid-js";
import { scriptIdOfStudy } from "../chart/indicators/user-scripts";
import { builtinScriptId, builtinWithSource } from "./builtin-sources";

const [openedScript, setOpenedScript] = createSignal<string | null>(null);
export { openedScript, setOpenedScript };

/** Editor script id of a study's source (its stored script, or the built-in with a source), else null. */
export function editorScriptOfStudy(studyId: string): string | null {
  const own = scriptIdOfStudy(studyId);
  if (own) return own;
  const builtin = builtinWithSource(studyId);
  return builtin ? builtinScriptId(builtin) : null;
}

/** The study's source is the script open in the editor. */
export function isOpenedInEditor(studyId: string): boolean {
  const open = openedScript();
  return open !== null && editorScriptOfStudy(studyId) === open;
}
