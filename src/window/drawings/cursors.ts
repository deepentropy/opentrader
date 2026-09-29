/*
 * CSS cursor strings for the drawing-toolbar Cursor group (cross / dot / arrow /
 * eraser). The dot + eraser cursors are built from the SAME captured TV icon
 * SVGs the toolbar uses (`draw-dot.svg`, `draw-eraser.svg`) — imported raw and
 * turned into `data:` cursor URLs — so the on-canvas cursor matches TV's glyph
 * rather than a hand-drawn approximation. `currentColor` is substituted with a
 * concrete colour (cursors have no inherited text colour) and the root width/
 * height are pinned to a cursor-appropriate size.
 *
 * Demonstration keeps the default arrow (TV `.pane--cursor-demonstration {
 * cursor: default }`); the overlay draws TV's red circle around it.
 *
 * Ported from the reference mock.
 */
import dotSvg from "../../assets/icons/draw-dot.svg?raw";
import eraserSvg from "../../assets/icons/draw-eraser.svg?raw";
import type { CursorMode } from "../../data/drawing-toolbar";

/** TV icon grey — the colour the toolbar glyphs render at. */
const GLYPH_COLOR = "#B2B5BE";

/** Build a `url(data:…) hotX hotY, fallback` cursor from a raw captured SVG. */
function dataCursor(raw: string, size: number, hotX: number, hotY: number, fallback: string): string {
  const colored = raw
    .replace(/currentColor/g, GLYPH_COLOR)
    .replace(/<svg\b([^>]*)>/, (_m: string, attrs: string) => {
      const cleaned = attrs.replace(/\swidth="[^"]*"/, "").replace(/\sheight="[^"]*"/, "");
      return `<svg${cleaned} width="${size}" height="${size}">`;
    });
  const uri = `data:image/svg+xml,${encodeURIComponent(colored)}`;
  return `url("${uri}") ${hotX} ${hotY}, ${fallback}`;
}

// Dot: small filled dot, hotspot at its centre.
const DOT_CURSOR = dataCursor(dotSvg, 20, 10, 10, "crosshair");
// Eraser: the glyph's working tip is the lower-left corner of the rubber.
const ERASER_CURSOR = dataCursor(eraserSvg, 26, 5, 21, "auto");

/** Resolve the CSS `cursor` value for the current interaction mode. While a
 *  drawing tool is armed the crosshair always wins regardless of cursor mode. */
export function cursorForMode(mode: CursorMode, armed: boolean): string {
  if (armed) return "crosshair";
  switch (mode) {
    case "dot":
      return DOT_CURSOR;
    case "arrow":
      return "default";
    case "eraser":
      return ERASER_CURSOR;
    case "demonstration":
      return "default";
    case "cross":
    default:
      return "crosshair";
  }
}

/** Demonstration cursor + "Hold Alt" highlighter — TV crosshair demonstration
 *  constants (879505 `rd`: LineWidth 36, CircleBorderWidth 1,
 *  AnimationDuration 4000; `nd` = ripe-red-500 at 25 %, `ad` = at 3 %). */
export const HIGHLIGHTER_COLOR = "#f23645";
export const HIGHLIGHTER_OPACITY = 0.25;
export const HIGHLIGHTER_WIDTH = 36;
export const HIGHLIGHTER_FADE_MS = 4000;
export const DEMO_CURSOR_BORDER_OPACITY = 0.03;
