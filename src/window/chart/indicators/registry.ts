/*
 * Bridge to the indicator library's registry
 * (github.com/deepentropy/lightweight-charts-indicators).  This is the single
 * source of truth for what indicators exist — the dialog lists them and the
 * chart renders them, both keyed by the registry `id`.  No hand-maintained
 * catalogue, so the list can never drift from what's actually computable.
 *
 * The library (several megabytes) is not part of the first download: the
 * lists come from its names (`virtual:indicator-manifest`, read from the
 * library at build time) and the library itself is imported on first use —
 * started once the app is up (`loadIndicatorLibrary`), or by the first
 * `getIndicatorEntry` of one of its studies. Until it is there such an entry
 * is undefined; the reads track `indicatorLibraryLoaded`, so the chart's
 * studies (and any other reactive reader) are built when it arrives.
 */
import { createSignal } from 'solid-js';
import type { IndicatorRegistryEntry } from 'lightweight-charts-indicators';
import manifest from 'virtual:indicator-manifest';
import { getUserIndicatorEntry, isUserIndicatorId } from './user-scripts';
import { getStrategyEntry, isStrategyId } from './strategy-entries';
import { VOLUME_ENTRY } from './volume';
import { VBP_ENTRIES } from '../profiles/vbp-studies';
import { TPO_ENTRIES } from '../profiles/tpo';
import { typeIdOf } from './study-id';
import { getFundamentalEntry, isFundamentalId } from './fundamental-entry';

const GROUPS = { s: 'standard', c: 'community', k: 'candlestick' } as const;
type Group = (typeof GROUPS)[keyof typeof GROUPS];

/** The library's entries by name only (no code): id → name, short name, group. */
const NAMES = new Map<string, { name: string; shortName: string; group: Group }>(
  manifest.entries.map(([id, name, shortName, g]) => [id, { name, shortName, group: GROUPS[g] }]),
);

/** The app's own built-ins (the basic Volume study, the volume profiles): always there. */
const LOCAL = new Map<string, IndicatorRegistryEntry>();
LOCAL.set(VOLUME_ENTRY.id, VOLUME_ENTRY);
for (const e of [...VBP_ENTRIES, ...TPO_ENTRIES]) LOCAL.set(e.id, e);

const byId = new Map<string, IndicatorRegistryEntry>(LOCAL);
const [loaded, setLoaded] = createSignal(false);
/** The indicator library is loaded (its entries are in the registry). */
export const indicatorLibraryLoaded = loaded;
let loading: Promise<void> | null = null;

/** Import the indicator library (once); its entries join the registry. */
export function loadIndicatorLibrary(): Promise<void> {
  loading ??= import('lightweight-charts-indicators').then((m) => {
    for (const e of m.indicatorRegistry) if (!LOCAL.has(e.id)) byId.set(e.id, e);
    setLoaded(true);
  });
  return loading;
}

/** An id of the library (known before the library is loaded). */
export function isLibraryIndicatorId(id: string): boolean {
  return NAMES.has(typeIdOf(id));
}

export function getIndicatorEntry(studyId: string): IndicatorRegistryEntry | undefined {
  // A study instance ("rsi#2") resolves to its type's entry.
  const id = typeIdOf(studyId);
  // `user:<scriptId>` — OakScript indicators written in the editor panel.
  if (isUserIndicatorId(id)) return getUserIndicatorEntry(id);
  // `strategy:<key>` — backtester strategy ports (Strategy Tester).
  if (isStrategyId(id)) return getStrategyEntry(id);
  // `fund:<metric>[:<period>]` — Fundamentals metrics.
  if (isFundamentalId(id)) return getFundamentalEntry(id);
  const local = LOCAL.get(id);
  if (local) return local;
  // A library study: undefined until the library is there (the read is tracked: it comes back when it is).
  if (!loaded() && NAMES.has(id)) {
    void loadIndicatorLibrary();
    return undefined;
  }
  return byId.get(id);
}

/** Name of a registry id without loading the library (lists, menus, titles). */
export function indicatorName(studyId: string): string | undefined {
  const id = typeIdOf(studyId);
  return NAMES.get(id)?.name ?? getIndicatorEntry(id)?.name;
}

/** Group of a library id (standard / community / candlestick), without loading the library. */
export function libraryGroupOf(studyId: string): Group | undefined {
  return NAMES.get(typeIdOf(studyId))?.group;
}

/** The library's ids of a group, without loading the library. */
export function libraryIds(group: Group): string[] {
  return [...NAMES].filter(([, e]) => e.group === group).map(([id]) => id);
}

/** The registry knows this id (the library's names count before it is loaded). */
export function isKnownIndicatorId(studyId: string): boolean {
  return NAMES.has(typeIdOf(studyId)) || !!getIndicatorEntry(studyId);
}

/** A dialog row derived from a registry entry. */
export type IndicatorListRow = { id: string; name: string; shortName?: string };

function rowsForGroup(group: Group): IndicatorListRow[] {
  return [...NAMES]
    .filter(([, e]) => e.group === group)
    .map(([id, e]) => ({ id, name: e.name, shortName: e.shortName }))
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
