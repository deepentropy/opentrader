/*
 * (i) icon of a settings row that opens a feature card on click (reference
 * app: Settings → Trading → Positions and orders, Execution marks): a
 * 320 x 160 picture, a title and a line of text in a 352 px card under the
 * icon (8 px left of it). A click outside or on the icon again closes it.
 */
import { Show, createSignal, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

export type FeatureCardInfo = { title: string; text: string; art: "positions" | "executions" };

const INFO_PATH = "M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16Zm1-12a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM8.5 9.5H7V8h3v6H8.5V9.5Z";

/** Candles of the pictures: [x, open, close, high, low] (viewBox 320 x 160). */
const CANDLES: [number, number, number, number, number][] = [
  [22, 112, 100, 96, 118], [40, 100, 106, 94, 112], [58, 106, 92, 88, 110], [76, 92, 84, 78, 96],
  [94, 84, 90, 80, 96], [112, 90, 76, 72, 94], [130, 76, 70, 64, 82], [148, 70, 78, 66, 84],
  [166, 78, 66, 60, 82], [184, 66, 58, 52, 70], [202, 58, 64, 54, 70], [220, 64, 52, 46, 68],
  [238, 52, 56, 46, 62],
];
const UP = "#089981";
const DOWN = "#f23645";

function Candles() {
  return (
    <>
      {CANDLES.map(([x, o, c, h, l]) => {
        const col = c < o ? UP : DOWN;
        return (
          <g>
            <line x1={x} x2={x} y1={h} y2={l} stroke={col} stroke-width="1.5" />
            <rect x={x - 5} y={Math.min(o, c)} width="10" height={Math.max(2, Math.abs(o - c))} rx="1" fill={col} />
          </g>
        );
      })}
    </>
  );
}

/** Position, take profit and stop loss lines with their chips. */
function PositionsArt() {
  const chip = (y: number, color: string, text: string, filled: boolean, w: number) => (
    <g>
      <line x1="0" x2="320" y1={y} y2={y} stroke={color} stroke-width="1" stroke-dasharray={filled ? undefined : "4 3"} />
      <rect x={258 - w} y={y - 8} width={w} height="16" rx="3" fill={filled ? color : "#0f0f0f"} stroke={color} />
      <text x={258 - w / 2} y={y + 4} fill={filled ? "#fff" : color} font-size="10" text-anchor="middle">{text}</text>
      <rect x="266" y={y - 8} width="50" height="16" rx="2" fill={filled ? color : "#0f0f0f"} stroke={color} />
    </g>
  );
  return (
    <>
      <Candles />
      {chip(40, UP, "TP  +42.00", false, 62)}
      {chip(84, "#2962ff", "1   +12.40   ×", true, 74)}
      {chip(128, "#ff9800", "SL  −18.00", false, 62)}
    </>
  );
}

/** Buy arrows under their bars, sell arrows over them. */
function ExecutionsArt() {
  const arrow = (x: number, y: number, buy: boolean) => (
    <path
      d={buy ? `M${x} ${y + 14}V${y + 2}m-5 5 5-5 5 5` : `M${x} ${y - 14}V${y - 2}m-5-5 5 5 5-5`}
      fill="none"
      stroke={buy ? "#2962ff" : DOWN}
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  );
  return (
    <>
      <Candles />
      {arrow(40, 116, true)}
      {arrow(94, 100, true)}
      {arrow(76, 74, false)}
      {arrow(184, 74, true)}
      {arrow(238, 42, false)}
    </>
  );
}

function Art(props: { kind: FeatureCardInfo["art"] }) {
  return (
    <svg class="cp3-card__art" viewBox="0 0 320 160" width="320" height="160" aria-hidden="true">
      <rect width="320" height="160" fill="#0f0f0f" />
      {[32, 64, 96, 128].map((y) => (
        <line x1="0" x2="320" y1={y} y2={y} stroke="#1f1f1f" />
      ))}
      {props.kind === "positions" ? <PositionsArt /> : <ExecutionsArt />}
    </svg>
  );
}

export function FeatureCardIcon(props: { card: FeatureCardInfo }): JSX.Element {
  const [at, setAt] = createSignal<{ left: number; top: number } | null>(null);
  let icon: HTMLButtonElement | undefined;
  let card: HTMLDivElement | undefined;
  const onDown = (e: MouseEvent) => {
    const t = e.target as Node;
    if (card?.contains(t) || icon?.contains(t)) return;
    setAt(null);
  };
  document.addEventListener("mousedown", onDown, true);
  onCleanup(() => document.removeEventListener("mousedown", onDown, true));
  const toggle = () => {
    if (at()) return setAt(null);
    const r = icon!.getBoundingClientRect();
    setAt({ left: r.left - 8, top: r.bottom });
  };
  return (
    <>
      <button ref={icon} type="button" class="cp3-help is-info is-card" aria-label={props.card.title} onClick={toggle}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path fill="currentColor" d={INFO_PATH} /></svg>
      </button>
      <Show when={at()}>
        {(p) => (
          <Portal>
            <div ref={card} class="cp3-card" role="dialog" aria-label={props.card.title} style={{ left: `${p().left}px`, top: `${p().top}px` }} onMouseDown={(e) => e.stopPropagation()}>
              <Art kind={props.card.art} />
              <div class="cp3-card__text">
                <div class="cp3-card__title">{props.card.title}</div>
                <div class="cp3-card__body">{props.card.text}</div>
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}
