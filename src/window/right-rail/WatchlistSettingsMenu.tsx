/*
 * WatchlistSettingsMenu — the popover from the watchlist header gear
 * (`[data-name="settings-button"]`). Ported to SolidJS from the reference mock:
 * Table-view toggle · Customize columns
 * (checkboxes) · Symbol display (Logo checkbox + Symbol/Name radio). Toggling a
 * control edits the parent's settings in place and keeps the popover open.
 */
import { For, Show, onCleanup, onMount } from "solid-js";
import {
  WL_COLUMNS,
  WL_SETTINGS_ICONS,
  WL_SYMBOL_DISPLAY,
  type WlColumnKey,
  type WlSettings,
  type WlSymbolDisplay,
} from "../../data/watchlist";

type Props = {
  settings: WlSettings;
  onChange: (next: WlSettings) => void;
  onClose: () => void;
};

const Switch = (props: { on: boolean }) => (
  <span class={`wl-settings-switch${props.on ? " on" : ""}`} aria-hidden="true">
    <span class="wl-settings-switch-track" />
    <span class="wl-settings-switch-thumb" />
  </span>
);

const CheckBox = (props: { checked: boolean }) => (
  <span class={`wl-settings-check${props.checked ? " checked" : ""}`} aria-hidden="true">
    <Show when={props.checked}><span innerHTML={WL_SETTINGS_ICONS.check} /></Show>
  </span>
);

const Radio = (props: { checked: boolean }) => (
  <span class={`wl-settings-radio${props.checked ? " checked" : ""}`} aria-hidden="true" />
);

export function WatchlistSettingsMenu(props: Props) {
  let ref: HTMLDivElement | undefined;

  // Outside-click / Escape close; ignore the gear (it toggles us itself).
  onMount(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref?.contains(t)) return;
      if (t.closest('[data-name="settings-button"]')) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });

  const toggleColumn = (key: WlColumnKey) =>
    props.onChange({ ...props.settings, columns: { ...props.settings.columns, [key]: !props.settings.columns[key] } });
  const setSymbolDisplay = (value: WlSymbolDisplay) =>
    props.onChange({ ...props.settings, symbolDisplay: value });

  return (
    <div ref={ref} class="ot-popover watchlist-settings" role="menu" aria-label="Watchlist settings">
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={props.settings.tableView}
        class="wl-settings-item"
        data-value="table-view-switcher"
        onClick={() => props.onChange({ ...props.settings, tableView: !props.settings.tableView })}
      >
        <span class="wl-settings-label apply-overflow-tooltip">Table view</span>
        <Switch on={props.settings.tableView} />
      </button>

      <div class="ot-popover__divider" />

      <div class="ot-popover__section-title">Customize columns</div>
      <For each={WL_COLUMNS}>
        {(c) => (
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={props.settings.columns[c.key]}
            aria-label={c.menuLabel}
            class="wl-settings-item wl-settings-item--check"
            data-qa-id={c.key}
            onClick={() => toggleColumn(c.key)}
          >
            <CheckBox checked={props.settings.columns[c.key]} />
            <span class="wl-settings-label apply-overflow-tooltip">{c.menuLabel}</span>
          </button>
        )}
      </For>

      <div class="ot-popover__divider" />

      <div class="ot-popover__section-title">Symbol display</div>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={props.settings.logo}
        aria-label="Logo"
        class="wl-settings-item wl-settings-item--check"
        data-qa-id="logo"
        onClick={() => props.onChange({ ...props.settings, logo: !props.settings.logo })}
      >
        <CheckBox checked={props.settings.logo} />
        <span class="wl-settings-label apply-overflow-tooltip">Logo</span>
      </button>
      <For each={WL_SYMBOL_DISPLAY}>
        {(o) => (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={props.settings.symbolDisplay === o.value}
            aria-label={o.label}
            class="wl-settings-item wl-settings-item--check"
            data-qa-id={o.value}
            onClick={() => setSymbolDisplay(o.value)}
          >
            <Radio checked={props.settings.symbolDisplay === o.value} />
            <span class="wl-settings-label apply-overflow-tooltip">{o.label}</span>
          </button>
        )}
      </For>
    </div>
  );
}
