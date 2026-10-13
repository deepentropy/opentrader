/*
 * Style of the volume profile studies (Settings > Style), the reference
 * factory values as its themes set them: rows up rgba(38, 198, 218, 0.5) /
 * down rgba(236, 64, 122, 0.5) (value area rows 0.75), width 30 % of the box,
 * placement left (Visible range: right), values off, POC width 2 on, VAH /
 * VAL width 2 off, histogram box rgba(38, 198, 218, 0.05); values and lines
 * in the theme's text colour (#DBDBDB dark, #0F0F0F light). Stored with the
 * study's inputs (STYLE_INPUT) as the edits from those values, so an
 * unedited colour follows the theme; the developing POC / VA lines are plots
 * (plot style overrides).
 */
import { STYLE_INPUT } from "../indicators/strategy-entries";
import { uiTheme } from "../../header/chart-settings";

export type VbpLine = { visible: boolean; color: string; width: number; style: number };

export type VbpStyle = {
  /** "Volume profile" check box: the rows. */
  visible: boolean;
  showValues: boolean;
  valuesColor: string;
  percentWidth: number;
  placement: "Left" | "Right";
  upColor: string;
  downColor: string;
  vaUpColor: string;
  vaDownColor: string;
  vah: VbpLine;
  val: VbpLine;
  poc: VbpLine;
  boxColor: string;
  /** A developing POC / VA line is shown (set by the Style tab): the study computes them only then. */
  developing?: boolean;
};

/** Text colour of the app theme: the themed default of the lines and values. */
export function themeTextColor(): string {
  return uiTheme() === "light" ? "#0F0F0F" : "#DBDBDB";
}

export function defaultVbpStyle(placement: "Left" | "Right"): VbpStyle {
  const text = themeTextColor();
  return {
    visible: true,
    showValues: false,
    valuesColor: text,
    percentWidth: 30,
    placement,
    upColor: "rgba(38, 198, 218, 0.5)",
    downColor: "rgba(236, 64, 122, 0.5)",
    vaUpColor: "rgba(38, 198, 218, 0.75)",
    vaDownColor: "rgba(236, 64, 122, 0.75)",
    vah: { visible: false, color: text, width: 2, style: 0 },
    val: { visible: false, color: text, width: 2, style: 0 },
    poc: { visible: true, color: text, width: 2, style: 0 },
    boxColor: "rgba(38, 198, 218, 0.05)",
  };
}

/** The fields of `style` that differ from the factory values (what is stored). */
export function vbpStyleEdits(style: VbpStyle, placement: "Left" | "Right"): Partial<VbpStyle> {
  const base = defaultVbpStyle(placement) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(style)) {
    const b = base[k];
    if (v && typeof v === "object") {
      const diff: Record<string, unknown> = {};
      for (const [kk, vv] of Object.entries(v)) if ((b as Record<string, unknown>)[kk] !== vv) diff[kk] = vv;
      if (Object.keys(diff).length) out[k] = diff;
    } else if (b !== v) out[k] = v;
  }
  return out as Partial<VbpStyle>;
}

/** The study's style: its stored edits over the factory values. */
export function vbpStyleOf(inputs: Record<string, unknown> | undefined, placement: "Left" | "Right"): VbpStyle {
  const base = defaultVbpStyle(placement);
  const saved = (inputs?.[STYLE_INPUT] ?? {}) as Partial<VbpStyle>;
  return {
    ...base,
    ...saved,
    vah: { ...base.vah, ...(saved.vah ?? {}) },
    val: { ...base.val, ...(saved.val ?? {}) },
    poc: { ...base.poc, ...(saved.poc ?? {}) },
  };
}
