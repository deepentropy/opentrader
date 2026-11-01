/*
 * The interface language: a global, persisted choice. A change restarts the page, every window together (the text is
 * translated as it appears, English text can't be brought back in place).
 */
import * as kv from "../data/kv";
import { observePage, setDictionary, type Dictionary } from "./translator";

const STORAGE_KEY = "ot:language";

export type LanguageId = "en" | "zh-Hans" | "zh-Hant";

/** The languages, each named in its own language. */
export const LANGUAGES: { id: LanguageId; label: string }[] = [
  { id: "en", label: "English" },
  { id: "zh-Hans", label: "简体中文" },
  { id: "zh-Hant", label: "繁體中文" },
];

const DICTIONARIES: Record<Exclude<LanguageId, "en">, () => Promise<{ default: Dictionary }>> = {
  "zh-Hans": () => import("./zh-Hans.json"),
  "zh-Hant": () => import("./zh-Hant.json"),
};

export function currentLanguage(): LanguageId {
  const saved = kv.getItem(STORAGE_KEY);
  return LANGUAGES.some((l) => l.id === saved) ? (saved as LanguageId) : "en";
}

export function currentLanguageLabel(): string {
  const id = currentLanguage();
  return LANGUAGES.find((l) => l.id === id)!.label;
}

export async function setLanguage(id: LanguageId): Promise<void> {
  if (id === currentLanguage()) return;
  kv.setItem(STORAGE_KEY, id);
  await kv.flushKv();
  window.location.reload();
}

/** At startup, before the app renders: loads the dictionary and starts translating. */
export async function startTranslation(): Promise<void> {
  // Another window changed the language.
  kv.onExternalChange(STORAGE_KEY, () => window.location.reload());
  const id = currentLanguage();
  if (id === "en") return;
  document.documentElement.lang = id;
  const { default: dictionary } = await DICTIONARIES[id]();
  setDictionary(dictionary);
  observePage();
}
