/*
 * Line end select (TV settings "Line" row, `left-end-select` /
 * `right-end-select`, captured 24/09/2026 on TV 3.4.1): a square button with
 * the current end's icon, opening a two-row list "Normal" / "Arrow" (icon +
 * label). The icons are TV's; the right-end control shows them mirrored.
 */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

const END_ICONS: Record<0 | 1, string> = {
  0: "M8.5 13.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 0H24",
  1: "M4.5 13.5H24m-19.5 0L8 17m-3.5-3.5L8 10",
};
const END_OPTIONS: ReadonlyArray<readonly [0 | 1, string]> = [[0, "Normal"], [1, "Arrow"]];

function EndIcon(props: { value: 0 | 1; mirrored: boolean }) {
  return (
    <svg width="28" height="28" fill="none" style={{ transform: props.mirrored ? "scaleX(-1)" : undefined }} aria-hidden="true">
      <path stroke="currentColor" d={END_ICONS[props.value]} />
    </svg>
  );
}

export function LineEndSelect(props: { side: "left" | "right"; value: 0 | 1; onChange: (v: 0 | 1) => void }) {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ left: 0, top: 0 });
  let btn: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const mirrored = () => props.side === "right";
  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (!open()) return;
      const t = e.target as Node;
      if (btn?.contains(t) || menu?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (open() && e.key === "Escape") { e.stopPropagation(); setOpen(false); }
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });
  return (
    <>
      <button
        ref={btn}
        type="button"
        class={"drawing-settings-end-btn" + (open() ? " open" : "")}
        data-name={`${props.side}-end-select`}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => {
          if (open()) return setOpen(false);
          const r = btn!.getBoundingClientRect();
          setPos({ left: r.left, top: r.bottom + 4 });
          setOpen(true);
        }}
      >
        <EndIcon value={props.value} mirrored={mirrored()} />
      </button>
      <Show when={open()}>
        <div ref={menu} class="drawing-settings-multiselect-menu drawing-settings-end-menu" role="listbox" style={{ left: `${pos().left}px`, top: `${pos().top}px` }}>
          <For each={END_OPTIONS}>
            {([v, label]) => (
              <button
                type="button"
                role="option"
                aria-selected={props.value === v}
                class={"drawing-settings-end-option" + (props.value === v ? " selected" : "")}
                onClick={() => { props.onChange(v); setOpen(false); }}
              >
                <EndIcon value={v} mirrored={mirrored()} />
                <span>{label}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

/** TV lineWidthSelect / lineStyleSelect (fib "Levels line"): a button with
 *  the current line (width 76px / style 34px) and a list of lines. */
export function LineGlyphSelect<T extends string | number>(props: {
  kind: "width" | "style";
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ left: 0, top: 0 });
  let btn: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (!open()) return;
      const t = e.target as Node;
      if (btn?.contains(t) || menu?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (open() && e.key === "Escape") { e.stopPropagation(); setOpen(false); }
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });
  const glyph = (v: T, len: number) => {
    const w = props.kind === "width" ? Number(v) : 1;
    const dash = props.kind === "style" ? (v === "dashed" ? "4 3" : v === "dotted" ? "1 2" : undefined) : undefined;
    return (
      <svg width={len} height={12} aria-hidden="true">
        <line x1={0} y1={6} x2={len} y2={6} stroke="currentColor" stroke-width={w} stroke-dasharray={dash} />
      </svg>
    );
  };
  const len = () => (props.kind === "width" ? 52 : 18);
  return (
    <>
      <button
        ref={btn}
        type="button"
        class={"drawing-settings-end-btn drawing-settings-glyph-btn" + (props.kind === "width" ? " wide" : "") + (open() ? " open" : "")}
        data-name={props.kind === "width" ? "line-width-select" : "line-style-select"}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => {
          if (open()) return setOpen(false);
          const r = btn!.getBoundingClientRect();
          setPos({ left: r.left, top: r.bottom + 4 });
          setOpen(true);
        }}
      >
        {glyph(props.value, len())}
      </button>
      <Show when={open()}>
        <div ref={menu} class="drawing-settings-multiselect-menu drawing-settings-end-menu" role="listbox" style={{ left: `${pos().left}px`, top: `${pos().top}px` }}>
          <For each={props.options}>
            {(v) => (
              <button
                type="button"
                role="option"
                aria-selected={props.value === v}
                class={"drawing-settings-end-option" + (props.value === v ? " selected" : "")}
                onClick={() => { props.onChange(v); setOpen(false); }}
              >
                {glyph(v, 52)}
              </button>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}
