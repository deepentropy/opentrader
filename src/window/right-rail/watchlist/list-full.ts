/*
 * The warning shown when a change would take a watchlist past its size limit (#358): the same for every way of
 * adding rows (upload, Add symbol, "Add to watchlist", a new section, a new or copied list), with its own text for
 * flags, which fill the colour lists. Each window with a dialog host registers it (onListFull).
 */
import { showNotice } from "../../../components/Dialogs";
import { MAX_LIST_ITEMS, type ListFullKind } from "../../../data/watchlist-limit";
import { formatted, translateWith } from "../../../i18n/translator";
import { numberText } from "../../../i18n/format";

export function warnListFull(kind: ListFullKind = "list"): void {
  if (kind === "flags") {
    showNotice({ title: "Too many flagged symbols", text: formatted(translateWith("A colour list holds at most {0} symbols.", numberText(MAX_LIST_ITEMS))) });
    return;
  }
  showNotice({ title: "Too many symbols", text: formatted(translateWith("A watchlist holds at most {0} symbols and sections.", numberText(MAX_LIST_ITEMS))) });
}
