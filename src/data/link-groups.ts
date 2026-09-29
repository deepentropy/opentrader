/*
 * Link groups — one group per link colour, spanning every tab of every
 * window. The GROUP owns the channel
 * switches and the last symbol / interval values; a tab only carries its
 * colour.
 *
 *  - A new (empty) group starts with the Symbol channel only.
 *  - A tab joining a group that has members takes the group values at once;
 *    joining an empty group makes the tab's values the group values.
 *  - Time and date-range values are not kept (stripped on save).
 *
 * Stored in kv (store file, live across windows).
 * Group membership is read from the tabs themselves (tabs.ts), so a group
 * whose last member left is simply reset on the next join.
 */
import { createSignal } from "solid-js";
import * as kv from "./kv";
import type { LinkChannels, LinkColor } from "../window/shell/tab-linking";

export type LinkGroup = {
  channels: LinkChannels;
  symbol?: string;
  interval?: string;
};

type Groups = Partial<Record<LinkColor, LinkGroup>>;

/** Default channels of a new group (symbol only). */
export const LINK_CHANNELS_DEFAULT: LinkChannels = {
  symbol: true,
  interval: false,
  time: false,
  dateRange: false,
};

const KEY = "tv:link-groups";

function load(): Groups {
  try {
    const raw = kv.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Groups;
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    /* malformed: start empty */
  }
  return {};
}

const [groups, setGroupsRaw] = createSignal<Groups>(load());
kv.onExternalChange(KEY, () => setGroupsRaw(load()));

function save(next: Groups): void {
  setGroupsRaw(next);
  kv.setItem(KEY, JSON.stringify(next));
}

/** The group of `color`, or undefined when it was never created. Reactive. */
export function linkGroup(color: LinkColor): LinkGroup | undefined {
  return groups()[color];
}

/** Channel switches of `color`'s group (defaults when absent). Reactive. */
export function groupChannels(color: LinkColor): LinkChannels {
  return groups()[color]?.channels ?? LINK_CHANNELS_DEFAULT;
}

/** Replace `color`'s group (new group on an empty join, legacy seed). */
export function setLinkGroup(color: LinkColor, group: LinkGroup): void {
  save({ ...groups(), [color]: group });
}

export function toggleGroupChannel(color: LinkColor, channel: keyof LinkChannels): void {
  const cur = groups()[color] ?? { channels: { ...LINK_CHANNELS_DEFAULT } };
  save({ ...groups(), [color]: { ...cur, channels: { ...cur.channels, [channel]: !cur.channels[channel] } } });
}

/** Record the group's latest symbol / interval (what a joining tab takes). */
export function setGroupValue(color: LinkColor, field: "symbol" | "interval", value: string): void {
  const cur = groups()[color] ?? { channels: { ...LINK_CHANNELS_DEFAULT } };
  if (cur[field] === value) return;
  save({ ...groups(), [color]: { ...cur, [field]: value } });
}
