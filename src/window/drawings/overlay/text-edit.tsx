/*
 * Inline text editor of the drawings overlay: the text of a new text-family
 * drawing, a re-edited annotation, or a fib level's text.
 */
import { createSignal, Show, type JSX } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import { defaultStyleFor, FIB_LEVEL_DEFAULTS } from "lightweight-charts-drawing/core/specs";
import type { DataPoint, Drawing } from "lightweight-charts-drawing/core/types";
import type { Pt } from "lightweight-charts-drawing/core/_shared";
import { buildNewDrawing } from "lightweight-charts-drawing/core/interact/placement";
import { signpostPositionFor } from "lightweight-charts-drawing/core/kinds/signpost";
import { TEXT_PLACEHOLDER } from "lightweight-charts-drawing/core/kinds/text-tools";
import { type OverlayCx } from "./context";

/** Inline text editor for the text-annotation family. `mode: "create"` commits
 *  a brand-new drawing on Enter/blur; `mode: "edit"` rewrites an existing one's
 *  `text`. `pos` is the editor's screen anchor (relative to the SVG box). */
export type TextEditState = {
  mode: "create" | "edit";
  id?: string;
  kind: import("lightweight-charts-drawing/core/types").DrawingKind;
  points: DataPoint[];
  pos: Pt;
  value: string;
  /** Pane of a create-mode placement (Frame key). */
  frameKey?: string | null;
  /** Fib level text: the level's index in the drawing's level list (the
   *  editor writes `levels[i].text`, one line, 50 characters at most). */
  level?: number;
};

/** What createTextEdit adds to the overlay context. */
export interface TextEditApi {
  TextEditor: () => JSX.Element;
  cancelTextEdit: () => void;
  commitTextEdit: () => void;
  holdTextFocus: boolean;
  setTextEdit: Setter<TextEditState | null>;
  textAnchorScreen: (d: Drawing, pts: Pt[]) => Pt;
  textEdit: Accessor<TextEditState | null>;
  readonly textInput: HTMLInputElement | undefined;
}

export function createTextEdit(cx: OverlayCx): TextEditApi {
  const { props } = cx;
  /** True between the placement pointerdown that opened a create-mode editor
   *  and its pointerup (see onPlacementClick). */
  let holdTextFocus = false;
  let textInput: HTMLInputElement | undefined;
  const [textEdit, setTextEdit] = createSignal<TextEditState | null>(null);

  /** Commit the inline text editor — create a new text drawing (with the typed
   *  string) or rewrite an existing one's text. */
  function commitTextEdit() {
    const te = textEdit();
    if (!te) return;
    setTextEdit(null);
    const text = te.value;
    if (te.mode === "create") {
      const f = cx.frameByKey(te.frameKey);
      let placed = f ? buildNewDrawing(te.kind, te.points) : null;
      // Signpost: the click height sets the label position.
      if (placed && f && te.kind === "signpost") {
        placed = { ...placed, style: { ...defaultStyleFor("signpost"), signpostPosition: signpostPositionFor(f.coords, te.points[0], f.dims.h) } };
      }
      if (placed && f) cx.placeNew({ ...placed, text }, f);
      if (!props.stayMode) props.onDisarm();
    } else if (te.id) {
      const d = props.drawings.find((x) => x.id === te.id);
      if (d && te.level != null) {
        const levels = (d.style.levels ?? FIB_LEVEL_DEFAULTS).map((l) => ({ ...l }));
        if (levels[te.level]) levels[te.level] = { ...levels[te.level], text: text.slice(0, 50) };
        props.onUpdate({ ...d, style: { ...d.style, levels } });
      } else if (d) props.onUpdate({ ...d, text });
    }
  }

  /** Dismiss the editor without committing — in create mode this drops the
   *  half-placed drawing and disarms. */
  function cancelTextEdit() {
    const te = textEdit();
    if (!te) return;
    // Escape closes a NEW text's editor but keeps the drawing (selected).
    if (te.mode === "create") { commitTextEdit(); return; }
    setTextEdit(null);
  }

  /** Screen anchor for a text drawing's editor: the click point for 1-point
   *  kinds, the balloon centre (2nd point) for callout. */
  function textAnchorScreen(d: Drawing, pts: Pt[]): Pt {
    if ((d.kind === "callout" || d.kind === "note") && pts[1]) return pts[1];
    if (d.kind === "price-note" && pts[1]) {
      return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    }
    return pts[0];
  }

  /** The inline text editor input. */
  function TextEditor() {
    return (
      <Show when={textEdit()}>
        {(te) => (
          <input
            ref={(el) => { textInput = el; queueMicrotask(() => { el.focus(); el.select(); }); }}
            class="ot-drawing-text-input"
            value={te().value}
            maxLength={te().level != null ? 50 : undefined}
            placeholder={TEXT_PLACEHOLDER[te().kind] ?? "Text"}
            style={{
              position: "absolute",
              left: `${te().pos.x}px`,
              top: `${te().pos.y - 12}px`,
              "z-index": 6,
            }}
            onInput={(e) => {
              const cur = textEdit();
              if (cur) setTextEdit({ ...cur, value: e.currentTarget.value });
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commitTextEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelTextEdit();
              }
            }}
            onBlur={() => { if (!holdTextFocus) commitTextEdit(); }}
          />
        )}
      </Show>
    );
  }

  return {
    TextEditor,
    cancelTextEdit,
    commitTextEdit,
    get holdTextFocus() { return holdTextFocus; }, set holdTextFocus(v: boolean) { holdTextFocus = v; },
    setTextEdit,
    textAnchorScreen,
    textEdit,
    get textInput() { return textInput; },
  };
}
