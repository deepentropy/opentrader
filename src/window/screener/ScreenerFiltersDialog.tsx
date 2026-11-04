/*
 * The Filters dialog of a narrow screener (its "Filters" button, Shift+F; the reference app 3.5, 480 × 600):
 * the market and watchlist pills, a divider, one filter pill per row, then a footer with Add filter, Reset
 * options and Ok. Dragged by its title bar; Escape, a click outside, the close button and Ok close it. The
 * pills edit the screen as the row of pills does (./FilterPills).
 */
import { onCleanup, onMount } from "solid-js";
import { FilterPills } from "./FilterPills";

export function ScreenerFiltersDialog(props: { has: (field: string) => boolean; onClose: () => void }) {
  onMount(() => {
    // A filter's popover takes Escape first.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".scr-popover")) return;
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
  return (
    <div class="settings-backdrop" role="presentation" onMouseDown={() => props.onClose()}>
      <div
        class="settings-dialog scr-filters-dialog"
        role="dialog"
        aria-label="Filters"
        data-name="add-filter-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header class="cp3-header">
          <div class="cp3-header-title">Filters</div>
          <button type="button" aria-label="Close menu" class="cp3-close" onClick={() => props.onClose()}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" /></svg>
          </button>
        </header>
        <FilterPills has={props.has} dialog onOk={() => props.onClose()} />
      </div>
    </div>
  );
}
