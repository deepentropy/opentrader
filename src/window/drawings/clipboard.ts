/*
 * In-app drawing clipboard — Copy (Ctrl+C) / Paste (Ctrl+V) for drawings.
 * Holds one drawing snapshot; paste returns an id-less payload that goes
 * through the normal add path (same data coords, fresh id, never locked,
 * hidden, or interval-restricted on arrival).
 */
import { createSignal } from "solid-js";
import type { Drawing, NewDrawing } from "lightweight-charts-drawing/core/types";
import { labelForKind } from "./labels";

/** Marker of a copied drawing in the system clipboard HTML. Copy writes the
 *  drawing to the system clipboard (text = its title, html = the app data),
 *  so a paste can tell whether the newest clipboard content is a drawing or
 *  something copied elsewhere (an image, pasted as an Image drawing). */
export const DRAWING_CLIP_MARK = "data-opentrader-drawing";

const [clip, setClip] = createSignal<Drawing | null>(null);

export const hasClipboardDrawing = (): boolean => clip() !== null;

export function copyDrawing(d: Drawing): void {
  setClip(JSON.parse(JSON.stringify(d)) as Drawing);
  // Copy path: a capturing "copy" listener fills the
  // system clipboard during document.execCommand("copy").
  const onCopy = (e: ClipboardEvent) => {
    e.stopImmediatePropagation();
    e.preventDefault();
    e.clipboardData?.setData("text/plain", labelForKind(d.kind));
    e.clipboardData?.setData("text/html", `<meta ${DRAWING_CLIP_MARK}="${d.id}">`);
  };
  document.addEventListener("copy", onCopy, true);
  try {
    document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", onCopy, true);
  }
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
