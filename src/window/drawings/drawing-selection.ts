/*
 * Selected drawings of the window. Multi-select (Ctrl/Cmd+click adds to the
 * selection); the list is ordered and its LAST id is the primary one — it
 * anchors the floating toolbar and the single-drawing surfaces (settings,
 * Object tree highlight), read through `selectedDrawingId`. Module-level
 * signal: one App per window, shared by the tab operations (a tab switch
 * drops it), the drawing store and the keyboard shortcuts.
 */
import { createSignal } from "solid-js";

const [selectedDrawingIds, setSelectedDrawingIds] = createSignal<string[]>([]);
export { selectedDrawingIds, setSelectedDrawingIds };

export const selectedDrawingId = (): string | null => {
  const a = selectedDrawingIds();
  return a.length ? a[a.length - 1] : null;
};

export const setSelectedDrawingId = (id: string | null): void => {
  setSelectedDrawingIds(id ? [id] : []);
};

export const toggleSelectedDrawing = (id: string): void => {
  setSelectedDrawingIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
};
