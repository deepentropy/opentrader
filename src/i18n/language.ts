/*
 * The interface language: a global, persisted choice. A change restarts the page, every window together (the text is
 * translated as it appears, English text can't be brought back in place). The languages are listed in languages.ts.
 */
import * as kv from "../data/kv";
import { libraryMonthRule } from "./format";
import { ENGLISH, LANGUAGES, languageEntry, type LanguageEntry } from "./languages";
import { observePage, setDictionary } from "./translator";

const STORAGE_KEY = "ot:language";

function current(): LanguageEntry {
  return languageEntry(kv.getItem(STORAGE_KEY) ?? "") ?? ENGLISH;
}

export function currentLanguage(): string {
  return current().id;
}

export function currentLanguageLabel(): string {
  return current().name;
}

export { LANGUAGES };

export async function setLanguage(id: string): Promise<void> {
  if (id === currentLanguage()) return;
  kv.setItem(STORAGE_KEY, id);
  await kv.flushKv();
  window.location.reload();
}

/** At startup, before the app renders: loads the dictionary and starts translating. */
export async function startTranslation(): Promise<void> {
  // Another window changed the language.
  kv.onExternalChange(STORAGE_KEY, () => window.location.reload());
  const language = current();
  document.documentElement.dir = language.direction;
  if (!language.dictionary) return;
  document.documentElement.lang = language.id;
  const { default: dictionary } = await language.dictionary();
  setDictionary(dictionary, [libraryMonthRule(language.formats.dateLocale)], language.pluralLocale, language.formats);
  observePage();
}
