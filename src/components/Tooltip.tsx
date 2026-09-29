/*
 * Tooltip — TradingView-style hover label.
 *
 * Solid divergence from the React mock: React's version uses cloneElement
 * to attach handlers directly to the child. Solid has no cloneElement, so
 * we wrap children in a `display: contents` span that owns the listeners.
 * That span has no layout box, so we measure
 * `wrapper.firstElementChild.getBoundingClientRect()` for positioning.
 *
 * Visual spec probed from TV (.common-tooltip*-EJBD96zX, 2026-05-28):
 *   13px / line-height 18px, 3px 8px padding, 2px radius,
 *   --color-common-tooltip-bg / --color-common-tooltip-text,
 *   4px margin from anchor, max-width 200/310/640.
 */
import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

export type TooltipSide = "top" | "bottom" | "left" | "right";

interface Props {
  text: string;
  /** "Alt + T", "Ctrl + Alt + H", ... — split on "+" into key caps. */
  hotkey?: string;
  /** TV hotkey text template: `{N}` is the N-th key of `hotkey`, " + " draws a
   *  plus sign, anything else stays plain text ("{0} + Click on the chart",
   *  "Number or {0}"). Without it the keys are joined with " + ". */
  hotkeyText?: string;
  side?: TooltipSide;
  delayMs?: number;
  width?: "narrow" | "normal" | "wide";
  /** Inline SVG markup drawn after the text, e.g. the sort-direction glyph of
   *  the watchlist column headers ("Click to sort by Last ↑"). */
  icon?: string;
  /** TV's `common-tooltip--farther`: 8px from the anchor instead of 4px. */
  farther?: boolean;
  children: JSX.Element;
}

/** TV's hotkey block (common tooltip, module 712501): the template's `{N}`
 *  placeholders become key caps, then every " + " becomes a plus sign. */
function hotkeyParts(hotkey: string, template?: string): JSX.Element[] {
  const keys = hotkey.split("+").map((k) => k.trim()).filter(Boolean);
  const text = template ?? keys.map((_, i) => `{${i}}`).join(" + ");
  return text
    .split(/(\{\d+\}|\s\+\s)/)
    .filter(Boolean)
    .map((tok) => {
      const m = /^\{(\d+)\}$/.exec(tok);
      if (m) return <kbd class="tv-tooltip-hotkey-key">{keys[Number(m[1])] ?? ""}</kbd>;
      if (/^\s\+\s$/.test(tok)) return <span class="tv-tooltip-hotkey-plus">+</span>;
      return tok;
    });
}

export function Tooltip(props: Props) {
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  let wrapper!: HTMLSpanElement;
  let timer: number | null = null;
  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const show = () => {
    const target = wrapper.firstElementChild as HTMLElement | null;
    if (!target) return;
    setAnchor(target.getBoundingClientRect());
  };
  const onEnter = () => {
    clear();
    timer = window.setTimeout(show, props.delayMs ?? 500);
  };
  const onLeave = () => {
    clear();
    setAnchor(null);
  };
  onCleanup(clear);

  const side = () => props.side ?? "right";
  const hasHotkey = () => !!(props.hotkey || props.hotkeyText);
  const width = () => props.width ?? "normal";

  /** After the tooltip paints, nudge it back inside the viewport if its measured
   *  box overflows an edge (the CSS transforms make a pure-JS pre-calc awkward,
   *  so we correct post-layout). Keeps right-rail tooltips fully on-screen. */
  let tip: HTMLDivElement | undefined;
  const clampIntoView = (el: HTMLDivElement) => {
    tip = el;
    queueMicrotask(() => {
      if (!tip) return;
      const r = tip.getBoundingClientRect();
      const M = 4;
      let dx = 0;
      let dy = 0;
      if (r.left < M) dx = M - r.left;
      else if (r.right > window.innerWidth - M) dx = window.innerWidth - M - r.right;
      if (r.top < M) dy = M - r.top;
      else if (r.bottom > window.innerHeight - M) dy = window.innerHeight - M - r.bottom;
      if (dx) tip.style.left = `${parseFloat(tip.style.left || "0") + dx}px`;
      if (dy) tip.style.top = `${parseFloat(tip.style.top || "0") + dy}px`;
    });
  };

  const style = (): JSX.CSSProperties => {
    const r = anchor();
    if (!r) return {};
    const M = props.farther ? 8 : 4;
    switch (side()) {
      case "right":
        return { left: `${r.right + M}px`, top: `${r.top + r.height / 2}px` };
      case "left":
        return { left: `${r.left - M}px`, top: `${r.top + r.height / 2}px` };
      case "top":
        return { left: `${r.left + r.width / 2}px`, top: `${r.top - M}px` };
      case "bottom":
        return { left: `${r.left + r.width / 2}px`, top: `${r.bottom + M}px` };
    }
  };

  return (
    <>
      <span
        ref={wrapper}
        style={{ display: "contents" }}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocusIn={onEnter}
        onFocusOut={onLeave}
      >
        {props.children}
      </span>
      <Show when={anchor()}>
        <Portal mount={document.body}>
          <div
            ref={clampIntoView}
            role="tooltip"
            class={`tv-tooltip tv-tooltip-${side()} tv-tooltip-${width()}${hasHotkey() ? " tv-tooltip-with-hotkey" : ""}`}
            style={style()}
          >
            <span class="tv-tooltip-label">
              {props.text}
              <Show when={props.icon}>
                {(icon) => (
                  <>
                    {" "}
                    <span class="tv-tooltip-icon" innerHTML={icon()} />
                  </>
                )}
              </Show>
            </span>
            <Show when={hasHotkey()}>
              <span class="tv-tooltip-hotkey-block">{hotkeyParts(props.hotkey ?? "", props.hotkeyText)}</span>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
}
