/*
 * A data plugin changed its symbols' events (#382, `data.eventsChanged` in plugins/PROTOCOL.md): the charts and the
 * scripts that show those symbols read them again.
 */
import { createSignal } from "solid-js";
import { events, type PluginEventsChanged } from "../bindings";

type Affects = (symbol: string) => boolean;

const [revision, setRevision] = createSignal(0);
const bySymbol = new Map<string, number>();
const byExchange = new Map<string, number>();
const listeners = new Set<(affects: Affects) => void>();

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

function affects(e: PluginEventsChanged): Affects {
  const symbols = e.symbols ? new Set(e.symbols.map((s) => s.toUpperCase())) : null;
  const exchanges = new Set(e.exchanges.map((x) => x.toUpperCase()));
  return (symbol) => {
    const s = symbol.trim().toUpperCase();
    return symbols ? symbols.has(s) : exchanges.has(s.split(":")[0]);
  };
}

if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  void events.pluginEventsChanged.listen(({ payload }) => {
    if (payload.symbols) for (const s of payload.symbols) bump(bySymbol, s.toUpperCase());
    else for (const x of payload.exchanges) bump(byExchange, x.toUpperCase());
    setRevision((r) => r + 1);
    const a = affects(payload);
    for (const fn of listeners) fn(a);
  });
}

/** How many times `symbol`'s events changed (reactive): a chart reads them again when it moves. */
export function eventsRevision(symbol: string): number {
  revision();
  const s = symbol.trim().toUpperCase();
  return (bySymbol.get(s) ?? 0) + (byExchange.get(s.split(":")[0]) ?? 0);
}

/** Call `fn` whenever a plugin changes events, with a test of the symbols concerned; returns the unsubscribe. */
export function onPluginEventsChanged(fn: (affects: Affects) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
