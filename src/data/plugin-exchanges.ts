/* The exchanges the connected data plugins serve now. */
import { commands, type PluginInfo } from "../bindings";

/** The exchanges (upper case) of `plugins`: enabled and connected data plugins whose chart data is on. */
export function exchangesOf(plugins: readonly PluginInfo[]): Set<string> {
  const out = new Set<string>();
  for (const p of plugins) {
    if (!p.enabled || !p.connected || !p.manifest.provides.includes("datafeed") || (p.off ?? []).includes("datafeed")) continue;
    for (const e of [p.manifest.exchange, ...(p.manifest.exchanges ?? [])]) if (e) out.add(e.toUpperCase());
  }
  return out;
}

export async function servedExchanges(): Promise<ReadonlySet<string>> {
  return exchangesOf((await commands.pluginsStatus()).plugins);
}
