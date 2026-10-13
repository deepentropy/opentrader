/*
 * Time price opportunity studies of Technicals > Profiles (#48): Time price
 * opportunity (TPO, one profile per N days / weeks / months, counted from the
 * start of the year as the periodic volume profile) and Session time price
 * opportunity (STPO, per session as the session volume profile). The bars of
 * the block size come from the chart context's `lowerBars`; each profile is
 * built by tpo-engine.ts and drawn by tpo-primitive.ts.
 */
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import type { Bar } from "oakscriptjs";
import { cachedSymbolSessions } from "../../../data/session";
import { lowerBound } from "./vbp-engine";
import { autoTicksPerRow, buildTpo, type TpoDraw, type TpoProfile } from "./tpo-engine";
import { chartSeconds, periodKeyerFor, SESSION_OPTIONS, sessionKeyerFor, TIME_ZONES, type ProfileCalcContext } from "./vbp-studies";
import { tpoStyleOf } from "./tpo-style";

// ── Studies ────────────────────────────────────────────────────────────────

const BLOCK_RES: Record<string, string> = { "5m": "5", "10m": "10", "15m": "15", "30m": "30", "1h": "60", "2h": "120", "4h": "240" };

/** Profiles drawn together at most (newest first), as the volume profile studies' row budget. */
const MAX_TOTAL_ROWS = 6000;

function calcTpo(bars: Bar[], inputs: Record<string, unknown>, ctx: ProfileCalcContext | undefined, sessionsMode: boolean) {
  const sessions = ctx?.tickerid ? cachedSymbolSessions(ctx.tickerid) : null;
  if (!sessions || !ctx?.lowerBars || !bars.length) return { plots: {}, pending: true };
  const tick = ctx.mintick ?? sessions.mintick ?? 0.01;
  const sec = chartSeconds(ctx.timeframe ?? "1D");
  const res = BLOCK_RES[String(inputs.blockSize ?? "30m")] ?? "30";
  const tpr = inputs.rowSize === "Manual" ? Math.max(1, Math.round(Number(inputs.ticksPerRow ?? 100))) : autoTicksPerRow(bars, tick);
  const keyOf = sessionsMode ? sessionKeyerFor(inputs, sessions) : periodKeyerFor({ ...inputs, period: inputs.period ?? "Day" }, sessions, bars, sec);
  const from = bars[0].time as number;
  const ltf = ctx.lowerBars(res, from);
  if (!ltf) return { plots: {}, pending: true };
  const style = tpoStyleOf(inputs);
  // Groups of block bars with the same key.
  const groups: { g0: number; g1: number }[] = [];
  let key: string | null = null;
  for (let i = lowerBound(ltf as unknown as { time: number }[], from); i < ltf.length; i++) {
    const k = keyOf(ltf[i].time as number);
    if (k === null) { key = null; continue; }
    const last = groups[groups.length - 1];
    if (last && k === key && last.g1 === i - 1) last.g1 = i;
    else groups.push({ g0: i, g1: i });
    key = k;
  }
  const chartIndex = (t: number) => {
    let at = t;
    if (sec >= 86400) {
      const day = sessions.extended.tradingDay(t);
      at = Math.max(t, sessions.regular.dayBounds(day)?.start ?? t);
    }
    return lowerBound(bars as unknown as { time: number }[], at + 1) - 1;
  };
  const profiles: TpoProfile[] = [];
  let rows = 0;
  for (let k = groups.length - 1; k >= 0 && rows < MAX_TOTAL_ROWS; k--) {
    const g = groups[k];
    const i0 = chartIndex(ltf[g.g0].time as number);
    const i1 = chartIndex(ltf[g.g1].time as number);
    if (i0 < 0 || i1 < 0) break;
    const p = buildTpo(ltf, g.g0, g.g1, tick, tpr, Number(inputs.vaPercent ?? 70), Math.max(1, Math.round(style.ibBlocks)));
    if (!p) continue;
    rows += p.rows.length;
    const price = (r: number, mid = true) => (r + (mid ? 0.5 : 0)) * p.rowSize;
    // Extended levels stop at the first later bar that crosses them (-1: none).
    const stop = (on: unknown, level: number | null): number | null => {
      if (!on || level === null) return null;
      for (let j = i1 + 1; j < bars.length; j++) if (bars[j].low <= level && level <= bars[j].high) return j;
      return -1;
    };
    profiles.push({
      ...p,
      i0,
      i1,
      extend: {
        poc: stop(inputs.extendPOC, price(p.poc)),
        vah: stop(inputs.extendTpoVah, (p.vah + 1) * p.rowSize),
        val: stop(inputs.extendTpoVal, p.val * p.rowSize),
        poorHigh: stop(inputs.extendPoorHigh, p.poorHigh === null ? null : price(p.poorHigh)),
        poorLow: stop(inputs.extendPoorLow, p.poorLow === null ? null : price(p.poorLow)),
        volumePoc: stop(inputs.extendVolumePoc, p.volumePoc === null ? null : price(p.volumePoc)),
        volumeVah: stop(inputs.extendVolumeVah, p.volumeVah === null ? null : (p.volumeVah + 1) * p.rowSize),
        volumeVal: stop(inputs.extendVolumeVal, p.volumeVal === null ? null : p.volumeVal * p.rowSize),
      },
      singleExtend: p.singlePrints.map((r) => stop(inputs.extendSingleprints, price(r))),
    });
  }
  profiles.reverse();
  return { plots: {}, tpo: { profiles, style } satisfies TpoDraw };
}

