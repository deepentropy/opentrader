/*
 * The interface languages, one entry each. Adding a language is one entry here and one dictionary next to this file
 * (`<id>.json`, keyed by the English text: see AGENTS.md, "Languages").
 */
import type { Dictionary } from "./translator";

/**
 * How a language writes dates and numbers. The locales are handed to Intl, the patterns hold tokens: {yyyy} {yy} the
 * year, {M} {MM} the month's number, {MMM} its short name, {d} {dd} the day, {wd} the short weekday.
 */
export type Formats = {
  /** Dates written out ("Sep 10, 2003", "November 2026", the month names of the time axis). */
  dateLocale: string;
  /** Numbers: grouping and decimal marks. */
  numberLocale: string;
  /** The chart's date label in its default format ("26 Oct '26"). */
  chartDate: string;
  /** The same with the day of the week ("Mon 26 Oct '26"). */
  chartWeekdayDate: string;
};

export type LanguageEntry = {
  /** BCP-47 tag, the dictionary's file name and the page's `lang`. */
  id: string;
  /** The language named in itself, for the language menu. */
  name: string;
  /** The dictionary (none for English, the language of the code). */
  dictionary?: () => Promise<{ default: Dictionary }>;
  /** The locale whose plural rules pick a text's form (Intl.PluralRules). */
  pluralLocale: string;
  formats: Formats;
  /** Writing direction: the page's `dir`. */
  direction: "ltr" | "rtl";
  /** Still being translated: the missing texts are reported, not a test failure, and show in English. */
  partial?: boolean;
};

export const ENGLISH: LanguageEntry = {
  id: "en",
  name: "English",
  pluralLocale: "en",
  formats: { dateLocale: "en-US", numberLocale: "en-US", chartDate: "{dd} {MMM} '{yy}", chartWeekdayDate: "{wd} {dd} {MMM} '{yy}" },
  direction: "ltr",
};

export const LANGUAGES: readonly LanguageEntry[] = [
  ENGLISH,
  {
    id: "zh-Hans",
    name: "简体中文",
    dictionary: () => import("./zh-Hans.json"),
    pluralLocale: "zh",
    // Numbers grouped as in English.
    formats: { dateLocale: "zh-CN", numberLocale: "en-US", chartDate: "{yyyy}年{M}月{d}日", chartWeekdayDate: "{yyyy}年{M}月{d}日 {wd}" },
    direction: "ltr",
  },
  {
    id: "zh-Hant",
    name: "繁體中文",
    dictionary: () => import("./zh-Hant.json"),
    pluralLocale: "zh",
    formats: { dateLocale: "zh-TW", numberLocale: "en-US", chartDate: "{yyyy}年{M}月{d}日", chartWeekdayDate: "{yyyy}年{M}月{d}日 {wd}" },
    direction: "ltr",
  },
];

export function languageEntry(id: string): LanguageEntry | undefined {
  return LANGUAGES.find((l) => l.id === id);
}
