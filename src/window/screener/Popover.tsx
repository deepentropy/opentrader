/*
 * Screener popovers: the reference app ui-lib popover look (Desktop 3.4.1):
 * #1f1f1f, 10px radius, 6px padding, shadow 0 2px 4px rgba(0,0,0,.4),
 * 32px rows (48px with a description line), 6px row radius, hover #2e2e2e,
 * selected #f2f2f2 / #0f0f0f text, 11px #8c8c8c section titles.
 *
 * The popover opens under its anchor, left aligned, with no gap, and is
 * clamped into the window. Outside press and Escape close it; a press on the
 * anchor is left to the anchor (so the anchor toggles).
 */
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "../../components/Icon";

type PopoverProps = {
  anchor: HTMLElement | undefined;
  onClose: () => void;
  class?: string;
  /** Fixed width (px); otherwise the content decides. */
  width?: number;
  maxHeight?: number;
  /** Extra x/y offset from the anchor's bottom-left corner. */
  offset?: { x: number; y: number };
  children: JSX.Element;
};

export function Popover(props: PopoverProps) {
  let el!: HTMLDivElement;

  const place = () => {
    const a = props.anchor;
    if (!a || !el) return;
    const r = a.getBoundingClientRect();
    const W = document.documentElement.clientWidth;
    const H = document.documentElement.clientHeight;
    const max = props.maxHeight ?? 600;
    el.style.maxHeight = `${Math.min(max, H)}px`;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = r.left + (props.offset?.x ?? 0);
    let y = r.bottom + (props.offset?.y ?? 0);
    if (x + w > W) x = Math.max(0, r.right - w);
    if (y + h > H) y = Math.max(0, Math.min(H - h, r.top - h));
    el.style.left = `${Math.max(0, x)}px`;
    el.style.top = `${Math.max(0, y)}px`;
  };

  onMount(() => {
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (el.contains(t) || props.anchor?.contains(t)) return;
      // Nested popovers (selects) live in their own portal: ignore them.
      if ((t as HTMLElement).closest?.(".scr-popover")) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    const onResize = () => place();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      ro.disconnect();
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    });
  });

  return (
    <Portal mount={document.body}>
      <div
        ref={el}
        class={`scr-popover${props.class ? " " + props.class : ""}`}
        style={{ width: props.width ? `${props.width}px` : undefined }}
        role="dialog"
      >
        {props.children}
      </div>
    </Portal>
  );
}

type ItemProps = {
  title: string;
  description?: string;
  icon?: string;
  /** Keep the 28 px icon column empty (menus whose other rows have icons). */
  iconSpace?: boolean;
  /** Right-side slot (counts, arrows). */
  right?: JSX.Element;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
};

/** One popover row. */
export function PopItem(props: ItemProps) {
  return (
    <div
      role="option"
      aria-selected={props.selected || undefined}
      aria-disabled={props.disabled || undefined}
      class="scr-item"
      classList={{ "is-selected": !!props.selected, "is-disabled": !!props.disabled, "has-desc": !!props.description }}
      onClick={() => !props.disabled && props.onClick?.()}
    >
      <Show when={props.icon || props.iconSpace}>
        <span class="scr-item-icon">
          <Show when={props.icon}>
            <Icon name={props.icon!} size={28} />
          </Show>
        </span>
      </Show>
      <span class="scr-item-text">
        <span class="scr-item-title">{props.title}</span>
        <Show when={props.description}>
          <span class="scr-item-desc">{props.description}</span>
        </Show>
      </span>
      <Show when={props.right}>
        <span class="scr-item-right">{props.right}</span>
      </Show>
    </div>
  );
}

export function PopSectionTitle(props: { title: string }) {
  return <div class="scr-section-title">{props.title}</div>;
}

export function PopDivider() {
  return <div class="scr-pop-divider" role="separator" />;
}

/** Search field of the list popovers. */
export function PopSearch(props: { value: string; onInput: (v: string) => void; autofocus?: boolean }) {
  let input!: HTMLInputElement;
  onMount(() => {
    if (props.autofocus !== false) input.focus();
  });
  return (
    <span class="scr-input">
      <input
        ref={input}
        type="text"
        placeholder="Search"
        aria-label="Search"
        spellcheck={false}
        autocomplete="off"
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
    </span>
  );
}

/** Nested list header with a back arrow ("< Market data"). */
export function PopBack(props: { title: string; onClick: () => void }) {
  return (
    <div class="scr-item scr-item-back" onClick={() => props.onClick()}>
      <span class="scr-item-icon"><Icon name="scr-back" size={28} /></span>
      <span class="scr-item-text"><span class="scr-item-title scr-item-title--strong">{props.title}</span></span>
    </div>
  );
}

/** Select-like dropdown button (manual setup, params). */
export function SelectButton(props: {
  label: string;
  icon?: string;
  options: { value: string; label: string; icon?: string; divider?: boolean }[];
  value: string;
  onChange: (v: string) => void;
  class?: string;
}) {
  let btn!: HTMLButtonElement;
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <button
        ref={btn}
        type="button"
        role="combobox"
        aria-expanded={open()}
        class={`scr-select${props.class ? " " + props.class : ""}`}
        classList={{ "is-open": open() }}
        onClick={() => setOpen(!open())}
      >
        <Show when={props.icon}>
          <span class="scr-select-icon"><Icon name={props.icon!} size={18} /></span>
        </Show>
        <span class="scr-select-label">{props.label}</span>
        <span class="scr-select-caret"><Icon name="scr-caret-small" size={18} /></span>
      </button>
      <Show when={open()}>
        <Popover anchor={btn} onClose={() => setOpen(false)} width={btn.offsetWidth} offset={{ x: 0, y: 4 }} maxHeight={360}>
          <div class="scr-pop-scroll" role="listbox">
            <For each={props.options}>
              {(o) => (
                <>
                  <Show when={o.divider}><PopDivider /></Show>
                  <PopItem
                    title={o.label}
                    icon={o.icon}
                    selected={o.value === props.value}
                    onClick={() => {
                      props.onChange(o.value);
                      setOpen(false);
                    }}
                  />
                </>
              )}
            </For>
          </div>
        </Popover>
      </Show>
    </>
  );
}
