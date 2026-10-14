/*
 * Tab syncing (colour link) on this window's side: a tab joins / leaves a
 * colour group (tab right-click → Tab syncing), a focused-tab symbol or
 * interval change goes to the linked tabs of this window and of the others
 * (tab-link-bus), and an inbound value lands on the linked tabs here. A
 * linked value lands on the tab's ACTIVE pane, and the tab's own layout
 * Symbol / Interval sync then spreads it. Created once by App.
 */
import { createEffect, onCleanup, onMount } from "solid-js";
import { activePaneOf, linkedTabCountInOtherWindows, type TabChart } from "./tabs";
import type { LinkChannel, LinkColor } from "./tab-linking";
import type { AppTabs } from "./app-tabs";
import { groupChannels, linkGroup, LINK_CHANNELS_DEFAULT, setGroupValue, setLinkGroup, toggleGroupChannel } from "../../data/link-groups";
import { initLinkBus, onLinkChannelData, postIntervalLink, postSymbolLink, setActiveLink } from "../../data/tab-link-bus";
import { isSupportedResolution } from "../../data/datafeed";

export function createTabLinkSync(t: Pick<AppTabs, "tabs" | "setTabs" | "activeTab" | "activeTabId">, windowLabel: string) {
  const { tabs, setTabs, activeTab, activeTabId } = t;

  function withLinkedValue(tab: TabChart, field: "symbol" | "interval", value: string): TabChart {
    const spread = tab.sync[field];
    return {
      ...tab,
      // The tab's layout sync spreads it within the focused chart's group.
      panes: tab.panes.map((p, idx) => (idx === tab.activePane || (spread && p.linkGroup === tab.panes[tab.activePane]?.linkGroup) ? { ...p, [field]: value } : p)),
    };
  }
  // Mirror a value onto every tab in THIS window linked to `color` (optionally
  // skipping the source tab). The sender checked the group's channel.
  function applyLinkChannel(color: LinkColor, field: "symbol" | "interval", value: string, exceptId?: string) {
    setTabs(
      tabs().map((x) => (x.id === exceptId || x.link?.color !== color ? x : withLinkedValue(x, field, value))),
    );
  }
  // Propagate a focused-tab change to linked tabs (this window's others + every
  // other window via the bus), and record it as the group value.
  function broadcastLink(field: "symbol" | "interval", value: string) {
    const link = activeTab().link;
    if (!link || !groupChannels(link.color)[field]) return;
    setGroupValue(link.color, field, value);
    applyLinkChannel(link.color, field, value, activeTabId());
    if (field === "symbol") postSymbolLink(link.color, value);
    else postIntervalLink(link.color, value);
  }

  // Link tag mutators (driven by the tab right-click → Tab syncing widget).
  // Linker join: a tab joining a group with members takes the group values;
  // joining an empty group starts it (Symbol channel only) with the tab's values.
  const linkTab = (id: string, color: LinkColor) => {
    const tab = tabs().find((x) => x.id === id);
    if (!tab) return;
    const members =
      tabs().filter((x) => x.id !== id && x.link?.color === color).length +
      linkedTabCountInOtherWindows(color, windowLabel);
    const group = linkGroup(color);
    let next: TabChart = { ...tab, link: { color } };
    if (members === 0 || !group) {
      const pane = activePaneOf(tab);
      setLinkGroup(color, { channels: { ...LINK_CHANNELS_DEFAULT }, symbol: pane.symbol, interval: pane.interval });
    } else {
      if (group.channels.symbol && group.symbol) next = withLinkedValue(next, "symbol", group.symbol);
      if (group.channels.interval && group.interval && isSupportedResolution(group.interval))
        next = withLinkedValue(next, "interval", group.interval);
    }
    setTabs(tabs().map((x) => (x.id === id ? next : x)));
  };
  const unlinkTab = (id: string) =>
    setTabs(tabs().map((x) => (x.id === id ? { ...x, link: undefined } : x)));
  // Channels belong to the colour's group, shared by every member tab.
  const toggleLinkChannel = (id: string, channel: LinkChannel) => {
    const color = tabs().find((x) => x.id === id)?.link?.color;
    if (color) toggleGroupChannel(color, channel);
  };

  // Keep the bus aware of the focused tab's link and its group channels, and
  // apply inbound symbol/interval syncs from other windows.
  createEffect(() => {
    const link = activeTab().link;
    setActiveLink(link ? { color: link.color, channels: groupChannels(link.color) } : null);
  });
  onMount(() => {
    const disposeBus = initLinkBus({
      tabs: () => tabs().map((x) => ({ id: x.id, color: x.link?.color })),
      activeId: activeTabId,
    });
    const unsub = onLinkChannelData((m) => applyLinkChannel(m.color, m.kind, m.value));
    onCleanup(() => {
      disposeBus();
      unsub();
    });
  });

  return { broadcastLink, linkTab, unlinkTab, toggleLinkChannel };
}
