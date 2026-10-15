/*
 * Text page of the drawing Settings dialog: the text format row (colour,
 * size, bold, italic), the text box, alignment / orientation, and the
 * Background / Border / Text wrap rows of the text tools.
 */
import { Show, type JSX } from "solid-js";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { applyOpacity, parseColor } from "../ColorPanel";
import { CheckboxRow, ColorThicknessPicker, DialogColorButton, DialogRow, Dropdown, FontStyleToggles } from "./controls";
import {
  capitalize,
  FONT_SIZES,
  labelVertDefault,
  LINE_LABEL_KINDS,
  RANGE_TEXT_KINDS,
  SHAPE_TEXT_KINDS,
  sizeOptions,
  TEXT_ANNOTATION_KINDS,
  TEXT_BORDER_DEFAULT,
  TEXT_BOX_TRANSPARENCY,
  TEXT_KINDS,
  vertAlignFromTitle,
  vertTitle,
} from "./kind-config";
import { type SettingsCx } from "./context";

export function textTab(cx: SettingsCx): JSX.Element {
  const { kind, patchStyle, props } = cx;
  // Text-tab plumbing — annotations + shapes keep their string at the top
  // level; line labels keep it on the style. Annotations colour via the main
  // `color`, everything else via `textColor`.
  const isAnnotation = () => TEXT_ANNOTATION_KINDS.has(kind());
  const isTopLevelText = () => isAnnotation() || SHAPE_TEXT_KINDS.has(kind());
  const textValue = () => (isTopLevelText() ? props.drawing.text : props.drawing.style.text) ?? "";
  const setText = (v: string) =>
    isTopLevelText()
      ? props.onUpdate({ ...props.drawing, text: v } as Drawing)
      : patchStyle({ text: v });
  // Text colour: annotation kinds colour their text with `color`, except the
  // callout (its bubble is `color`, the text `textColor`); range tools use
  // their own custom-text fields (`customText`).
  const isRangeText = () => RANGE_TEXT_KINDS.has(kind());
  // Text tool: the text colour is its `color`; the other annotation
  // tools keep a separate text colour.
  const textInColor = () => kind() === "text";
  const textColorValue = () =>
    (isRangeText()
      ? props.drawing.style.customTextColor ?? "#2962ff"
      : textInColor() ? props.drawing.style.color : props.drawing.style.textColor ?? props.drawing.style.color) ?? "#ffffff";
  const setTextColor = (c: string) =>
    isRangeText() ? patchStyle({ customTextColor: c }) : textInColor() ? patchStyle({ color: c }) : patchStyle({ textColor: c });
  const textSize = () => (isRangeText() ? props.drawing.style.customTextSize ?? 12 : props.drawing.style.fontSize ?? 14);
  const setTextSize = (v: number) => (isRangeText() ? patchStyle({ customTextSize: v }) : patchStyle({ fontSize: v }));
  const textBold = () => !!(isRangeText() ? props.drawing.style.customTextBold : props.drawing.style.bold);
  const toggleBold = () => (isRangeText() ? patchStyle({ customTextBold: !textBold() }) : patchStyle({ bold: !textBold() }));
  const textItalic = () => !!(isRangeText() ? props.drawing.style.customTextItalic : props.drawing.style.italic);
  const toggleItalic = () => (isRangeText() ? patchStyle({ customTextItalic: !textItalic() }) : patchStyle({ italic: !textItalic() }));

  return (
    <Show
      when={TEXT_KINDS.has(kind())}
      fallback={<div class="drawing-settings-section-title">No text options for this drawing.</div>}
    >
      {/* Formatting toolbar — colour, font size, bold, italic — sits
          ABOVE the text box (text-properties layout). Single
          no-wrap row so "Font size" never breaks onto two lines. */}
      <div class="drawing-settings-text-format">
        <Show when={kind() === "note" || kind() === "comment"}>
          <span class="drawing-settings-row-label">Text</span>
        </Show>
        <Show when={kind() !== "signpost"}>
          <DialogColorButton color={textColorValue()} onColor={setTextColor} />
        </Show>
        <Dropdown
          value={String(textSize())}
          options={sizeOptions(FONT_SIZES, String(textSize()))}
          onChange={(v) => setTextSize(Number(v))}
        />
        <Show when={kind() !== "comment"}>
          <FontStyleToggles bold={textBold()} italic={textItalic()} onBold={() => toggleBold()} onItalic={() => toggleItalic()} />
        </Show>
      </div>
      {/* Text box: 9 lines for the Text and Callout tools, 5 for
          the others. */}
      <textarea
        class={"drawing-settings-textarea" + (kind() === "text" || kind() === "callout" ? " tall" : "")}
        rows={kind() === "text" || kind() === "callout" ? 9 : 5}
        placeholder="Add text"
        value={textValue()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      {/* arrow-marker anchors its text to the arrow direction — no
          alignment options. */}
      <Show when={(LINE_LABEL_KINDS.has(kind()) && kind() !== "arrow-marker") || kind() === "price-note" || kind() === "rectangle"}>
        <DialogRow label="Text alignment">
          <Dropdown
            value={vertTitle(props.drawing.style.vertLabelsAlign ?? labelVertDefault(kind()), kind())}
            options={["Top", kind() === "rectangle" ? "Inside" : "Middle", "Bottom"]}
            onChange={(v) => patchStyle({ vertLabelsAlign: vertAlignFromTitle(v) })}
          />
          <Dropdown
            value={capitalize(props.drawing.style.horzLabelsAlign ?? "center")}
            options={["Left", "Center", "Right"]}
            onChange={(v) => patchStyle({ horzLabelsAlign: v.toLowerCase() as "left" | "center" | "right" })}
          />
        </DialogRow>
      </Show>
      {/* Vertical line "Text orientation" (factory Vertical). */}
      <Show when={kind() === "vertical-line"}>
        <DialogRow label="Text orientation">
          <Dropdown
            value={props.drawing.style.textOrientation === "horizontal" ? "Horizontal" : "Vertical"}
            options={["Vertical", "Horizontal"]}
            onChange={(v) => patchStyle({ textOrientation: v === "Horizontal" ? "horizontal" : "vertical" })}
          />
        </DialogRow>
      </Show>
    </Show>
  );
}

/** Text tools, Text page rows after the text (see the dialog's call site). */
export function textBoxRows(cx: SettingsCx): JSX.Element {
  const { kind, patchStyle, props } = cx;
  const st = () => props.drawing.style;
  const bgColor = () => applyOpacity(parseColor(st().backgroundColor ?? (kind() === "callout" ? st().color : "#2962ff")).hex, 100 - (st().transparency ?? TEXT_BOX_TRANSPARENCY[kind()] ?? 0));
  const setBg = (c: string) => {
    const pc = parseColor(c);
    patchStyle({ backgroundColor: pc.hex, transparency: 100 - pc.opacity });
  };
  const checked = kind() === "text" || kind() === "pin";
  return (
    <>
      <div class="drawing-settings-row">
        <Show when={checked} fallback={<div class="drawing-settings-row-label">Background</div>}>
          <CheckboxRow checked={kind() === "pin" ? st().fillBackground !== false : !!st().fillBackground} onChange={(v) => patchStyle({ fillBackground: v })} label="Background" />
        </Show>
        <div class="drawing-settings-row-inputs">
          <DialogColorButton color={bgColor()} onColor={setBg} />
        </div>
      </div>
      <div class="drawing-settings-row">
        <Show when={checked} fallback={<div class="drawing-settings-row-label">Border</div>}>
          <CheckboxRow checked={!!st().drawBorder} onChange={(v) => patchStyle({ drawBorder: v })} label="Border" />
        </Show>
        <div class="drawing-settings-row-inputs">
          <Show
            when={kind() === "callout"}
            fallback={<DialogColorButton color={st().borderColor ?? TEXT_BORDER_DEFAULT[kind()] ?? st().color} onColor={(c) => patchStyle({ borderColor: c })} />}
          >
            <ColorThicknessPicker color={st().borderColor ?? st().color} width={st().width} onColor={(c) => patchStyle({ borderColor: c })} onWidth={(w) => patchStyle({ width: w })} />
          </Show>
        </div>
      </div>
      <Show when={kind() === "text" || kind() === "callout"}>
        <CheckboxRow checked={!!st().wordWrap} onChange={(v) => patchStyle({ wordWrap: v })} label="Text wrap" />
      </Show>
    </>
  );
}
