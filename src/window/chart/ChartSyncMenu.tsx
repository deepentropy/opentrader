/*
 * Legend "Symbol/interval chart syncing" menu (the reference app's layout
 * chart sync menu): a "Chart syncing" title and one row of the five group
 * icons. A click puts the chart in that group; the chart's own group again
 * takes it out. Opens under the legend button.
 */
import { For } from "solid-js";
import { Portal } from "solid-js/web";
import { createPopover } from "../../components/popover";

/** The syncing groups (icon, label), index = the group number. */
export const SYNC_GROUPS: { icon: string; label: string }[] = [
  { icon: "🔶", label: "Chart syncing with rhomb icon" },
  { icon: "🍀", label: "Chart syncing with leaf icon" },
  { icon: "💧", label: "Chart syncing with drop icon" },
  { icon: "❤️", label: "Chart syncing with heart icon" },
  { icon: "💩", label: "Chart syncing with poo icon" },
];

export function ChartSyncMenu(props: {
  anchor: DOMRect;
  group: number | undefined;
  onPick: (group: number | undefined) => void;
  onClose: () => void;
}) {
  const root = createPopover(undefined, {
    onClose: props.onClose,
    placement: false,
    press: "mousedown",
    on: { target: "document", capture: true },
    keys: { target: "document", capture: false },
    escape: "pass",
  });
  return (
    <Portal>
      <div
        ref={root}
        class="ot-chart-ctx-menu ot-chart-sync-menu"
        role="menu"
        style={{ left: `${props.anchor.left}px`, top: `${props.anchor.bottom}px` }}
      >
        <div class="ot-chart-sync-title">Chart syncing</div>
        <div class="ot-chart-sync-row">
          <For each={SYNC_GROUPS}>
            {(g, i) => (
              <button
                type="button"
                class="ot-chart-sync-item"
                classList={{ "is-active": props.group === i() }}
                aria-label={g.label}
                aria-pressed={props.group === i()}
                onClick={() => {
                  props.onPick(props.group === i() ? undefined : i());
                  props.onClose();
                }}
              >
                <span class="ot-chart-sync-emoji" aria-hidden="true">{g.icon}</span>
              </button>
            )}
          </For>
        </div>
      </div>
    </Portal>
  );
}
