/*
 * Icon — renders an SVG icon.
 *
 * Icons live in `src/assets/icons/` and are loaded as raw text via Vite's
 * `?raw` glob — every file there is bundled at build time and addressed
 * by its basename (e.g. `header-settings.svg` → `'header-settings'`).
 *
 * When a `size` is given, the SVG's literal width/height attrs are stripped
 * so our square wrapper's dimensions win.  When `size` is omitted, the icon
 * renders at its own intrinsic width/height — used for icons that aren't on
 * the standard 28×28 grid (e.g. the layout-setup glyph is 21×19),
 * so forcing them into a 28px box makes them look oversized.
 *
 * Either way viewBox + `fill="currentColor"` are preserved so color inherits
 * from the parent via CSS `color`.
 */
import type { JSX } from "solid-js";

const RAW_ICONS = import.meta.glob("../assets/icons/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const REGISTRY: Record<string, string> = {};
for (const [path, content] of Object.entries(RAW_ICONS)) {
  const name = path.split("/").pop()!.replace(/\.svg$/, "");
  REGISTRY[name] = content;
}

export type IconName = string;

type Props = {
  name: IconName;
  size?: number;
  class?: string;
  title?: string;
};

export function Icon(props: Props) {
  const svg = () => {
    const raw = REGISTRY[props.name];
    if (!raw) return "";
    // No explicit size → keep the icon's own width/height (intrinsic render).
    if (props.size === undefined) return raw;
    return raw.replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
      const cleaned = attrs
        .replace(/\swidth="[^"]*"/, "")
        .replace(/\sheight="[^"]*"/, "");
      return `<svg${cleaned} width="100%" height="100%">`;
    });
  };
  const style = (): JSX.CSSProperties => ({
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    width: props.size ? `${props.size}px` : undefined,
    height: props.size ? `${props.size}px` : undefined,
    color: "inherit",
  });
  return (
    <span
      class={props.class}
      style={style()}
      role={props.title ? "img" : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : true}
      innerHTML={svg()}
    />
  );
}
