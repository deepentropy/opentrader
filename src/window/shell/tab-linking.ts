/*
 * Tab linking — port of the desktop's link-channel + colour-tag model (its
 * linking-colors and tab-linking-item modules).
 *
 * "Linking" marks several tabs (across tabs AND windows) with the same colour
 * tag. The channels belong to the colour's GROUP (data/link-groups.ts), like
 * TV's Linker: `symbol` / `interval` are applied by App onto linked tabs,
 * `time` (the clicked time) and `dateRange` (visible from/to window) travel on
 * the cross-window bus (data/tab-link-bus.ts).
 */

export type LinkColor =
  | "Red"
  | "Green"
  | "Blue"
  | "Yellow"
  | "Orange"
  | "Sky Blue"
  | "Grapes Purple"
  | "Rose"
  | "Purple";

// Order, names and hexes copied verbatim from the desktop linking-colors.ts.
export const LINK_PALETTE: Array<{ color: LinkColor; backgroundColor: string }> = [
  { color: "Red", backgroundColor: "#F23645" },
  { color: "Green", backgroundColor: "#4CAF50" },
  { color: "Blue", backgroundColor: "#3179F5" },
  { color: "Yellow", backgroundColor: "#FDD835" },
  { color: "Orange", backgroundColor: "#FB8C00" },
  { color: "Sky Blue", backgroundColor: "#00BCD4" },
  { color: "Grapes Purple", backgroundColor: "#9C27B0" },
  { color: "Rose", backgroundColor: "#FF80AB" },
  { color: "Purple", backgroundColor: "#651FFF" },
];

export function linkColorHex(color: LinkColor): string {
  return LINK_PALETTE.find((p) => p.color === color)?.backgroundColor ?? "#3179F5";
}

export type LinkChannel = "symbol" | "interval" | "time" | "dateRange";

export type LinkChannels = Record<LinkChannel, boolean>;

/** What a tab stores: its colour only. The channels live in the group. */
export type TabLink = {
  color: LinkColor;
};

/** A tab's colour plus its group's channels (what the tab menu shows). */
export type TabLinkingState = {
  color: LinkColor;
  channels: LinkChannels;
};
