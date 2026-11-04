/*
 * Menu rows of the Alerts panel (the Sort and Options menus of both views and
 * the row menu), drawn as the reference app draws them: actions with an icon,
 * collapsible uppercase sections, radio and check rows with a count on the
 * right, sort rows with their direction icon (the current sort inverted).
 */
import { Show, createSignal, type JSX } from "solid-js";
import { Icon } from "../../components/Icon";

export function MenuAction(props: { icon?: JSX.Element; label: string; disabled?: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={props.disabled || undefined}
      class="alerts-menu-row alerts-menu-action"
      classList={{ "is-disabled": !!props.disabled }}
      onClick={() => { if (!props.disabled) props.onSelect(); }}
    >
      <span class="alerts-menu-icon">{props.icon}</span>
      <span class="alerts-menu-label">{props.label}</span>
    </button>
  );
}

export const MenuSep = () => <div class="alerts-menu-sep" role="separator" />;

// Collapsed sections, by title, for the app session.
const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());

export function MenuSection(props: { title: string; children: JSX.Element }) {
  const isOpen = () => !collapsed().has(props.title);
  const toggle = () => {
    const next = new Set(collapsed());
    if (next.has(props.title)) next.delete(props.title);
    else next.add(props.title);
    setCollapsed(next);
  };
  return (
    <>
      <MenuSep />
      <button type="button" class="alerts-menu-title" aria-expanded={isOpen()} onClick={toggle}>
        <span>{props.title}</span>
        <svg class="alerts-menu-chevron" classList={{ "is-closed": !isOpen() }} viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          <path fill="none" stroke="currentColor" stroke-width="1.2" d="M5.5 10.5 9 7l3.5 3.5" />
        </svg>
      </button>
      <Show when={isOpen()}>{props.children}</Show>
    </>
  );
}

function Mark(props: { radio?: boolean; checked: boolean }) {
  return (
    <span class="alerts-menu-mark" classList={{ "is-radio": !!props.radio, "is-checked": props.checked }} aria-hidden="true">
      <Show when={props.checked && !props.radio}>
        <svg viewBox="0 0 11 9" width="11" height="9"><path fill="none" stroke="currentColor" stroke-width="2" d="M1 4l3 3 6-6" /></svg>
      </Show>
    </span>
  );
}

/** A radio (`radio`) or check row; `count`: the figure on the right. */
export function MenuToggle(props: { label: string; checked: boolean; radio?: boolean; count?: string | number; onSelect: () => void }) {
  return (
    <button
      type="button"
      role={props.radio ? "menuitemradio" : "menuitemcheckbox"}
      aria-checked={props.checked}
      class="alerts-menu-row alerts-menu-toggle"
      onClick={() => props.onSelect()}
    >
      <Mark radio={props.radio} checked={props.checked} />
      <span class="alerts-menu-label">{props.label}</span>
      <Show when={props.count !== undefined}>
        <span class="alerts-menu-count">{props.count}</span>
      </Show>
    </button>
  );
}

export function MenuSort(props: { label: string; desc: boolean; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.selected}
      class="alerts-menu-row alerts-menu-action alerts-menu-sort"
      classList={{ "is-selected": props.selected }}
      onClick={() => props.onSelect()}
    >
      <span class="alerts-menu-icon"><Icon name={props.desc ? "scr-menu-sort-desc" : "scr-menu-sort-asc"} size={28} /></span>
      <span class="alerts-menu-label">{props.label}</span>
    </button>
  );
}

/** The 18 px glyphs of the panel (hover buttons, menu actions, source icons). */
const glyph = (d: string, fill = false) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path d={d} fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
export const GLYPH = {
  pause: () => glyph("M9 16.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM7.5 6v6M10.5 6v6"),
  restart: () => glyph("M9 16.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM7.5 6v6l4.5-3-4.5-3Z"),
  edit: () => <Icon name="dt-settings" size={18} />,
  trash: () => <Icon name="scr-trash" size={18} />,
  download: () => glyph("M9 2.5v9M5.5 8 9 11.5 12.5 8M3 12v3.5h12V12"),
  /** Source icon of an alert on an indicator. */
  indicator: () => glyph("M1.5 11.5 5 7.5a1.5 1.5 0 0 1 2.2-.1l2.6 2.6a1.5 1.5 0 0 0 2.2-.1l3.5-4"),
};
