/*
 * First module of an embedded chart's page (imported first by src/index.tsx).
 *
 * The embed runs on the web version's own address, so it shares the storage of
 * a visitor who also uses the web version: their charts, layouts, watchlists
 * and settings. The embed must neither show nor change them, so the page's
 * storage is swapped for one kept in memory before any store reads it, seeded
 * with the settings the embed chose (theme, language, timezone, drawing
 * toolbar). What the visitor changes in the chart is forgotten with the page.
 *
 * The page's own colours and font (#339) replace the theme's: set on <html>,
 * they win over the theme rules, and the chart reads its colours from there.
 */
import { embedConfig, type EmbedColors, type EmbedConfig } from "./config";
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

/** "r, g, b" of a CSS colour: hex and rgb() read here, others through the browser (none in tests). */
function rgbOf(color: string): [number, number, number] | null {
  let c = color.trim();
  if (!/^(#|rgb)/i.test(c) && typeof document !== "undefined") {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      c = String(ctx.fillStyle);
    }
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/** The standard theme that suits a background: dark under a dark colour, light otherwise. */
export function themeForBackground(color: string): "light" | "dark" | undefined {
  const rgb = rgbOf(color);
  if (!rgb) return undefined;
  const [r, g, b] = rgb.map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? "dark" : "light";
}

/** Stored values that make the app start the way the embed asks. A page that
 *  sets its background and no theme gets the theme that suits it, so the app's
 *  other colours (hover, pressed, menus) read on it. */
export function embedSeedItems(c: EmbedConfig): Record<string, string> {
  const items: Record<string, string> = {};
  const theme = c.theme ?? (c.colors.background ? themeForBackground(c.colors.background) : undefined);
  if (theme) items["ot:theme"] = theme;
  if (c.locale) items["ot:language"] = c.locale;
  if (c.timezone && c.timezone.toLowerCase() !== "exchange") {
    const known = TIMEZONES.find((t) => t.iana === c.timezone && t.label !== "Exchange");
    items["ot:timezone"] = JSON.stringify({ label: known?.label ?? c.timezone, iana: c.timezone });
  }
  items["ot:drawing-panel-visible"] = c.drawingToolbar ? "1" : "0";
  return items;
}

/** The app's colour properties each page colour stands for. */
const COLOR_VARS: Record<keyof EmbedColors, string[]> = {
  background: ["--ot-chart-bg", "--color-bg-primary", "--color-pane-bg", "--color-body-bg", "--color-header-bg", "--color-container-fill-secondary-neutral-thin"],
  text: ["--ot-chart-text", "--color-text-primary", "--color-main-text", "--color-toolbar-button-text"],
  accent: ["--color-brand", "--color-link"],
  up: ["--ot-chart-up", "--color-success"],
  down: ["--ot-chart-down", "--color-danger"],
  border: ["--color-divider", "--color-widget-border", "--ot-chart-grid"],
  font: ["--font-family-base"],
};

/** The CSS properties a page's colours set on <html>. */
export function embedColorProperties(colors: EmbedColors): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors) as [keyof EmbedColors, string][]) for (const name of COLOR_VARS[k]) out[name] = v;
  return out;
}

const config = embedConfig();
if (config) {
  const storage = new MemoryStorage();
  for (const [k, v] of Object.entries(embedSeedItems(config))) storage.setItem(k, v);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  const root = document.documentElement;
  root.classList.add("ot-embed");
  if (config.widget !== "chart") root.classList.add("ot-embed-widget");
  if (config.hideLegend) root.classList.add("ot-embed-no-legend");
  for (const [name, value] of Object.entries(embedColorProperties(config.colors))) root.style.setProperty(name, value);
}
