/*
 * The Filters dialog of a narrow screener (its "Filters" button, Shift+F; the reference app 3.5, 480 × 600):
 * the market and watchlist pills, a divider, one filter pill per row, then a footer with Add filter, Reset
 * options and Ok. Dragged by its title bar; Escape, a click outside, the close button and Ok close it. The
 * pills edit the screen as the row of pills does (./FilterPills).
 */
import { Dialog } from "../../components/Dialog";
import { FilterPills } from "./FilterPills";

export function ScreenerFiltersDialog(props: { has: (field: string) => boolean; onClose: () => void }) {
  return (
    <Dialog
      look="settings"
      layerClass="settings-backdrop"
      backdrop="close"
      inline
      class="settings-dialog scr-filters-dialog"
      data-name="add-filter-dialog"
      title="Filters"
      onClose={props.onClose}
      // A filter's popover takes Escape first.
      onEscape={(e) => {
        if (document.querySelector(".scr-popover")) return false;
        e.preventDefault();
        props.onClose();
      }}
    >
      <FilterPills has={props.has} dialog onOk={() => props.onClose()} />
    </Dialog>
  );
}
