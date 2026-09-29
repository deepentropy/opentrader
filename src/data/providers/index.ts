/*
 * Active frontend data-provider presentation adapter.
 *
 * The datafeed facade and UI import vendor-specific presentation (exchange-name
 * normalization, default exchange, symbol-search mapping, type-filter options)
 * from here, never from a vendor module directly. The active adapter is selected
 * to match the backend's chosen provider: `syncProvider()` asks the backend
 * (`get_data_provider`, driven by the DATA_PROVIDER env) and switches the active
 * adapter to the matching registry entry. This mirrors the backend's
 * `provider::build` so the two halves can never silently drift.
 *
 * The exported hooks delegate to the active adapter (read at call time), so once
 * `syncProvider()` resolves, every consumer follows the backend's choice with no
 * re-import. Until it resolves, the bundled default ("massive") is used.
 */
import { commands } from "../../bindings";
import type { SymbolSearchResult } from "../../bindings";
import type { SymbolRow, TypeFilter } from "../symbol-search";
import { massive } from "./massive";

/** The vendor-specific presentation an adapter must provide. */
export interface FrontendProvider {
  /** Matches the backend `DataProvider::name()` and the DATA_PROVIDER value. */
  name: string;
  /** Exchange for bare tickers with no "EXCHANGE:" prefix. */
  defaultExchange: string;
  /** Normalize a primary-exchange code to a display name. */
  exchangeName(code: string | null | undefined): string;
  /** Map one raw `search_tickers` result into a dialog row. */
  searchResultToRow(r: SymbolSearchResult): SymbolRow;
  /** "All types" dropdown options for the symbol-search filter chip. */
  typeFilters: TypeFilter[];
}

/** Frontend adapters keyed by provider name. Add a sibling adapter + entry here
 *  when the backend gains a new provider. */
const REGISTRY: Record<string, FrontendProvider> = { massive };

/** Currently active adapter — the bundled default until `syncProvider()` runs. */
let active: FrontendProvider = massive;

/** The active adapter object (use when you need the whole adapter). */
export function activeProvider(): FrontendProvider {
  return active;
}

// Hooks delegate to `active` (resolved at call time) so consumers follow the
// backend's choice once syncProvider() completes. Functions stay functions;
// the two value hooks are exposed as accessors for the same reason.
export const exchangeName = (code: string | null | undefined): string => active.exchangeName(code);
export const searchResultToRow = (r: SymbolSearchResult): SymbolRow => active.searchResultToRow(r);
export const defaultExchange = (): string => active.defaultExchange;
export const typeFilters = (): TypeFilter[] => active.typeFilters;

/** Select the adapter matching the backend's active provider. Best-effort: when
 *  the backend reports a provider we have no adapter for (or we're running
 *  outside Tauri), we warn and keep the current adapter. */
export async function syncProvider(): Promise<void> {
  try {
    const name = await commands.getDataProvider();
    const next = REGISTRY[name];
    if (!next) {
      console.warn(
        `[providers] backend provider "${name}" has no frontend adapter; keeping "${active.name}" presentation`,
      );
      return;
    }
    active = next;
  } catch {
    // No Tauri backend (browser/offline dev) — keep the bundled default.
  }
}

// Kick off selection at module load so the active adapter is set before the user
// interacts. Fire-and-forget: hooks read `active` at call time, so any work that
// runs before this resolves just uses the default.
void syncProvider();
