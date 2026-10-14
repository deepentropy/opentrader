import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>([["ot:custom-intervals", JSON.stringify(["7", "100R", 5, "bad", "2D"])]]));
vi.mock("../../../data/kv", () => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  onExternalChange: () => () => {},
}));

import {
  CUSTOM_INTERVAL_TYPES,
  addCustomInterval,
  buildIntervalMenu,
  customIntervals,
  intervalMenuHas,
  isSectionFolded,
  isValidCustomInterval,
  normalizeCustomInterval,
  removeCustomInterval,
  sectionOf,
  setSectionFolded,
} from "../custom-intervals";
import {
  DEFAULT_FAVORITE_INTERVALS,
  compareIntervals,
  favoriteIntervals,
  intervalKind,
  longIntervalLabel,
  shortIntervalLabel,
  toggleFavoriteInterval,
} from "../interval-favorites";

describe("intervalKind / compareIntervals", () => {
  it("kind and multiplier; whole-hour minutes are hours", () => {
    expect(intervalKind("15")).toEqual({ kind: "", n: 15 });
    expect(intervalKind("60")).toEqual({ kind: "H", n: 1 });
    expect(intervalKind("240")).toEqual({ kind: "H", n: 4 });
    expect(intervalKind("90")).toEqual({ kind: "", n: 90 });
    expect(intervalKind("10S")).toEqual({ kind: "S", n: 10 });
    expect(intervalKind("3M")).toEqual({ kind: "M", n: 3 });
    expect(intervalKind("100T")).toEqual({ kind: "T", n: 100 });
    expect(intervalKind("D")).toEqual({ kind: "?", n: 0 });
    expect(intervalKind("1h")).toEqual({ kind: "?", n: 0 });
  });

  it("menu order: ticks, seconds, minutes, hours, days, weeks, months, ranges", () => {
    const ids = ["1M", "1R", "60", "1W", "5", "30S", "1D", "10T", "45", "120", "2D", "12M"];
    expect([...ids].sort(compareIntervals)).toEqual(["10T", "30S", "5", "45", "60", "120", "1D", "2D", "1W", "1M", "12M", "1R"]);
  });

  it("unknown ids sort last", () => {
    expect(compareIntervals("bogus", "1R")).toBeGreaterThan(0);
  });
});

describe("interval labels", () => {
  it("short header labels", () => {
    expect(shortIntervalLabel("10S")).toBe("10s");
    expect(shortIntervalLabel("1")).toBe("1m");
    expect(shortIntervalLabel("45")).toBe("45m");
    expect(shortIntervalLabel("60")).toBe("1h");
    expect(shortIntervalLabel("240")).toBe("4h");
    expect(shortIntervalLabel("90")).toBe("90m");
    expect(shortIntervalLabel("1D")).toBe("D");
    expect(shortIntervalLabel("3D")).toBe("3D");
    expect(shortIntervalLabel("1W")).toBe("W");
    expect(shortIntervalLabel("1M")).toBe("M");
    expect(shortIntervalLabel("100T")).toBe("100T");
    expect(shortIntervalLabel("xyz")).toBe("xyz");
  });

  it("long labels, singular and plural", () => {
    expect(longIntervalLabel("1")).toBe("1 minute");
    expect(longIntervalLabel("15")).toBe("15 minutes");
    expect(longIntervalLabel("60")).toBe("1 hour");
    expect(longIntervalLabel("180")).toBe("3 hours");
    expect(longIntervalLabel("90")).toBe("90 minutes");
    expect(longIntervalLabel("1S")).toBe("1 second");
    expect(longIntervalLabel("1D")).toBe("1 day");
    expect(longIntervalLabel("2W")).toBe("2 weeks");
    expect(longIntervalLabel("12M")).toBe("12 months");
    expect(longIntervalLabel("10T")).toBe("10 ticks");
    expect(longIntervalLabel("1R")).toBe("1 range");
    expect(longIntervalLabel("abc")).toBe("abc");
  });
});

describe("favourite intervals", () => {
  it("defaults, toggle on (sorted) and off, persisted", () => {
    expect(favoriteIntervals()).toEqual(DEFAULT_FAVORITE_INTERVALS);
    toggleFavoriteInterval("30");
    expect(favoriteIntervals()).toEqual(["10S", "1", "5", "15", "30", "60", "240", "1D", "1W"]);
    toggleFavoriteInterval("10S");
    expect(favoriteIntervals()).not.toContain("10S");
    expect(JSON.parse(store.get("ot:favorite-intervals")!)).toEqual(favoriteIntervals());
  });
});

