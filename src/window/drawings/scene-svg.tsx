/*
 * SVG host of the shared drawing scenes (lightweight-charts-drawing/tv/scene):
 * one SVG element per scene item, same elements and attributes as the
 * former hand-written renderers (checked by golden render
 * runs). Anchors are drawn by the overlay's Handles (hover ring, cursor,
 * selected-state stroke).
 */
import { createUniqueId, type JSX } from "solid-js";
import type { Paint, SceneItem, Shadow } from "lightweight-charts-drawing/tv/scene/types";
import type { Pt } from "lightweight-charts-drawing/tv/_shared";

type HandlesFn = (props: { pts: Pt[]; color: string; squares?: readonly number[] }) => JSX.Element;

const pe = (inert?: boolean): "none" | undefined => (inert ? "none" : undefined);
const px = (v: number) => (v === 0 ? "0" : `${v}px`);
const dropShadow = (sh: Shadow) => `drop-shadow(${px(sh.dx)} ${px(sh.dy)} ${px(sh.blur)} ${sh.color})`;

/** Scene items as SVG. `Handles` draws the anchor items; clip names map to
 *  ids unique per call. */
export function sceneSvg(items: SceneItem[], Handles: HandlesFn, color: string): JSX.Element {
  const ids = new Map<string, string>();
  /** url(#id) of a named clip / gradient item. */
  const clipUrl = (name?: string) => {
    if (!name) return undefined;
    const id = ids.get(name);
    return id ? `url(#${id})` : undefined;
  };
  const paintFill = (it: Paint) => (it.fillRef ? clipUrl(it.fillRef) : it.fill);
  const one = (it: SceneItem): JSX.Element => {
    switch (it.t) {
      case "clip": {
        const id = `lblcut-${createUniqueId()}`;
        ids.set(it.name, id);
        const B = 1e5;
        const d = `M ${-B} ${-B} H ${B} V ${B} H ${-B} Z ` + it.polys.map((pl) => `M ${pl.map((q) => `${q.x} ${q.y}`).join(" L ")} Z`).join(" ");
        return (
          <defs>
            <clipPath id={id} clipPathUnits="userSpaceOnUse">
              <path d={d} clip-rule="evenodd" />
            </clipPath>
          </defs>
        );
      }
      case "clipRect": {
        const id = `${it.idPrefix ?? "clip-"}${createUniqueId()}`;
        ids.set(it.name, id);
        return (
          <defs>
            <clipPath id={id}>
              <rect x={it.x} y={it.y} width={it.w} height={it.h} />
            </clipPath>
          </defs>
        );
      }
      case "radialGradient": {
        const id = `${it.idPrefix ?? "grad-"}${createUniqueId()}`;
        ids.set(it.name, id);
        return (
          <defs>
            <radialGradient id={id} gradientUnits="userSpaceOnUse" cx={it.cx} cy={it.cy} r={it.r}>
              {it.stops.map((st) => <stop offset={String(st.offset)} stop-color={st.color} stop-opacity={st.opacity} />)}
            </radialGradient>
          </defs>
        );
      }
      case "hit":
        return <line x1={it.a.x} y1={it.a.y} x2={it.b.x} y2={it.b.y} stroke="transparent" stroke-width={it.width} />;
      case "hitPath":
        return <path d={it.d} fill="none" stroke="transparent" stroke-width={it.width} />;
      case "line":
        return (
          <line
            x1={it.a.x} y1={it.a.y} x2={it.b.x} y2={it.b.y}
            stroke={it.stroke} stroke-width={it.strokeWidth} stroke-opacity={it.strokeOpacity} stroke-dasharray={it.dash}
            stroke-linecap={it.cap} stroke-linejoin={it.join} fill={paintFill(it)} clip-path={clipUrl(it.clip)} pointer-events={pe(it.inert)}
          />
        );
      case "polyline":
      case "polygon": {
        const points = it.pts.map((p) => `${p.x},${p.y}`).join(" ");
        const attrs = {
          points,
          fill: paintFill(it), "fill-opacity": it.fillOpacity, "fill-rule": it.fillRule,
          stroke: it.stroke, "stroke-width": it.strokeWidth, "stroke-opacity": it.strokeOpacity, "stroke-dasharray": it.dash,
          "stroke-linecap": it.cap, "stroke-linejoin": it.join, "clip-path": clipUrl(it.clip), "pointer-events": pe(it.inert),
        };
        return it.t === "polyline" ? <polyline {...attrs} /> : <polygon {...attrs} />;
      }
      case "path":
        return (
          <path
            d={it.d} transform={it.transform}
            fill={paintFill(it)} fill-opacity={it.fillOpacity} fill-rule={it.fillRule}
            stroke={it.stroke} stroke-width={it.strokeWidth} stroke-opacity={it.strokeOpacity} stroke-dasharray={it.dash}
            stroke-linejoin={it.join} stroke-linecap={it.cap} clip-path={clipUrl(it.clip)} pointer-events={pe(it.inert)}
            shape-rendering={it.crisp ? "crispEdges" : undefined} style={{ filter: it.shadow ? dropShadow(it.shadow) : undefined }}
          />
        );
      case "rect":
        return (
          <rect
            x={it.x} y={it.y} width={it.w} height={it.h} rx={it.rx} ry={it.ry}
            fill={paintFill(it)} fill-opacity={it.fillOpacity}
            stroke={it.stroke} stroke-width={it.strokeWidth} stroke-opacity={it.strokeOpacity} stroke-dasharray={it.dash}
            clip-path={clipUrl(it.clip)} pointer-events={pe(it.inert)} style={{ filter: it.shadow ? dropShadow(it.shadow) : undefined }}
          />
        );
      case "circle":
        return (
          <circle
            cx={it.cx} cy={it.cy} r={it.r} fill={paintFill(it)} fill-opacity={it.fillOpacity}
            stroke={it.stroke} stroke-width={it.strokeWidth} stroke-opacity={it.strokeOpacity} stroke-dasharray={it.dash}
            clip-path={clipUrl(it.clip)} pointer-events={pe(it.inert)}
            style={{ cursor: it.cursor, filter: it.shadow ? dropShadow(it.shadow) : undefined }}
          />
        );
      case "ellipse":
        return (
          <ellipse
            cx={it.cx} cy={it.cy} rx={it.rx} ry={it.ry} transform={it.transform} fill={paintFill(it)} fill-opacity={it.fillOpacity}
            stroke={it.stroke} stroke-width={it.strokeWidth} stroke-opacity={it.strokeOpacity} stroke-dasharray={it.dash}
            clip-path={clipUrl(it.clip)} pointer-events={pe(it.inert)}
          />
        );
      case "text":
        return (
          <text
            x={it.x} y={it.y} text-anchor={it.anchor} dominant-baseline={it.baseline}
            font-size={String(it.size)} font-weight={it.weight} font-style={it.fontStyle} font-family={it.family}
            fill={it.fill} opacity={it.opacity} style={it.pre ? { "white-space": "pre" } : undefined} clip-path={clipUrl(it.clip)} pointer-events={pe(it.inert)}
          >
            {it.text}
          </text>
        );
      case "image":
        return (
          <image
            href={it.href} x={it.x} y={it.y} width={it.w} height={it.h} preserveAspectRatio={it.stretch ? "none" : undefined}
            opacity={it.opacity} clip-path={clipUrl(it.clip)} pointer-events={pe(it.inert)}
          />
        );
      case "group":
        return (
          <g transform={it.transform} opacity={it.opacity} clip-path={clipUrl(it.clip)} pointer-events={pe(it.inert)}>
            {it.items.map(one)}
          </g>
        );
      case "glyph": {
        // Emoji / font character, or raw <svg> markup, painted through
        // innerHTML (styles/font-icon-picker.css sizes an <svg> to the box).
        const html = it.glyph.trim().startsWith("<svg")
          ? it.glyph
          : `<span style="font-size:${it.size - 4}px;line-height:${it.size}px">${it.glyph}</span>`;
        return (
          <foreignObject x={it.x} y={it.y} width={it.size} height={it.size} style={{ overflow: "visible" }} pointer-events={pe(it.inert)}>
            {/* eslint-disable-next-line */}
            <div class="drawing-font-icon-glyph" style={{ color: it.color }} innerHTML={html} />
          </foreignObject>
        );
      }
      case "anchors":
        return <Handles pts={it.pts} color={color} squares={it.squares} />;
    }
  };
  return items.map(one);
}
