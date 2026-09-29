/*
 * RightRailTabs — vertical strip on the far right of the chart that
 * switches the right-rail panel between Watchlist / Alerts / Object tree.
 *
 * Toggle: clicking the active tab clears the selection (collapses the
 * panel, leaves the strip visible).
 */
import { For, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { VISIBLE_BOTTOM_TABS, VISIBLE_TOP_TABS, type Tab } from "../../data/right-rail-tabs";

type Props = {
  active: string | null;
  setActive: (id: string | null) => void;
};

export function RightRailTabs(props: Props) {
  const select = (id: string) => {
    props.setActive(props.active === id ? null : id);
  };

  const renderTab = (t: Tab) => {
    const isActive = () => props.active === t.id;
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
        <For each={VISIBLE_TOP_TABS}>{renderTab}</For>
      </div>
      <Show when={VISIBLE_BOTTOM_TABS.length > 0}>
        <div class="right-rail-tabs-group right-rail-tabs-group-bottom">
          <For each={VISIBLE_BOTTOM_TABS}>{renderTab}</For>
        </div>
      </Show>
    </nav>
  );
}
