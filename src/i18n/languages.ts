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
  /** The short month names of the chart and the time axis, January first, where the language's own differ from
   *  Intl's ("Janv" for "janv."). Intl's when absent. */
  shortMonths?: readonly string[];
  /** The weekday heads of a calendar, Monday first. The code's ("Mo", "Tu"…) when absent. */
  calendarWeekdays?: readonly string[];
  /**
   * The marks of the numbers the code writes in English ("−1,234.5", "103.47 M", "+5.81%"): the thousands separator
   * and the decimal sign, and the space before a K / M / B / T letter. The English text as it is when absent.
   */
  numberMarks?: { group: string; decimal: string; unitSpace: string };
  /** Between the words of a list ("Value, line"): ", " when absent. */
  listSeparator?: string;
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
  /**
   * A test language generated from the catalog when it loads (pseudo.ts), no dictionary file: in the language menu of
   * a development build only, a production build loads it from the saved choice alone.
   */
  pseudo?: boolean;
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
    formats: { dateLocale: "zh-CN", numberLocale: "en-US", chartDate: "{yyyy}年{M}月{d}日", chartWeekdayDate: "{yyyy}年{M}月{d}日 {wd}", listSeparator: "、" },
    direction: "ltr",
  },
  {
    id: "zh-Hant",
    name: "繁體中文",
    dictionary: () => import("./zh-Hant.json"),
    pluralLocale: "zh",
    formats: { dateLocale: "zh-TW", numberLocale: "en-US", chartDate: "{yyyy}年{M}月{d}日", chartWeekdayDate: "{yyyy}年{M}月{d}日 {wd}", listSeparator: "、" },
    direction: "ltr",
  },
  {
    id: "fr",
    name: "Français",
    dictionary: () => import("./fr.json"),
    pluralLocale: "fr",
    // "1 234,5" (narrow no-break spaces), "103,47 M", "+5,81%"; the chart's months capitalised without a dot.
    formats: {
      dateLocale: "fr-FR",
      numberLocale: "fr-FR",
      chartDate: "{dd} {MMM} '{yy}",
      chartWeekdayDate: "{wd} {dd} {MMM} '{yy}",
      shortMonths: ["Janv", "Févr", "Mars", "Avr", "Mai", "Juin", "Juill", "Août", "Sept", "Oct", "Nov", "Déc"],
      calendarWeekdays: ["Lu", "Ma", "Me", "Je", "Ve", "Sa", "Di"],
      numberMarks: { group: "\u202f", decimal: ",", unitSpace: "\u202f" },
    },
    direction: "ltr",
  },
  {
    // Accented, longer text between markers: what is left in English or cut shows (#289).
    id: "en-XA",
    name: "Pseudo",
    dictionary: () => import("./pseudo").then((m) => m.loadPseudoDictionary()),
    pluralLocale: "en",
    formats: ENGLISH.formats,
    direction: "ltr",
    pseudo: true,
  },
  {
    // Right to left with readable English words (pseudo-rtl.ts): panels, menus, icons and values in a mirrored page (#290).
    id: "en-XB",
    name: "English, right to left (test)",
    dictionary: () => import("./pseudo-rtl").then((m) => m.loadPseudoRtl()),
    pluralLocale: "en",
    formats: ENGLISH.formats,
    direction: "rtl",
    pseudo: true,
  },
];

/** The languages the language menu offers: the pseudo-languages in a development build only. */
export function menuLanguages(): LanguageEntry[] {
  return LANGUAGES.filter((l) => !l.pseudo || import.meta.env.DEV);
}

export function languageEntry(id: string): LanguageEntry | undefined {
  return LANGUAGES.find((l) => l.id === id);
}
