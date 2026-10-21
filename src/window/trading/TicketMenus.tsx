/*
 * Order ticket pop-ups: a menu anchored under a button (the type menus of
 * the field labels, the equivalent drop-downs, ⋯, the presets menu), its
 * rows (title, info icon with a tooltip, value on the right, disabled with
 * a reason), and the field buttons (label menu, ⇄, equivalent drop-down).
 * Rows: 32 px, r6, the current one #F2F2F2 with dark text; menu #1F1F1F, r8.
 */
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Tooltip } from "../../components/Tooltip";
import { fitToWindow } from "../../components/menu-fit";
import { ChevronIcon } from "./icons";

export type MenuRow = {
  title: string;
  /** Info icon tooltip. */
  info?: string;
  /** Value right of the title (equivalent menus). */
  value?: string;
  selected?: boolean;
  /** Tooltip of a disabled row (why). */
  disabled?: string | false;
  onSelect: () => void;
};

/** A menu under `anchor` (left edges aligned, or right edges with `alignEnd`). */
export function Popup(props: { anchor: HTMLElement; alignEnd?: boolean; onClose: () => void; class?: string; label?: string; children: JSX.Element }) {
  let el!: HTMLDivElement;
  const place = () => {
    const r = props.anchor.getBoundingClientRect();
    fitToWindow(el, props.alignEnd ? r.right : r.left, r.bottom + 4, !!props.alignEnd);
  };
  onMount(() => {
    place();
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!el.contains(t) && !props.anchor.contains(t)) props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", props.onClose);
    onCleanup(() => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", props.onClose);
    });
  });
  return (
    <Portal>
      <div ref={el} class={`trd-menu ${props.class ?? ""}`} role="menu" aria-label={props.label}>
        {props.children}
      </div>
    </Portal>
  );
}

export function InfoIcon() {
  return (
    <svg class="trd-info-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <circle cx="8" cy="4.9" r="1" fill="var(--trd-menu-bg, #1f1f1f)" />
      <path d="M8 7.2v4.6" stroke="var(--trd-menu-bg, #1f1f1f)" stroke-width="1.6" stroke-linecap="round" />
    </svg>
  );
}

export function MenuRows(props: { rows: MenuRow[]; onClose: () => void }) {
  return (
    <For each={props.rows}>
      {(r) => {
        const row = (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!!r.selected}
            class="trd-menu-row"
            classList={{ "is-selected": !!r.selected, "is-disabled": !!r.disabled }}
            aria-disabled={!!r.disabled}
            onClick={() => {
              if (r.disabled) return;
              props.onClose();
              r.onSelect();
            }}
          >
            <span class="trd-menu-title">{r.title}</span>
            <Show when={r.info}>
              {(t) => (
                <Tooltip text={t()} side="top">
                  <span class="trd-menu-info">
                    <InfoIcon />
                  </span>
                </Tooltip>
              )}
            </Show>
            <Show when={r.value != null}>
              <span class="trd-menu-value">{r.value}</span>
            </Show>
          </button>
        );
        return r.disabled ? (
          <Tooltip text={r.disabled} side="right">
            {row}
          </Tooltip>
        ) : (
          row
        );
      }}
    </For>
  );
}

/** Field label that opens its type menu ("Units ▾", "Take profit price ▾"). */
export function LabelMenu(props: { label: string; rows: MenuRow[] }) {
  const [open, setOpen] = createSignal(false);
  let btn!: HTMLButtonElement;
  return (
    <>
      <button type="button" ref={btn} class="trd-tk-label trd-tk-label-btn" classList={{ "is-open": open() }} aria-haspopup="menu" aria-expanded={open()} onClick={() => setOpen(!open())}>
        {props.label}
        <ChevronIcon open={open()} />
      </button>
      <Show when={open()}>
        <Popup anchor={btn} onClose={() => setOpen(false)} class="trd-menu-types">
          <MenuRows rows={props.rows} onClose={() => setOpen(false)} />
        </Popup>
      </Show>
    </>
  );
}

export function SwapIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
      <path d="M3.5 7h11l-3-3M14.5 11h-11l3 3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** ⇄: the typed value and its equivalent change places. */
export function SwapButton(props: { onClick: () => void; disabled?: boolean }) {
  return (
    <Tooltip text="Switches values" side="top">
      <button type="button" class="trd-tk-swap" aria-label="Switches values" disabled={props.disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onClick()}>
        <SwapIcon />
      </button>
    </Tooltip>
  );
}

/** The equivalent at the right of a field ("75 ticks ▾"), its type menu. */
export function EquivButton(props: { value: string; unit: string; rows: MenuRow[]; disabled?: boolean }) {
  const [open, setOpen] = createSignal(false);
  let btn!: HTMLButtonElement;
  return (
    <>
      <Tooltip text="Changes equivalent type" side="top">
        <button
          type="button"
          ref={btn}
          class="trd-tk-equiv"
          classList={{ "is-open": open() }}
          disabled={props.disabled}
          aria-haspopup="menu"
          aria-expanded={open()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen(!open())}
        >
          <span class="trd-tk-equiv-value">{props.value}</span>
          <small>{props.unit}</small>
          <ChevronIcon open={open()} />
        </button>
      </Tooltip>
      <Show when={open()}>
        <Popup anchor={btn} alignEnd onClose={() => setOpen(false)} class="trd-menu-equiv">
          <MenuRows rows={props.rows} onClose={() => setOpen(false)} />
        </Popup>
      </Show>
    </>
  );
}