describe("custom intervals", () => {
  it("limits per type", () => {
    expect(CUSTOM_INTERVAL_TYPES.map((t) => t.suffix)).toEqual(["", "H", "D", "W", "M"]);
    expect(isValidCustomInterval("1440", "")).toBe(true);
    expect(isValidCustomInterval("1441", "")).toBe(false);
    expect(isValidCustomInterval("24", "H")).toBe(true);
    expect(isValidCustomInterval("25", "H")).toBe(false);
    expect(isValidCustomInterval("365", "D")).toBe(true);
    expect(isValidCustomInterval("52", "W")).toBe(true);
    expect(isValidCustomInterval("53", "W")).toBe(false);
    expect(isValidCustomInterval("12", "M")).toBe(true);
    expect(isValidCustomInterval("13", "M")).toBe(false);
    expect(isValidCustomInterval("0", "")).toBe(false);
    expect(isValidCustomInterval("1.5", "")).toBe(false);
    expect(isValidCustomInterval("", "")).toBe(false);
    expect(isValidCustomInterval("5", "S")).toBe(false); // no seconds type
  });

  it("ids: hours become minutes", () => {
    expect(normalizeCustomInterval("7", "")).toBe("7");
    expect(normalizeCustomInterval("007", "")).toBe("7");
    expect(normalizeCustomInterval("3", "H")).toBe("180");
    expect(normalizeCustomInterval("2", "D")).toBe("2D");
    expect(normalizeCustomInterval("6", "M")).toBe("6M");
  });

  it("menu sections", () => {
    expect(sectionOf("10T")).toBe("ticks");
    expect(sectionOf("5S")).toBe("seconds");
    expect(sectionOf("7")).toBe("minutes");
    expect(sectionOf("180")).toBe("hours");
    expect(sectionOf("2D")).toBe("days");
    expect(sectionOf("3W")).toBe("days");
    expect(sectionOf("6M")).toBe("days");
    expect(sectionOf("10R")).toBe("ranges");
    expect(sectionOf("bad")).toBeNull();
  });

  it("stored list: range and invalid ids dropped", () => {
    expect(customIntervals()).toEqual(["7", "2D"]);
  });

  it("add keeps menu order and ignores duplicates; remove", () => {
    addCustomInterval("180");
    addCustomInterval("3");
    addCustomInterval("7");
    expect(customIntervals()).toEqual(["3", "7", "180", "2D"]);
    removeCustomInterval("7");
    expect(customIntervals()).toEqual(["3", "180", "2D"]);
    expect(JSON.parse(store.get("ot:custom-intervals")!)).toEqual(["3", "180", "2D"]);
  });

  it("the interval menu merges custom ids into their titled sections", () => {
    const menu = buildIntervalMenu();
    const byHeader = Object.fromEntries(menu.sections.filter((s) => s.header).map((s) => [s.header, s.items.map((i) => i.id)]));
    expect(byHeader.Minutes).toEqual(["1", "2", "3", "4", "5", "10", "15", "30", "45"]); // "3" is built in already
    expect(byHeader.Hours).toEqual(["60", "120", "180", "240"]);
    expect(byHeader.Days).toEqual(["1D", "2D", "1W", "1M", "3M", "6M", "12M"]);
    expect(byHeader.Ticks).toEqual(["1T", "10T", "100T", "1000T"]);
    // The custom rows carry the long label.
    const days = menu.sections.find((s) => s.header === "Days")!;
    expect(days.items.find((i) => i.id === "2D")!.label).toBe("2 days");
    // The "Add custom interval" button row keeps no header.
    expect(menu.sections[0].header).toBeNull();
    expect(intervalMenuHas("2D")).toBe(true);
    expect(intervalMenuHas("1D")).toBe(true);
    expect(intervalMenuHas("9D")).toBe(false);
  });

  it("folded sections persist", () => {
    expect(isSectionFolded("ticks")).toBe(false);
    setSectionFolded("ticks", true);
    expect(isSectionFolded("ticks")).toBe(true);
    expect(JSON.parse(store.get("ot:interval-menu-view-state")!)).toEqual({ ticks: true });
  });
});