type Input = IndicatorRegistryEntry["inputConfig"][number] & { display?: string; tooltip?: string; enabledWhen?: { id: string; value: string }; hidden?: boolean };

const BLOCK_INPUTS: Input[] = [
  { id: "blockSize", type: "string", title: "Block Size", defval: "30m", options: ["5m", "10m", "15m", "30m", "1h", "2h", "4h"], display: "data_window" },
  { id: "rowSize", type: "string", title: "Rows Size", defval: "Auto", options: ["Auto", "Manual"], display: "data_window" },
  { id: "ticksPerRow", type: "int", title: "Ticks Per Row", defval: 100, min: 1, max: 1000000, display: "data_window", enabledWhen: { id: "rowSize", value: "Manual" } },
  { id: "vaPercent", type: "int", title: "Value Area Percent", defval: 70, min: 0, max: 100, display: "data_window" },
] as Input[];

/** Level extensions: edited in the Style / Volume profile tabs (Extend / Don't extend). */
export const TPO_EXTEND_INPUTS = ["extendPOC", "extendPoorHigh", "extendPoorLow", "extendSingleprints", "extendTpoVah", "extendTpoVal", "extendVolumePoc", "extendVolumeVah", "extendVolumeVal"];
const EXTEND_INPUTS: Input[] = TPO_EXTEND_INPUTS.map((id) => ({ id, type: "bool", title: id, defval: false, display: "none", hidden: true }) as Input);

/** Extra field of a TPO entry the app reads (dialog tabs). */
export type TpoEntryMeta = { tpo: true };

function tpoEntry(id: string, name: string, shortName: string, inputs: Input[], sessionsMode: boolean): IndicatorRegistryEntry & TpoEntryMeta {
  return {
    id,
    group: "standard",
    name,
    shortName,
    category: "Volume",
    overlay: true,
    metadata: { title: name, shortTitle: shortName, overlay: true },
    // No input in the status line (reference display flags).
    inputConfig: [...inputs.map((i) => ({ ...i, display: i.display ?? "data_window" })), ...EXTEND_INPUTS] as IndicatorRegistryEntry["inputConfig"],
    plotConfig: [],
    defaultInputs: Object.fromEntries([...inputs, ...EXTEND_INPUTS].map((i) => [i.id, i.defval])),
    calculate: ((bars: Bar[], inp: Record<string, unknown>, ctx?: ProfileCalcContext) => calcTpo(bars, inp ?? {}, ctx, sessionsMode)) as unknown as IndicatorRegistryEntry["calculate"],
    tpo: true,
  } as IndicatorRegistryEntry & TpoEntryMeta;
}

export const TPO_ENTRY = tpoEntry("tpo-periodic", "Time price opportunity", "TPO", [
  { id: "periodsNum", type: "int", title: "Period", defval: 1, min: 1, max: 1000000, inline: "period" } as Input,
  { id: "period", type: "string", title: "", defval: "Day", options: ["Day", "Week", "Month"], inline: "period" } as Input,
  ...BLOCK_INPUTS,
], false);

export const SESSION_TPO_ENTRY = tpoEntry("tpo-sessions", "Session time price opportunity", "STPO", [
  { id: "profilesSessions", type: "string", title: "Sessions", defval: "All", options: SESSION_OPTIONS, tooltip: "Which part of each day makes a profile: All = one profile per day, Each = one per session (pre-market, market, post-market), Custom = the period set below; the other choices keep one session only." } as Input,
  { id: "customSession", type: "session", title: "Custom session", defval: "0930-1600", display: "data_window", enabledWhen: { id: "profilesSessions", value: "Custom" } } as unknown as Input,
  { id: "customSessionTZ", type: "string", title: "", defval: "Exchange", options: TIME_ZONES, display: "data_window", enabledWhen: { id: "profilesSessions", value: "Custom" } } as Input,
  ...BLOCK_INPUTS,
], true);

export const TPO_ENTRIES = [TPO_ENTRY, SESSION_TPO_ENTRY];

export function isTpoEntry(e: IndicatorRegistryEntry | null | undefined): boolean {
  return !!(e as (IndicatorRegistryEntry & Partial<TpoEntryMeta>) | null | undefined)?.tpo;
}
