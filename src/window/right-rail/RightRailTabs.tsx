/*
 * RightRailTabs — vertical strip on the far right of the chart that
 * switches the right-rail panel between Watchlist / Alerts / Object tree.
 *
 * Toggle: clicking the active tab clears the selection (collapses the
 * panel, leaves the strip visible).
 */
import { For } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { TOP_TABS, type Tab } from "../../data/right-rail-tabs";

type Props = {
  active: string | null;
  setActive: (id: string | null) => void;
  /** Buttons shown pressed without being the active panel tab (the
   *  screener split view while it is open). */
  pressed?: (id: string) => boolean;
};

export function RightRailTabs(props: Props) {
  const select = (id: string) => {
    props.setActive(props.active === id ? null : id);
  };

  const renderTab = (t: Tab) => {
    const isActive = () => props.active === t.id || !!props.pressed?.(t.id);
    return (
      <Tooltip text={t.label} side="left">
        <button
          type="button"
          data-name={t.id}
          aria-label={t.label}
          aria-pressed={isActive()}
          class={"ot-toolbar-button right-rail-tab" + (isActive() ? " active" : "")}
          onClick={() => select(t.id)}
        >
          {t.iconName && <Icon name={t.iconName} size={44} />}
        </button>
      </Tooltip>
    );
  };

  return (
    <nav class="right-rail-tabs" aria-label="Right rail">
      <div class="right-rail-tabs-group">
        <For each={TOP_TABS}>{renderTab}</For>
      </div>
    </nav>
  );
}
