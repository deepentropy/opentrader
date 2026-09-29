/*
 * Bridge to the indicator library's registry
 * (github.com/deepentropy/lightweight-charts-indicators).  This is the single
 * source of truth for what indicators exist — the dialog lists them and the
 * chart renders them, both keyed by the registry `id`.  No hand-maintained
 * catalogue, so the list can never drift from what's actually computable.
 */
import { indicatorRegistry, type IndicatorRegistryEntry } from 'lightweight-charts-indicators';
import { getUserIndicatorEntry, isUserIndicatorId } from './user-scripts';
import { VOLUME_ENTRY } from './volume';

const byId = new Map<string, IndicatorRegistryEntry>(indicatorRegistry.map((e) => [e.id, e]));
// Local built-ins the library doesn't ship (the basic Volume study).
byId.set(VOLUME_ENTRY.id, VOLUME_ENTRY);

export function getIndicatorEntry(id: string): IndicatorRegistryEntry | undefined {
  // `user:<scriptId>` — OakScript indicators written in the editor panel.
  if (isUserIndicatorId(id)) return getUserIndicatorEntry(id);
  return byId.get(id);
}

/** A dialog row derived from a registry entry. */
export type IndicatorListRow = { id: string; name: string };

function rowsForGroup(group: 'standard' | 'community'): IndicatorListRow[] {
  return indicatorRegistry
    .filter((e) => e.group === group)
    .map((e) => ({ id: e.id, name: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Built-In → Technicals: the library's hand-optimised standard indicators,
 *  plus the local built-ins. */
export const STANDARD_ROWS: IndicatorListRow[] = [
  ...rowsForGroup('standard'),
  { id: VOLUME_ENTRY.id, name: VOLUME_ENTRY.name },
].sort((a, b) => a.name.localeCompare(b.name));

/** Community: indicators ported from public PineScript sources. */
export const COMMUNITY_ROWS: IndicatorListRow[] = rowsForGroup('community');
