/*
 * Provider capabilities — what the backend's active data provider can serve
 * (TradingView `onReady` equivalent), read instead of hardcoded.
 *
 * A Solid signal, so gates that read it (the interval picker's greyed rows)
 * update when the backend pushes a change: the `provider-capabilities` event
 * fires when the background entitlement probe finishes.
 * `null` until the first `get_provider_capabilities` reply (or outside Tauri);
 * the gates then fall back to the datafeed's own tables.
 */
import { createSignal } from "solid-js";
import { commands, events, type ProviderCapabilities } from "../../bindings";

const [caps, setCaps] = createSignal<ProviderCapabilities | null>(null);

/** Current capabilities of the active provider (reactive), or null. */
export const providerCapabilities = caps;

/** Bar family of a resolution check. `weekMonth` = 1W/1M built from daily. */
export type BarKind = "second" | "minute" | "day" | "weekMonth";

/** True when the provider serves `kind` bars at multiplier `mult` (ignored
 *  for the daily kinds). True while capabilities are unknown. */
export function providerServes(kind: BarKind, mult = 1): boolean {
  const c = caps();
  if (!c) return true;
  const r = c.resolutions;
  switch (kind) {
    case "second":
      return r.seconds.includes(mult);
    case "minute":
      return r.minutes.includes(mult);
    case "day":
      return r.daily;
    case "weekMonth":
      return r.daily && r.weeklyMonthlyFromDaily;
  }
}

async function sync(): Promise<void> {
  try {
    // Listen first so a change emitted during the initial fetch is not lost;
    // an event is always newer than the fetch reply, so it wins.
    let pushed = false;
    await events.providerCapabilities.listen((e) => {
      pushed = true;
      setCaps(e.payload);
    });
    const initial = await commands.getProviderCapabilities();
    if (!pushed) setCaps(initial);
  } catch {
    // No Tauri backend (browser/offline dev): keep null, gates fall back.
  }
}

void sync();
