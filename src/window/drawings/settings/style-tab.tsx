/*
 * Style page of the drawing Settings dialog: the rows of each tool in
 * display order (STYLE_ROWS ids), rendered by `styleRow`.
 */
import { For, Show, type JSX } from "solid-js";
import type { Drawing, DrawingStyle, GhostCandleStyle, LineStyle, PositionStatKey, RegressionLine } from "lightweight-charts-drawing/core/types";
import { defaultStyleFor, ELLIOTT_DEFAULT_DEGREE, ELLIOTT_DEGREE_NAMES, FIB_TREND_LINE_DEFAULT, FIB_WEDGE_TREND_LINE_DEFAULT, GHOST_CANDLE_DEFAULTS, REGRESSION_LINE_DEFAULTS, TREND_FIB_TIME_TREND_DEFAULT } from "lightweight-charts-drawing/core/specs";
import { vwapBandLine } from "lightweight-charts-drawing/core/kinds/data-series";
import { applyOpacity, parseColor } from "../ColorPanel";
import { LineEndSelect, LineGlyphSelect } from "../LineEndSelect";
import { positionStatOn, POSITION_STATS } from "lightweight-charts-drawing/core/kinds/position";
import { TransparencySlider } from "../ImageDialog";
import { CheckboxRow, ColorThicknessPicker, DialogColorButton, DialogRow, Dropdown, FontStyleToggles, StatsMultiSelect } from "./controls";
import { BackgroundColorRow, GannBoxStyleRows, GannStyleRows, ImageStyleRows, LevelGridRows, SpeedFanStyleRows } from "./style-sections";
import { VolumeProfileStyleRows } from "./volume-profile";
import {
  BAR_PATTERN_MODE_LABELS,
  BAR_PATTERN_MODE_VALUES,
  capitalize,
  EXTEND_KINDS,
  EXTEND_TITLES,
  FONT_SIZES,
  HIGHLIGHTER_PX,
  LEVEL_KIND_DEFAULTS,
  LEVELS_LINE_KINDS,
  PITCHFORK_STYLES,
  sizeOptions,
  STAT_FIELDS,
  STATS_POSITIONS,
  styleRowsFor,
  VERT_ALIGN_TITLE,
  vertAlignFromTitle,
} from "./kind-config";
import { type SettingsCx } from "./context";

