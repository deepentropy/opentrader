/*
 * First module of an embedded chart's page (imported first by src/index.tsx).
 *
 * The embed runs on the web version's own address, so it shares the storage of
 * a visitor who also uses the web version: their charts, layouts, watchlists
 * and settings. The embed must neither show nor change them, so the page's
 * storage is swapped for one kept in memory before any store reads it, seeded
 * with the settings the embed chose (theme, language, timezone, drawing
 * toolbar). What the visitor changes in the chart is forgotten with the page.
 */
import { embedConfig, type EmbedConfig } from "./config";
import { TIMEZONES } from "../data/timezones";

/** A Storage kept in memory. */
export class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  get length(): number {
    return this.#items.size;
  }
  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
  clear(): void {
    this.#items.clear();
  }
}

/** Stored values that make the app start the way the embed asks. */
export function embedSeedItems(c: EmbedConfig): Record<string, string> {
  const items: Record<string, string> = {};
  if (c.theme) items["ot:theme"] = c.theme;
  if (c.locale) items["ot:language"] = c.locale;
  if (c.timezone && c.timezone.toLowerCase() !== "exchange") {
    const known = TIMEZONES.find((t) => t.iana === c.timezone && t.label !== "Exchange");
    items["ot:timezone"] = JSON.stringify({ label: known?.label ?? c.timezone, iana: c.timezone });
  }
  items["ot:drawing-panel-visible"] = c.drawingToolbar ? "1" : "0";
  return items;
}

const config = embedConfig();
if (config) {
  const storage = new MemoryStorage();
  for (const [k, v] of Object.entries(embedSeedItems(config))) storage.setItem(k, v);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  document.documentElement.classList.add("ot-embed");
  if (config.hideLegend) document.documentElement.classList.add("ot-embed-no-legend");
}
