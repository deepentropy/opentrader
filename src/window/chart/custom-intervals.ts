/*
 * Custom intervals — the ids added with the interval menu's "Add custom
 * interval…" dialog. A global, persisted list (kv `ot:custom-intervals`)
 * shown in the interval menu next to the built-in rows, each removable.
 *
 * Ids use the interval menu's form: minutes "7", hours in minutes ("180" =
 * 3 hours), "2D", "3W", "6M", ranges "50R". The type limits, the "already
 * exists" rule and the section order are the reference app's.
 */
import { createSignal } from "solid-js";
import * as kv from "../../data/kv";
import { HEADER_MENUS, type HeaderMenuDef } from "../header/header-menus/registry";
import { compareIntervals, intervalKind, longIntervalLabel } from "./interval-favorites";

const STORAGE_KEY = "ot:custom-intervals";

/** Dialog types: suffix → label, in the dialog's order. */
export const CUSTOM_INTERVAL_TYPES: { suffix: string; label: string }[] = [
  { suffix: "", label: "minutes" },
  { suffix: "H", label: "hours" },
  { suffix: "D", label: "days" },
  { suffix: "W", label: "weeks" },
  { suffix: "M", label: "months" },
  { suffix: "R", label: "range" },
];

/** Largest multiplier per type suffix. */
const MAX: Record<string, number> = { "": 1440, H: 24, D: 365, W: 52, M: 12, R: 1e6 };

/** True when `value` (digits) is within the type's limit. */
export function isValidCustomInterval(value: string, suffix: string): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= (MAX[suffix] ?? 0);
}

/** Interval id of `value` + type suffix: hours become minutes. */
export function normalizeCustomInterval(value: string, suffix: string): string {
  const n = Number(value);
  if (suffix === "") return String(n);
  if (suffix === "H") return String(n * 60);
  return `${n}${suffix}`;
}

/** Menu section of an interval id (the reference app's categories). */
export type IntervalSection = "ticks" | "seconds" | "minutes" | "hours" | "days" | "ranges";
export function sectionOf(id: string): IntervalSection | null {
  const { kind } = intervalKind(id);
  switch (kind) {
    case "T": return "ticks";
    case "S": return "seconds";
    case "": return "minutes";
    case "H": return "hours";
    case "D": case "W": case "M": return "days";
    case "R": return "ranges";
  }
  return null;
}

function load(): string[] {
  try {
    const raw = kv.getItem(STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && sectionOf(x) !== null) : [];
  } catch {
    return [];
  }
}

const [list, setList] = createSignal<string[]>(load());
kv.onExternalChange(STORAGE_KEY, () => setList(load()));

function save(next: string[]): void {
  setList(next);
  kv.setItem(STORAGE_KEY, JSON.stringify(next));
}

/** The custom interval ids, in menu order. Reactive. */
export function customIntervals(): string[] {
  return list();
}

export function addCustomInterval(id: string): void {
  if (list().includes(id)) return;
  save([...list(), id].sort(compareIntervals));
}

export function removeCustomInterval(id: string): void {
  save(list().filter((x) => x !== id));
}

/** The last added id: its row flashes and scrolls into view the next time
 *  the interval menu shows it. Cleared when the menu closes. */
export const [lastAddedInterval, setLastAddedInterval] = createSignal<string | null>(null);

/** Section titles of the interval menu (day, week and month rows are under
 *  "Days"). */
export const SECTION_TITLES: Record<IntervalSection, string> = {
  ticks: "Ticks",
  seconds: "Seconds",
  minutes: "Minutes",
  hours: "Hours",
  days: "Days",
  ranges: "Ranges",
};

/** Folded sections of the interval menu (kv `ot:interval-menu-view-state`,
 *  true = folded; all open by default). */
const VIEW_KEY = "ot:interval-menu-view-state";
function loadView(): Partial<Record<IntervalSection, boolean>> {
  try {
    const v = JSON.parse(kv.getItem(VIEW_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Partial<Record<IntervalSection, boolean>>) : {};
  } catch {
    return {};
  }
}
const [view, setView] = createSignal(loadView());
kv.onExternalChange(VIEW_KEY, () => setView(loadView()));

export function isSectionFolded(s: IntervalSection): boolean {
  return view()[s] ?? false;
}

export function setSectionFolded(s: IntervalSection, folded: boolean): void {
  const next = { ...view(), [s]: folded };
  setView(next);
  kv.setItem(VIEW_KEY, JSON.stringify(next));
}

/** The interval menu: the registry rows plus the custom ids, each in its
 *  section (minutes, hours, days, …) in menu order, every section titled. */
export function buildIntervalMenu(): HeaderMenuDef {
  const base = HEADER_MENUS["chart-interval"];
  const custom = list();
  return {
    ...base,
    sections: base.sections.map((s) => {
      const kind = s.items[0] && !s.items[0].iconName ? sectionOf(s.items[0].id) : null;
      if (!kind) return s;
      const extra = custom.filter((id) => sectionOf(id) === kind && !s.items.some((r) => r.id === id));
      const rows = extra.length
        ? [...s.items, ...extra.map((id) => ({ id, label: longIntervalLabel(id), iconName: null }))].sort((a, b) =>
            compareIntervals(a.id, b.id),
          )
        : s.items;
      return { ...s, header: SECTION_TITLES[kind], items: rows };
    }),
  };
}

/** True when `id` is a row of the interval menu (built-in or custom). */
export function intervalMenuHas(id: string): boolean {
  return list().includes(id) || HEADER_MENUS["chart-interval"].sections.some((s) => s.items.some((r) => r.id === id));
}
