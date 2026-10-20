/*
 * Bridge to the indicator library's registry
 * (github.com/deepentropy/lightweight-charts-indicators).  This is the single
 * source of truth for what indicators exist — the dialog lists them and the
 * chart renders them, both keyed by the registry `id`.  No hand-maintained
 * catalogue, so the list can never drift from what's actually computable.
 */
import { indicatorRegistry, type IndicatorRegistryEntry } from 'lightweight-charts-indicators';
import { getUserIndicatorEntry, isUserIndicatorId } from './user-scripts';
import { getStrategyEntry, isStrategyId } from './strategy-entries';
import { VOLUME_ENTRY } from './volume';
import { VBP_ENTRIES } from '../profiles/vbp-studies';
import { TPO_ENTRIES } from '../profiles/tpo';
import { typeIdOf } from './study-id';
import { getFundamentalEntry, isFundamentalId } from './fundamental-entry';

const byId = new Map<string, IndicatorRegistryEntry>(indicatorRegistry.map((e) => [e.id, e]));
// Local built-ins the library doesn't ship (the basic Volume study).
byId.set(VOLUME_ENTRY.id, VOLUME_ENTRY);
// Volume profile studies (Technicals > Profiles).
for (const e of [...VBP_ENTRIES, ...TPO_ENTRIES]) byId.set(e.id, e);

export function getIndicatorEntry(studyId: string): IndicatorRegistryEntry | undefined {
  // A study instance ("rsi#2") resolves to its type's entry.
  const id = typeIdOf(studyId);
  // `user:<scriptId>` — OakScript indicators written in the editor panel.
  if (isUserIndicatorId(id)) return getUserIndicatorEntry(id);
  // `strategy:<key>` — backtester strategy ports (Strategy Tester).
  if (isStrategyId(id)) return getStrategyEntry(id);
  // `fund:<metric>[:<period>]` — Fundamentals metrics.
  if (isFundamentalId(id)) return getFundamentalEntry(id);
  return byId.get(id);
}

/** A dialog row derived from a registry entry. */
export type IndicatorListRow = { id: string; name: string; shortName?: string };

function rowsForGroup(group: 'standard' | 'community' | 'candlestick'): IndicatorListRow[] {
  return indicatorRegistry
    .filter((e) => e.group === group)
    .map((e) => ({ id: e.id, name: e.name, shortName: e.shortName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Standard entries the reference app files under Technicals > Patterns >
 *  Chart patterns instead of Indicators. */
const CHART_PATTERN_IDS = new Set(['auto-trend-detector']);

/** Built-In → Technicals → Indicators: the library's hand-optimised standard
 *  indicators, plus the local built-ins. */
export const STANDARD_ROWS: IndicatorListRow[] = [
  ...rowsForGroup('standard').filter((r) => !CHART_PATTERN_IDS.has(r.id)),
  { id: VOLUME_ENTRY.id, name: VOLUME_ENTRY.name, shortName: VOLUME_ENTRY.shortName },
].sort((a, b) => a.name.localeCompare(b.name));

/** Built-In → Technicals → Patterns: chart patterns, then candlestick patterns. */
export const CHART_PATTERN_ROWS: IndicatorListRow[] = rowsForGroup('standard').filter((r) => CHART_PATTERN_IDS.has(r.id));
export const CANDLESTICK_ROWS: IndicatorListRow[] = rowsForGroup('candlestick');

/** Dialog row id of the fixed range volume profile: the reference app's row picks its drawing tool (the study is
 *  that drawing). */
export const FIXED_RANGE_VP_TOOL_ROW = 'tool:fixed-range-volume-profile';

/** Built-In → Technicals → Profiles, in the reference app's order. */
export const PROFILE_ROWS: IndicatorListRow[] = (() => {
  const row = (id: string): IndicatorListRow => {
    const e = byId.get(id)!;
    return { id, name: e.name, shortName: e.shortName };
  };
  return [
    row('tpo-periodic'),
    row('tpo-sessions'),
    row('vbp-auto-anchored'),
    { id: FIXED_RANGE_VP_TOOL_ROW, name: 'Fixed range volume profile', shortName: 'FRVP' },
    row('vbp-periodic'),
    row('vbp-sessions'),
    row('vbp-sessions-hd'),
    row('vbp-visible'),
  ];
})();

/** Community: indicators ported from public PineScript sources. */
export const COMMUNITY_ROWS: IndicatorListRow[] = rowsForGroup('community');
