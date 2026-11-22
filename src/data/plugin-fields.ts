/*
 * A data plugin's instrument values (#383, `fields` in plugins/PROTOCOL.md): circuit limits, price bands and the
 * like, shown in Symbol info and the Details panel under the plugin's name. They come with the symbol's info and change
 * with its quotes (`PluginFieldsChanged`). The desktop app only: the web build has no plugins.
 */
import { createResource, createSignal, type Accessor } from "solid-js";
import { commands, events, type PluginSymbolFields } from "../bindings";
import { numberText } from "../i18n/format";

const inApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const [revision, setRevision] = createSignal(0);
const changed = new Map<string, number>();

if (inApp) {
  void events.pluginFieldsChanged.listen(({ payload }) => {
    const s = payload.symbol.toUpperCase();
    changed.set(s, (changed.get(s) ?? 0) + 1);
    setRevision((r) => r + 1);
  });
}

/** How many times a symbol's fields changed (reactive). */
function fieldsRevision(symbol: string): number {
  revision();
  return changed.get(symbol.toUpperCase()) ?? 0;
}

/** The plugin fields of the symbol `symbol()` gives, read again when they change; null for none. */
export function pluginFields(symbol: Accessor<string | null | undefined>): Accessor<PluginSymbolFields | null> {
  const [fields] = createResource(
    () => {
      const s = symbol();
      return inApp && s ? ([s, fieldsRevision(s)] as const) : null;
    },
    async ([s]) => {
      const r = await commands.pluginSymbolFields(s);
      return { symbol: s, fields: r.status === "ok" ? r.data : null };
    },
  );
  // The last values while new ones load (a quote changed them), never another symbol's.
  return () => {
    const v = fields.latest;
    return v && v.symbol === symbol() ? v.fields : null;
  };
}

/** A field's value as shown: numbers in the language's format, with the decimals the plugin gave. */
export function fieldText(value: number | string | null): string {
  return typeof value === "number" ? numberText(value, { maximumFractionDigits: 8 }) : (value ?? "");
}
