/*
 * In-app clipboard — Copy (Ctrl+C) / Paste (Ctrl+V). Holds one copied
 * object: a drawing, or a source of a chart (a study or a compared symbol,
 * study menu "Copy"); a copy replaces what it held. A drawing paste returns
 * an id-less payload that goes through the normal add path (same data
 * coords, fresh id, never locked, hidden, or interval-restricted on
 * arrival); a source paste adds a copy of the source to the chart.
 */
import { createSignal } from "solid-js";
import type { Drawing, NewDrawing } from "lightweight-charts-drawing/core/types";
import type { CompareEntry, PaneIndicatorSettings } from "../shell/tabs";
import { labelForKind } from "./labels";

/** Marker of a copied drawing in the system clipboard HTML. Copy writes the
 *  drawing to the system clipboard (text = its title, html = the app data),
 *  so a paste can tell whether the newest clipboard content is a drawing or
 *  something copied elsewhere (an image, pasted as an Image drawing). */
export const DRAWING_CLIP_MARK = "data-opentrader-drawing";

/** Marker of a copied source in the system clipboard HTML (same use as
 *  DRAWING_CLIP_MARK). */
export const SOURCE_CLIP_MARK = "data-opentrader-source";

/** A copied source: a study (its type and settings) or a compared symbol. */
export type ClipboardSource =
  | { kind: "study"; typeId: string; title: string; settings: PaneIndicatorSettings }
  | { kind: "compare"; title: string; entry: CompareEntry };

const [clip, setClip] = createSignal<Drawing | null>(null);
const [clipSource, setClipSource] = createSignal<ClipboardSource | null>(null);

export const hasClipboardDrawing = (): boolean => clip() !== null;
/** Something to paste: a drawing or a source. */
export const hasClipboardContent = (): boolean => clip() !== null || clipSource() !== null;
/** The copied source (a copy of it), or null. */
export const clipboardSource = (): ClipboardSource | null => {
  const s = clipSource();
  return s ? (JSON.parse(JSON.stringify(s)) as ClipboardSource) : null;
};

/** Fill the system clipboard (text = the object's title, html = our marker)
 *  through a capturing "copy" listener during document.execCommand("copy"). */
function writeSystemClipboard(text: string, html: string): void {
  const onCopy = (e: ClipboardEvent) => {
    e.stopImmediatePropagation();
    e.preventDefault();
    e.clipboardData?.setData("text/plain", text);
    e.clipboardData?.setData("text/html", html);
  };
  document.addEventListener("copy", onCopy, true);
  try {
    document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", onCopy, true);
  }
}

export function copyDrawing(d: Drawing): void {
  setClip(JSON.parse(JSON.stringify(d)) as Drawing);
  setClipSource(null);
  writeSystemClipboard(labelForKind(d.kind), `<meta ${DRAWING_CLIP_MARK}="${d.id}">`);
}

/** Copy a source of a chart (study menu "Copy", Ctrl+C on a selected study). */
export function copySource(src: ClipboardSource): void {
  setClipSource(JSON.parse(JSON.stringify(src)) as ClipboardSource);
  setClip(null);
  writeSystemClipboard(src.title, `<meta ${SOURCE_CLIP_MARK}="${src.kind}">`);
}

export function pasteAsNew(): NewDrawing | null {
  const d = clip();
  if (!d) return null;
  const copy = JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
  delete copy.id;
  delete copy.locked;
  delete copy.hidden;
  // Drop the per-interval Visibility matrix so the paste shows on whatever
  // interval it lands on — otherwise a "days-only" source pasted on a 5m chart
  // appends an invisible, unselectable duplicate every time.
  delete copy.visibility;
  // A paste lands in the main series pane, like a paste from the chart
  // (same data coordinates, the main price scale).
  delete copy.owner;
  return copy as unknown as NewDrawing;
}
