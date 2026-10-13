/*
 * Style of the time price opportunity studies (Settings > Style and Volume
 * profile tabs), the reference factory values as its themes set them: block
 * colours #E91E63 / #00C853 / #00BCD4 / #651FFF, blocks and letters on, 30
 * transparency outside the value area, initial balance on (2 blocks), POC /
 * VAH / VAL labels on, poor high / low #7C4DFF (dark) / #6200EA (light) off,
 * single prints rgba(224, 64, 251, 0.15) off, midpoint / open / close off;
 * volume profile on (outside VA rgba(38, 198, 218, 0.5), inside 0.75, values
 * off), its POC line width 2 on, VAH / VAL off. Theme text colour for the
 * levels and values (#DBDBDB dark, #0F0F0F light). Stored with the study's
 * inputs (STYLE_INPUT) as the edits from those values.
 */
import { STYLE_INPUT } from "../indicators/strategy-entries";
import { uiTheme } from "../../header/chart-settings";

export type TpoLevel = { visible: boolean; color: string };
export type TpoVolumeLevel = TpoLevel & { width: number; style: number };

export type TpoStyle = {
  colors: [string, string, string, string];
  showBlocks: boolean;
  showLetters: boolean;
  /** Transparency (0-100) of the rows outside the value area. */
  nonVaOpacity: number;
  /** "Expand blocks": blocks at their time column instead of stacked left; mode All / Last profile. */
  expand: boolean;
  expandMode: "All" | "Last profile";
  poc: TpoLevel;
  poorHigh: TpoLevel;
  poorLow: TpoLevel;
  singlePrints: TpoLevel;
  vah: TpoLevel;
  val: TpoLevel;
  midpoint: boolean;
  open: boolean;
  close: boolean;
  initialBalance: boolean;
  ibBlocks: number;
  volume: {
    visible: boolean;
    showValues: boolean;
    valuesColor: string;
    vah: TpoVolumeLevel;
    val: TpoVolumeLevel;
    poc: TpoVolumeLevel;
    nonVaColor: string;
    vaColor: string;
    placement: "Left" | "Right";
  };
};

export function defaultTpoStyle(): TpoStyle {
  const light = uiTheme() === "light";
  const text = light ? "#0F0F0F" : "#DBDBDB";
  const purple = light ? "#6200EA" : "#7C4DFF";
  return {
    colors: ["#E91E63", "#00C853", "#00BCD4", "#651FFF"],
    showBlocks: true,
    showLetters: true,
    nonVaOpacity: 30,
    expand: false,
    expandMode: "All",
    poc: { visible: true, color: text },
    poorHigh: { visible: false, color: purple },
    poorLow: { visible: false, color: purple },
    singlePrints: { visible: false, color: "rgba(224, 64, 251, 0.15)" },
    vah: { visible: true, color: text },
    val: { visible: true, color: text },
    midpoint: false,
    open: false,
    close: false,
    initialBalance: true,
    ibBlocks: 2,
    volume: {
      visible: true,
      showValues: false,
      valuesColor: text,
      vah: { visible: false, color: text, width: 2, style: 0 },
      val: { visible: false, color: text, width: 2, style: 0 },
      poc: { visible: true, color: text, width: 2, style: 0 },
      nonVaColor: "rgba(38, 198, 218, 0.5)",
      vaColor: "rgba(38, 198, 218, 0.75)",
      placement: "Left",
    },
  };
}

/** Deep difference of `value` from `base` (plain objects and arrays compared by value). */
function diff(value: unknown, base: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && base && typeof base === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const d = diff(v, (base as Record<string, unknown>)[k]);
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return JSON.stringify(value) === JSON.stringify(base) ? undefined : value;
}

function merge<T>(base: T, saved: unknown): T {
  if (!saved || typeof saved !== "object" || Array.isArray(saved) || !base || typeof base !== "object" || Array.isArray(base)) return (saved === undefined ? base : saved) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(saved)) out[k] = merge((base as Record<string, unknown>)[k], v);
  return out as T;
}

/** The fields of `style` that differ from the factory values (what is stored). */
export function tpoStyleEdits(style: TpoStyle): Partial<TpoStyle> {
  return (diff(style, defaultTpoStyle()) ?? {}) as Partial<TpoStyle>;
}

/** The study's style: its stored edits over the factory values. */
export function tpoStyleOf(inputs: Record<string, unknown> | undefined): TpoStyle {
  return merge(defaultTpoStyle(), inputs?.[STYLE_INPUT]);
}