export function styleTab(cx: SettingsCx): JSX.Element {
  const { kind, patchStyle, props } = cx;
  const extendValue = (): "none" | "left" | "right" | "both" => {
    const s = props.drawing.style;
    if (s.extendLeft && s.extendRight) return "both";
    if (s.extendLeft) return "left";
    if (s.extendRight) return "right";
    return "none";
  };

  const lineRow = (label: string, ends: boolean, noStyle = false) => (
    <DialogRow label={label}>
      <ColorThicknessPicker
        color={props.drawing.style.color}
        width={props.drawing.style.width}
        lineStyle={noStyle ? undefined : props.drawing.style.lineStyle}
        onColor={(c) => patchStyle({ color: c })}
        onWidth={(w) => patchStyle({ width: w })}
        onLineStyle={noStyle ? undefined : (st) => patchStyle({ lineStyle: st })}
      />
      <Show when={ends}>
        <LineEndSelect side="left" value={props.drawing.style.leftEnd === 1 ? 1 : 0} onChange={(v) => patchStyle({ leftEnd: v })} />
        <LineEndSelect side="right" value={(props.drawing.style.rightEnd ?? defaultStyleFor(props.drawing.kind).rightEnd ?? 0) === 1 ? 1 : 0} onChange={(v) => patchStyle({ rightEnd: v })} />
      </Show>
    </DialogRow>
  );
  // Extend: a list of two checks (per-tool titles), "Don't extend" when
  // none is on.
  const extendRow = () => {
    const [l, r] = EXTEND_TITLES[kind()] ?? ["Extend left line", "Extend right line"];
    return (
      <DialogRow label="Extend">
        <StatsMultiSelect
          fields={[["extendLeft", l], ["extendRight", r]]}
          emptyLabel="Don't extend"
          isOn={(k) => (k === "extendLeft" ? extendValue() === "left" || extendValue() === "both" : extendValue() === "right" || extendValue() === "both")}
          onToggle={(k, v) => patchStyle({ [k]: v } as Partial<DrawingStyle>)}
        />
      </DialogRow>
    );
  };
  /** One Style row (ids in STYLE_ROWS). `kind:Label` ids carry the row title. */
  function styleRow(id: string): import("solid-js").JSX.Element {
    const [key, label = ""] = id.split(":");
    const st = () => props.drawing.style;
    switch (key) {
      case "line":
        return lineRow(label, false);
      case "line+ends":
        return lineRow(label, true);
      case "line+endsNoStyle":
        return lineRow(label, true, true);
      // Position forecast: ten colour rows. The source background swatch
      // carries the drawing's transparency (its opacity sets `transparency`).
      case "forecastColors": {
        type K = "sourceTextColor" | "sourceBackColor" | "sourceStrokeColor" | "targetTextColor" | "targetBackColor" | "targetStrokeColor" | "successTextColor" | "successBackground" | "failureTextColor" | "failureBackground";
        const rows: [K, string, string][] = [
          ["sourceTextColor", "Source text", "#ffffff"],
          ["sourceBackColor", "Source background", "#2962FF"],
          ["sourceStrokeColor", "Source border", "#2962FF"],
          ["targetTextColor", "Target text", "#ffffff"],
          ["targetBackColor", "Target background", "#2962FF"],
          ["targetStrokeColor", "Target border", "#2962FF"],
          ["successTextColor", "Success text", "#ffffff"],
          ["successBackground", "Success background", "#4caf50"],
          ["failureTextColor", "Failure text", "#ffffff"],
          ["failureBackground", "Failure background", "#F23645"],
        ];
        return (
          <For each={rows}>
            {([k, title, def]) => (
              <DialogRow label={title}>
                <Show
                  when={k === "sourceBackColor"}
                  fallback={<DialogColorButton color={st()[k] ?? def} onColor={(c) => patchStyle({ [k]: c } as Partial<DrawingStyle>)} />}
                >
                  <DialogColorButton
                    color={applyOpacity(parseColor(st()[k] ?? def).hex, 100 - (st().transparency ?? 10))}
                    onColor={(c) => {
                      const pc = parseColor(c);
                      patchStyle({ sourceBackColor: pc.hex, transparency: 100 - pc.opacity });
                    }}
                  />
                </Show>
              </DialogRow>
            )}
          </For>
        );
      }
      // Chart patterns "Label": text colour, font size, bold, italic.
      case "patternLabel":
        return (
          <DialogRow label="Label">
            <div class="drawing-settings-text-format">
              <DialogColorButton color={st().textColor ?? "#ffffff"} onColor={(c) => patchStyle({ textColor: c })} />
              <Dropdown value={String(st().fontSize ?? 12)} options={sizeOptions(FONT_SIZES, String(st().fontSize ?? 12))} onChange={(v) => patchStyle({ fontSize: Number(v) })} />
              <FontStyleToggles bold={!!st().bold} italic={!!st().italic} onBold={(v) => patchStyle({ bold: v })} onItalic={(v) => patchStyle({ italic: v })} />
            </div>
          </DialogRow>
        );
      // Polyline "Border": colour + thickness (no line style).
      case "lineNoStyle":
        return (
          <DialogRow label={label}>
            <ColorThicknessPicker color={st().color} width={st().width} onColor={(c) => patchStyle({ color: c })} onWidth={(w) => patchStyle({ width: w })} />
          </DialogRow>
        );
      // Colour-only rows (arrow marks "Arrow", flag "Flag", arrow marker /
      // bars pattern / Elliott / icon "Color", pin "Label", highlighter
      // "Line": the colour panel opacity is part of the colour).
      case "color":
        return (
          <DialogRow label={label}>
            <DialogColorButton color={st().color} onColor={(c) => patchStyle({ color: c })} />
          </DialogRow>
        );
      // Highlighter "Thickness" (factory 20px).
      case "thickness":
        return (
          <DialogRow label="Thickness">
            <Dropdown value={`${st().width}px`} options={sizeOptions(HIGHLIGHTER_PX, `${st().width}px`)} onChange={(v) => patchStyle({ width: parseInt(v, 10) })} />
          </DialogRow>
        );
      case "extend":
        return extendRow();
      case "middlePoint":
        return <CheckboxRow checked={!!st().showMiddlePoint} onChange={(v) => patchStyle({ showMiddlePoint: v })} label="Middle point" />;
      case "priceLabel":
        return <CheckboxRow checked={!!st().showPriceLabels} onChange={(v) => patchStyle({ showPriceLabels: v })} label={label} />;
      case "timeLabel":
        return <CheckboxRow checked={!!st().showTime} onChange={(v) => patchStyle({ showTime: v })} label="Time label" />;
      // Vertical line "Extend" (extendLine, factory on): draws the line
      // through every pane of the chart.
      case "vpStyle":
        return <VolumeProfileStyleRows kind={props.drawing.kind} style={st()} patchStyle={patchStyle} />;
      case "vlineExtend":
        return <CheckboxRow checked={st().extendLine !== false} onChange={(v) => patchStyle({ extendLine: v })} label="Extend" />;
      // Elliott "Wave" (showWave, factory on): the wave lines; off = the
      // labels only.
      // Elliott "Wave": [x] showWave + the wave line width select
      // (line-width-select, 76 x 34; linewidth factory 2).
      case "wave":
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={st().showWave !== false} onChange={(v) => patchStyle({ showWave: v })} label="Wave" />
            <div class="drawing-settings-row-inputs">
              <LineGlyphSelect kind="width" value={st().width} options={[1, 2, 3, 4]} onChange={(v) => patchStyle({ width: v })} />
            </div>
          </div>
        );
      case "stats":
        return (
          <>
            <div class="drawing-settings-section-title">Info</div>
            <DialogRow label="Stats">
              <StatsMultiSelect
                // Trend angle: price and bars stats only.
                fields={kind() === "trend-angle" ? STAT_FIELDS.slice(0, 4) : STAT_FIELDS}
                isOn={(k) => !!st()[k as keyof DrawingStyle]}
                onToggle={(k, v) => patchStyle({ [k]: v } as Partial<DrawingStyle>)}
              />
            </DialogRow>
            <DialogRow label="Stats position">
              <Dropdown
                wide
                value={STATS_POSITIONS[st().statsPosition ?? (kind() === "info-line" ? 1 : 2)]}
                options={[...STATS_POSITIONS]}
                onChange={(v) => {
                  const i = STATS_POSITIONS.indexOf(v as (typeof STATS_POSITIONS)[number]);
                  if (i >= 0) patchStyle({ statsPosition: i as 0 | 1 | 2 | 3 });
                }}
              />
            </DialogRow>
            <CheckboxRow checked={!!st().showStats} onChange={(v) => patchStyle({ showStats: v })} label="Always show stats" />
            <div class="drawing-settings-group-sep" />
          </>
        );
      case "background":
        return <BackgroundColorRow style={st()} patchStyle={patchStyle} />;
      case "rectMiddleLine": {
        const ml = () => st().rectMiddleLine ?? { visible: false, color: st().color, width: 1, style: "dashed" as LineStyle };
        const patchMl = (patch: Partial<RegressionLine>) => patchStyle({ rectMiddleLine: { ...ml(), ...patch } });
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={ml().visible} onChange={(v) => patchMl({ visible: v })} label="Middle line" />
            <div class="drawing-settings-row-inputs">
              <ColorThicknessPicker color={ml().color} width={ml().width} lineStyle={ml().style} onColor={(c) => patchMl({ color: c })} onWidth={(w) => patchMl({ width: w })} onLineStyle={(x) => patchMl({ style: x })} />
            </div>
          </div>
        );
      }
      case "degree":
        return (
          <DialogRow label="Degree">
            <Dropdown
              mid
              value={ELLIOTT_DEGREE_NAMES[st().elliottDegree ?? ELLIOTT_DEFAULT_DEGREE]}
              options={[...ELLIOTT_DEGREE_NAMES]}
              onChange={(v) => {
                const i = ELLIOTT_DEGREE_NAMES.indexOf(v as (typeof ELLIOTT_DEGREE_NAMES)[number]);
                if (i >= 0) patchStyle({ elliottDegree: i });
              }}
            />
          </DialogRow>
        );
      // Anchored VWAP Style: Lower / Upper band #1,
      // Background #1, Lower / Upper band #2, #3 (visible + colour + width),
      // Price label.
      case "vwapBands": {
        const bandRow = (i: number, side: "upper" | "lower") => {
          const key = side === "upper" ? "vwapUpper" : "vwapLower";
          const ln = () => vwapBandLine(st(), i, side);
          const patchLn = (x: Partial<RegressionLine>) => {
            const cur = [0, 1, 2].map((k) => ({ ...vwapBandLine(st(), k, side) }));
            cur[i] = { ...cur[i], ...x };
            patchStyle({ [key]: cur } as Partial<DrawingStyle>);
          };
          return (
            <div class="drawing-settings-row">
              <CheckboxRow checked={ln().visible} onChange={(v) => patchLn({ visible: v })} label={`${side === "upper" ? "Upper" : "Lower"} band #${i + 1}`} />
              <div class="drawing-settings-row-inputs">
                <ColorThicknessPicker color={ln().color} width={ln().width} onColor={(c) => patchLn({ color: c })} onWidth={(w) => patchLn({ width: w })} />
              </div>
            </div>
          );
        };
        return (
          <>
            {bandRow(0, "lower")}
            {bandRow(0, "upper")}
            <div class="drawing-settings-row">
              <CheckboxRow checked={st().fillBackground !== false} onChange={(v) => patchStyle({ fillBackground: v })} label="Background #1" />
              <div class="drawing-settings-row-inputs">
                <DialogColorButton
                  color={applyOpacity(parseColor(st().backgroundColor ?? "#4caf50").hex, 100 - (st().transparency ?? 95))}
                  onColor={(c) => {
                    const pc = parseColor(c);
                    patchStyle({ backgroundColor: pc.hex, transparency: 100 - pc.opacity });
                  }}
                />
              </div>
            </div>
            {bandRow(1, "lower")}
            {bandRow(1, "upper")}
            {bandRow(2, "lower")}
            {bandRow(2, "upper")}
            <CheckboxRow checked={st().vwapPriceLabel !== false} onChange={(v) => patchStyle({ vwapPriceLabel: v })} label="Price label" />
          </>
        );
      }
      case "speedFan":
        return <SpeedFanStyleRows style={st()} patchStyle={patchStyle} />;
      case "gannBox":
        return <GannBoxStyleRows style={st()} patchStyle={patchStyle} />;
      case "fibTrendLine": {
        const tl = () => st().fibTrendLine ?? (kind() === "trend-based-fib-time" ? TREND_FIB_TIME_TREND_DEFAULT : kind() === "fib-wedge" ? FIB_WEDGE_TREND_LINE_DEFAULT : FIB_TREND_LINE_DEFAULT);
        const patchTl = (x: Partial<RegressionLine>) => patchStyle({ fibTrendLine: { ...tl(), ...x } });
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={tl().visible} onChange={(v) => patchTl({ visible: v })} label="Trend line" />
            <div class="drawing-settings-row-inputs">
              <ColorThicknessPicker color={tl().color} width={tl().width} lineStyle={tl().style} onColor={(c) => patchTl({ color: c })} onWidth={(w) => patchTl({ width: w })} onLineStyle={(x) => patchTl({ style: x })} />
            </div>
          </div>
        );
      }
      case "gannSquare":
        return <GannStyleRows drawing={props.drawing} coords={props.coords} patchStyle={patchStyle} onUpdate={props.onUpdate} />;
      // Table Style: Background, Border, Text
      // (colour + size), Text alignment (factory Left).
      case "table":
        return (
          <>
            <DialogRow label="Background">
              <DialogColorButton color={st().backgroundColor ?? "#0f0f0f"} onColor={(c) => patchStyle({ backgroundColor: c })} />
            </DialogRow>
            <DialogRow label="Border">
              <DialogColorButton color={st().color} onColor={(c) => patchStyle({ color: c })} />
            </DialogRow>
            <DialogRow label="Text">
              <DialogColorButton color={st().textColor ?? "#dbdbdb"} onColor={(c) => patchStyle({ textColor: c })} />
              <Dropdown value={String(st().fontSize ?? 14)} options={sizeOptions(FONT_SIZES, String(st().fontSize ?? 14))} onChange={(v) => patchStyle({ fontSize: Number(v) })} />
            </DialogRow>
            <DialogRow label="Text alignment">
              <Dropdown value={capitalize(st().horzLabelsAlign ?? "left")} options={["Left", "Center", "Right"]} onChange={(v) => patchStyle({ horzLabelsAlign: v.toLowerCase() as "left" | "center" | "right" })} />
            </DialogRow>
          </>
        );
      case "image":
        return <ImageStyleRows drawing={props.drawing} coords={props.coords} onUpdate={props.onUpdate} patchStyle={patchStyle} />;
      // Sector (projection): Background = the two gradient colours
      // (shared transparency), Border = colour + width.
      case "sector":
        return (
          <>
            <DialogRow label="Background">
              <For each={[["sectorColor1", "#2962ff"], ["sectorColor2", "#9c27b0"]] as const}>
                {([k, dflt]) => (
                  <DialogColorButton
                    color={applyOpacity(parseColor(st()[k] ?? dflt).hex, 100 - (st().transparency ?? 80))}
                    onColor={(c) => {
                      const pc = parseColor(c);
                      patchStyle({ [k]: pc.hex, transparency: 100 - pc.opacity } as Partial<DrawingStyle>);
                    }}
                  />
                )}
              </For>
            </DialogRow>
            <DialogRow label="Border">
              <ColorThicknessPicker color={st().color} width={st().width} onColor={(c) => patchStyle({ color: c })} onWidth={(w) => patchStyle({ width: w })} />
            </DialogRow>
          </>
        );
      case "levels":
        return (
          <LevelGridRows
            kind={kind()}
            style={st()}
            defaults={LEVEL_KIND_DEFAULTS[kind()]}
            patchStyle={patchStyle}
            extendRow={LEVELS_LINE_KINDS.has(kind()) && EXTEND_KINDS.has(kind()) ? extendRow() : undefined}
          />
        );
      case "reverse":
        return <CheckboxRow checked={!!st().reverse} onChange={(v) => patchStyle({ reverse: v })} label="Reverse" />;
      // Fib channel label rows: Prices, Levels (Values / Percents),
      // Labels (horizontal + vertical), Font size (8 ... 24).
      case "fibChannelLabels":
        return (
          <>
            <CheckboxRow checked={st().showPrices !== false} onChange={(v) => patchStyle({ showPrices: v })} label="Prices" />
            <div class="drawing-settings-row">
              <CheckboxRow checked={st().showCoeffs !== false} onChange={(v) => patchStyle({ showCoeffs: v })} label="Levels" />
              <div class="drawing-settings-row-inputs">
                <Dropdown value={st().fibLevelsAsPercents ? "Percents" : "Values"} options={["Values", "Percents"]} onChange={(v) => patchStyle({ fibLevelsAsPercents: v === "Percents" })} />
              </div>
            </div>
            <DialogRow label="Labels">
              <Dropdown value={capitalize(st().horzLabelsAlign ?? "left")} options={["Left", "Center", "Right"]} onChange={(v) => patchStyle({ horzLabelsAlign: v.toLowerCase() as "left" | "center" | "right" })} />
              <Dropdown value={VERT_ALIGN_TITLE[st().vertLabelsAlign ?? "middle"]} options={["Top", "Middle", "Bottom"]} onChange={(v) => patchStyle({ vertLabelsAlign: vertAlignFromTitle(v) })} />
            </DialogRow>
            <DialogRow label="Font size">
              <Dropdown value={String(st().labelFontSize ?? 12)} options={["8", "10", "11", "12", "14", "16", "18", "20", "22", "24"]} onChange={(v) => patchStyle({ labelFontSize: Number(v) })} />
            </DialogRow>
          </>
        );
      // Fib retracement / extension labels: [x] Prices, [x] Levels
      // (Values / Percents), Labels (horizontal + vertical), [x] Text
      // (level texts, horizontal + vertical), Font size.
      case "fibLabels":
        return (
          <>
            <CheckboxRow checked={st().showPrices !== false} onChange={(v) => patchStyle({ showPrices: v })} label="Prices" />
            <div class="drawing-settings-row">
              <CheckboxRow checked={st().showCoeffs !== false} onChange={(v) => patchStyle({ showCoeffs: v })} label="Levels" />
              <div class="drawing-settings-row-inputs">
                <Dropdown value={st().fibLevelsAsPercents ? "Percents" : "Values"} options={["Values", "Percents"]} onChange={(v) => patchStyle({ fibLevelsAsPercents: v === "Percents" })} />
              </div>
            </div>
            <DialogRow label="Labels">
              <Dropdown value={capitalize(st().horzLabelsAlign ?? "left")} options={["Left", "Center", "Right"]} onChange={(v) => patchStyle({ horzLabelsAlign: v.toLowerCase() as "left" | "center" | "right" })} />
              <Dropdown value={VERT_ALIGN_TITLE[st().vertLabelsAlign ?? "middle"]} options={["Top", "Middle", "Bottom"]} onChange={(v) => patchStyle({ vertLabelsAlign: vertAlignFromTitle(v) })} />
            </DialogRow>
            <div class="drawing-settings-row">
              <CheckboxRow checked={st().showText !== false} onChange={(v) => patchStyle({ showText: v })} label="Text" />
              <div class="drawing-settings-row-inputs">
                <Dropdown value={capitalize(st().horzTextAlign ?? "center")} options={["Left", "Center", "Right"]} onChange={(v) => patchStyle({ horzTextAlign: v.toLowerCase() as "left" | "center" | "right" })} />
                <Dropdown value={VERT_ALIGN_TITLE[st().vertTextAlign ?? "middle"]} options={["Top", "Middle", "Bottom"]} onChange={(v) => patchStyle({ vertTextAlign: vertAlignFromTitle(v) })} />
              </div>
            </div>
            <DialogRow label="Font size">
              <Dropdown value={String(st().labelFontSize ?? 12)} options={["8", "10", "11", "12", "14", "16", "18", "20", "22", "24"]} onChange={(v) => patchStyle({ labelFontSize: Number(v) })} />
            </DialogRow>
          </>
        );
      // Fib circles / speed arcs / wedge "Levels" (showCoeffs, factory on).
      case "showCoeffs":
        return <CheckboxRow checked={st().showCoeffs !== false} onChange={(v) => patchStyle({ showCoeffs: v })} label="Levels" />;
      case "coeffsAsPercents":
        return <CheckboxRow checked={!!st().fibLevelsAsPercents} onChange={(v) => patchStyle({ fibLevelsAsPercents: v })} label="Coeffs as percents" />;
      case "fullCircles":
        return <CheckboxRow checked={!!st().fullCircles} onChange={(v) => patchStyle({ fullCircles: v })} label="Full circles" />;
      case "counterclockwise":
        return <CheckboxRow checked={!!st().counterclockwise} onChange={(v) => patchStyle({ counterclockwise: v })} label="Counterclockwise" />;
      // Gann fan "Labels" (showLabels, factory on).
      case "labels":
        return <CheckboxRow checked={st().showLabels !== false} onChange={(v) => patchStyle({ showLabels: v })} label="Labels" />;
      // Pitchfork "Extend lines" (extendLines: the lines also run back).
      case "pitchforkExtend":
        return <CheckboxRow checked={!!st().extendLines} onChange={(v) => patchStyle({ extendLines: v })} label="Extend lines" />;
      // Pitchfork "Style": Original / Schiff / Modified Schiff / Inside
      // (one tool in the UI; OpenTrader switches between its four pitchfork
      // kinds).
      case "pitchforkStyle":
        return (
          <DialogRow label="Style">
            <Dropdown
              value={PITCHFORK_STYLES.find(([k]) => k === kind())?.[1] ?? "Original"}
              options={PITCHFORK_STYLES.map(([, t]) => t)}
              onChange={(v) => {
                const k = PITCHFORK_STYLES.find(([, t]) => t === v)?.[0];
                if (k && k !== kind()) props.onUpdate({ ...props.drawing, kind: k } as Drawing);
              }}
            />
          </DialogRow>
        );
      // fibLevelsBasedOnLogScale: level prices in ln(price) space, only
      // on a logarithmic price scale.
      case "fibLog":
        return <CheckboxRow checked={!!st().fibLevelsBasedOnLogScale} onChange={(v) => patchStyle({ fibLevelsBasedOnLogScale: v })} label="Fib levels based on log scale" />;
      // Regression trend Style: Base / Up / Down (check box + line).
      case "regressionLines":
        return (
          <For each={[["base", "Base"], ["up", "Up"], ["down", "Down"]] as const}>
            {([k, title]) => {
              const cur = () => (st().regressionLines ?? REGRESSION_LINE_DEFAULTS)[k];
              const patchLine = (patch: Partial<RegressionLine>) => {
                const all = st().regressionLines ?? REGRESSION_LINE_DEFAULTS;
                patchStyle({ regressionLines: { ...all, [k]: { ...all[k], ...patch } } });
              };
              return (
                <div class="drawing-settings-row">
                  <CheckboxRow checked={cur().visible} onChange={(v) => patchLine({ visible: v })} label={title} />
                  <div class="drawing-settings-row-inputs">
                    <ColorThicknessPicker color={cur().color} width={cur().width} lineStyle={cur().style} onColor={(c) => patchLine({ color: c })} onWidth={(w) => patchLine({ width: w })} onLineStyle={(x) => patchLine({ style: x })} />
                  </div>
                </div>
              );
            }}
          </For>
        );
      case "regressionExtend":
        return <CheckboxRow checked={!!st().extendRight} onChange={(v) => patchStyle({ extendRight: v })} label="Extend lines" />;
      case "pearsons":
        return <CheckboxRow checked={st().showPearsons !== false} onChange={(v) => patchStyle({ showPearsons: v })} label="Pearson's R" />;
      // Bars pattern: Mode, Mirrored, Flipped.
      case "barPattern":
        return (
          <>
            <DialogRow label="Mode">
              <Dropdown
                value={BAR_PATTERN_MODE_LABELS[Math.max(0, BAR_PATTERN_MODE_VALUES.indexOf((st().patternMode ?? "bars") as (typeof BAR_PATTERN_MODE_VALUES)[number]))]}
                options={[...BAR_PATTERN_MODE_LABELS]}
                onChange={(v) => {
                  const i = BAR_PATTERN_MODE_LABELS.indexOf(v as (typeof BAR_PATTERN_MODE_LABELS)[number]);
                  if (i >= 0) patchStyle({ patternMode: BAR_PATTERN_MODE_VALUES[i] });
                }}
              />
            </DialogRow>
            <CheckboxRow checked={!!st().mirrored} onChange={(v) => patchStyle({ mirrored: v })} label="Mirrored" />
            <CheckboxRow checked={!!st().flipped} onChange={(v) => patchStyle({ flipped: v })} label="Flipped" />
          </>
        );
      // Ghost feed Style: Candles (up / down), [x] Borders (up / down),
      // [x] Wick (colour), Transparency (factory 50).
      case "ghostFeed": {
        const cs = () => st().ghostCandle ?? GHOST_CANDLE_DEFAULTS;
        const patchCandle = (patch: Partial<GhostCandleStyle>) => patchStyle({ ghostCandle: { ...cs(), ...patch } });
        return (
          <>
            <DialogRow label="Candles">
              <DialogColorButton color={cs().upColor} onColor={(c) => patchCandle({ upColor: c })} />
              <DialogColorButton color={cs().downColor} onColor={(c) => patchCandle({ downColor: c })} />
            </DialogRow>
            <div class="drawing-settings-row">
              <CheckboxRow checked={cs().drawBorder} onChange={(v) => patchCandle({ drawBorder: v })} label="Borders" />
              <div class="drawing-settings-row-inputs">
                <DialogColorButton color={cs().borderUpColor} onColor={(c) => patchCandle({ borderUpColor: c })} />
                <DialogColorButton color={cs().borderDownColor} onColor={(c) => patchCandle({ borderDownColor: c })} />
              </div>
            </div>
            <div class="drawing-settings-row">
              <CheckboxRow checked={cs().drawWick} onChange={(v) => patchCandle({ drawWick: v })} label="Wick" />
              <div class="drawing-settings-row-inputs">
                <DialogColorButton color={cs().wickColor} onColor={(c) => patchCandle({ wickColor: c })} />
              </div>
            </div>
            <DialogRow label="Transparency">
              <TransparencySlider value={st().transparency ?? 50} onChange={(t) => patchStyle({ transparency: t })} />
            </DialogRow>
          </>
        );
      }
      // Fib time zone / trend-based fib time "Labels": check box +
      // horizontal + vertical (not swapped: stored top = "Top").
      case "ftzLabels":
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={st().showLabels !== false} onChange={(v) => patchStyle({ showLabels: v })} label="Labels" />
            <div class="drawing-settings-row-inputs">
              <Dropdown value={capitalize(st().horzLabelsAlign ?? "right")} options={["Left", "Center", "Right"]} onChange={(v) => patchStyle({ horzLabelsAlign: v.toLowerCase() as "left" | "center" | "right" })} />
              <Dropdown value={capitalize(st().vertLabelsAlign ?? "bottom")} options={["Top", "Middle", "Bottom"]} onChange={(v) => patchStyle({ vertLabelsAlign: v.toLowerCase() as "top" | "middle" | "bottom" })} />
            </div>
          </div>
        );
      // Price note Style: Label text (colour, size, B, I), Label
      // background, Label border, Line color.
      case "priceNote":
        return (
          <>
            <DialogRow label="Label text">
              <div class="drawing-settings-text-format">
                <DialogColorButton color={st().priceLabelTextColor ?? "#ffffff"} onColor={(c) => patchStyle({ priceLabelTextColor: c })} />
                <Dropdown value={String(st().priceLabelFontSize ?? 12)} options={sizeOptions(FONT_SIZES, String(st().priceLabelFontSize ?? 12))} onChange={(v) => patchStyle({ priceLabelFontSize: Number(v) })} />
                <FontStyleToggles bold={!!st().priceLabelBold} italic={!!st().priceLabelItalic} onBold={(v) => patchStyle({ priceLabelBold: v })} onItalic={(v) => patchStyle({ priceLabelItalic: v })} />
              </div>
            </DialogRow>
            <DialogRow label="Label background">
              <DialogColorButton color={st().priceLabelBackgroundColor ?? "#2962ff"} onColor={(c) => patchStyle({ priceLabelBackgroundColor: c })} />
            </DialogRow>
            <DialogRow label="Label border">
              <DialogColorButton color={st().priceLabelBorderColor ?? "#2962ff"} onColor={(c) => patchStyle({ priceLabelBorderColor: c })} />
            </DialogRow>
            <DialogRow label="Line color">
              <DialogColorButton color={st().color} onColor={(c) => patchStyle({ color: c })} />
            </DialogRow>
          </>
        );
      // Long / short position Style: Lines, Stop / Target color, Text,
      // Price labels, Info (Stats, Compact stats mode, Always show stats).
      case "position":
        return (
          <>
            <DialogRow label="Lines">
              <ColorThicknessPicker color={st().color} width={st().width} onColor={(c) => patchStyle({ color: c })} onWidth={(w) => patchStyle({ width: w })} />
            </DialogRow>
            <For each={[["Stop color", "stopColor", "stopTransparency", "#f23645"], ["Target color", "targetColor", "targetTransparency", "#089981"]] as const}>
              {([title, ck, tk, dflt]) => (
                <DialogRow label={title}>
                  <DialogColorButton
                    color={applyOpacity(parseColor(st()[ck] ?? dflt).hex, 100 - (st()[tk] ?? 80))}
                    onColor={(c) => {
                      const pc = parseColor(c);
                      patchStyle({ [ck]: pc.hex, [tk]: 100 - pc.opacity } as Partial<DrawingStyle>);
                    }}
                  />
                </DialogRow>
              )}
            </For>
            <DialogRow label="Text">
              <div class="drawing-settings-text-format">
                <DialogColorButton color={st().textColor ?? "#ffffff"} onColor={(c) => patchStyle({ textColor: c })} />
                <Dropdown value={String(st().fontSize ?? 12)} options={sizeOptions(FONT_SIZES, String(st().fontSize ?? 12))} onChange={(v) => patchStyle({ fontSize: Number(v) })} />
              </div>
            </DialogRow>
            <CheckboxRow checked={st().showPriceLabels !== false} onChange={(v) => patchStyle({ showPriceLabels: v })} label="Price labels" />
            <div class="drawing-settings-section-title">INFO</div>
            <DialogRow label="Stats">
              <StatsMultiSelect
                fields={POSITION_STATS.map(([k, t]) => [k, t] as const)}
                isOn={(k) => positionStatOn(st(), k as PositionStatKey)}
                onToggle={(k, v) => patchStyle({ positionStats: { ...st().positionStats, [k]: v } })}
              />
            </DialogRow>
            <CheckboxRow checked={!!st().compactStats} onChange={(v) => patchStyle({ compactStats: v })} label="Compact stats mode" />
            <CheckboxRow checked={!!st().showStats} onChange={(v) => patchStyle({ showStats: v })} label="Always show stats" />
            <div class="drawing-settings-group-sep" />
          </>
        );
      // Flat top/bottom, disjoint channel: [x] Prices (colour, size, B, I).
      case "channelPrices":
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={!!st().showPrices} onChange={(v) => patchStyle({ showPrices: v })} label="Prices" />
            <div class="drawing-settings-row-inputs drawing-settings-text-format">
              <DialogColorButton color={st().priceLabelTextColor ?? st().color} onColor={(c) => patchStyle({ priceLabelTextColor: c })} />
              <Dropdown value={String(st().priceLabelFontSize ?? 12)} options={sizeOptions(FONT_SIZES, String(st().priceLabelFontSize ?? 12))} onChange={(v) => patchStyle({ priceLabelFontSize: Number(v) })} />
              <FontStyleToggles bold={!!st().priceLabelBold} italic={!!st().priceLabelItalic} onBold={(v) => patchStyle({ priceLabelBold: v })} onItalic={(v) => patchStyle({ priceLabelItalic: v })} />
            </div>
          </div>
        );
      // Range tools: Extend = a list of two checks (price range left /
      // right, date range top / bottom; "Don't extend" when none).
      case "rangeExtend": {
        const fields: [string, string][] = kind() === "date-range" ? [["extendTop", "Extend top"], ["extendBottom", "Extend bottom"]] : [["extendLeft", "Extend left"], ["extendRight", "Extend right"]];
        return (
          <DialogRow label="Extend">
            <StatsMultiSelect fields={fields} emptyLabel="Don't extend" isOn={(k) => !!st()[k as keyof DrawingStyle]} onToggle={(k, v) => patchStyle({ [k]: v } as Partial<DrawingStyle>)} />
          </DialogRow>
        );
      }
      // Range tools Info: Stats (price range: Price range, Percent change,
      // Change in pips; date range: Bars range, Date/time range, Volume;
      // date and price range: all six; factory all on).
      case "rangeStats": {
        const price: [string, string][] = [["showPriceRange", "Price range"], ["showPercentPriceRange", "Percent change"], ["showPipsPriceRange", "Change in pips"]];
        const date: [string, string][] = [["showBarsRange", "Bars range"], ["showDateTimeRange", "Date/time range"], ["showVolume", "Volume"]];
        const fields = kind() === "price-range" ? price : kind() === "date-range" ? date : [...price, ...date];
        return (
          <>
            <div class="drawing-settings-section-title">Info</div>
            <DialogRow label="Stats">
              <StatsMultiSelect fields={fields} isOn={(k) => st()[k as keyof DrawingStyle] !== false} onToggle={(k, v) => patchStyle({ [k]: v } as Partial<DrawingStyle>)} />
            </DialogRow>
          </>
        );
      }
      // Range tools: Label (colour + size), [x] Label background.
      case "rangeLabel":
        return (
          <>
            <DialogRow label="Label">
              <DialogColorButton color={st().textColor ?? "#ffffff"} onColor={(c) => patchStyle({ textColor: c })} />
              <Dropdown value={String(st().fontSize ?? 12)} options={sizeOptions(FONT_SIZES, String(st().fontSize ?? 12))} onChange={(v) => patchStyle({ fontSize: Number(v) })} />
            </DialogRow>
            <div class="drawing-settings-row">
              <CheckboxRow checked={st().fillLabelBackground !== false} onChange={(v) => patchStyle({ fillLabelBackground: v })} label="Label background" />
              <div class="drawing-settings-row-inputs">
                <DialogColorButton color={st().labelBackgroundColor ?? "#2e2e2e"} onColor={(c) => patchStyle({ labelBackgroundColor: c })} />
              </div>
            </div>
            <div class="drawing-settings-group-sep" />
          </>
        );
      // Date and price range: [x] Border (colour + width; factory off,
      // ot-blue-500, 1px).
      case "rangeBorder":
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={!!st().drawBorder} onChange={(v) => patchStyle({ drawBorder: v })} label="Border" />
            <div class="drawing-settings-row-inputs">
              <ColorThicknessPicker color={st().borderColor ?? st().color} width={st().borderWidth ?? 1} onColor={(c) => patchStyle({ borderColor: c })} onWidth={(w) => patchStyle({ borderWidth: w })} />
            </div>
          </div>
        );
      // Signpost Style: [x] Emoji pin (showImage) + the plate colour.
      case "emojiPin":
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={!!st().showImage} onChange={(v) => patchStyle({ showImage: v })} label="Emoji pin" />
            <div class="drawing-settings-row-inputs">
              <DialogColorButton color={st().plateColor ?? "#2962ff"} onColor={(c) => patchStyle({ plateColor: c })} />
            </div>
          </div>
        );
      // Note Style: [x] Label background, [x] Label
      // border, Line color.
      case "noteLabel":
        return (
          <>
            <div class="drawing-settings-row">
              <CheckboxRow checked={st().fillBackground !== false} onChange={(v) => patchStyle({ fillBackground: v })} label="Label background" />
              <div class="drawing-settings-row-inputs">
                <DialogColorButton color={st().backgroundColor ?? "#2e2e2e"} onColor={(c) => patchStyle({ backgroundColor: c })} />
              </div>
            </div>
            <div class="drawing-settings-row">
              <CheckboxRow checked={!!st().drawBorder} onChange={(v) => patchStyle({ drawBorder: v })} label="Label border" />
              <div class="drawing-settings-row-inputs">
                <DialogColorButton color={st().borderColor ?? "#4a4a4a"} onColor={(c) => patchStyle({ borderColor: c })} />
              </div>
            </div>
            <DialogRow label="Line color">
              <DialogColorButton color={st().color} onColor={(c) => patchStyle({ color: c })} />
            </DialogRow>
          </>
        );
      // Price label Style: Text (colour + size), Background (its opacity =
      // transparency), Border.
      case "priceLabelTool":
        return (
          <>
            <DialogRow label="Text">
              <DialogColorButton color={st().textColor ?? "#ffffff"} onColor={(c) => patchStyle({ textColor: c })} />
              <Dropdown value={String(st().fontSize ?? 14)} options={sizeOptions(FONT_SIZES, String(st().fontSize ?? 14))} onChange={(v) => patchStyle({ fontSize: Number(v) })} />
            </DialogRow>
            <DialogRow label="Background">
              <DialogColorButton
                color={applyOpacity(parseColor(st().backgroundColor ?? st().color).hex, 100 - (st().transparency ?? 0))}
                onColor={(c) => {
                  const pc = parseColor(c);
                  patchStyle({ backgroundColor: pc.hex, transparency: 100 - pc.opacity });
                }}
              />
            </DialogRow>
            <DialogRow label="Border">
              <DialogColorButton color={st().borderColor ?? st().color} onColor={(c) => patchStyle({ borderColor: c })} />
            </DialogRow>
          </>
        );
      default:
        return null;
    }
  }

  return <For each={styleRowsFor(kind())}>{(id) => styleRow(id)}</For>;
}
