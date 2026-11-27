/*
 * WatchlistSettingsMenu — the popover from the watchlist header gear
 * (`[data-name="settings-button"]`). Ported to SolidJS from the reference mock:
 * Table-view toggle · Customize columns
 * (checkboxes) · Symbol display (Logo checkbox + Symbol/Name radio). Toggling a
 * control edits the parent's settings in place and keeps the popover open.
 * Not in the reference: the columns added from "Add column" are listed checked
 * under the others (unchecking one removes it), then "Add column…".
 */
import { For } from "solid-js";
import type { WlColumnKey, WlSettings, WlSymbolDisplay } from "../../data/watchlist";
import { WL_COLUMNS, WL_ICONS, WL_SYMBOL_DISPLAY } from "./watchlist/ui";
import { CheckMarkBox, SwitchMark } from "../../components/form";
import { createPopover } from "../../components/popover";
import { addedTitle } from "./watchlist/added-columns";

type Props = {
  settings: WlSettings;
  onChange: (next: WlSettings) => void;
  /** "Add column…": open the Add column dialog. */
  onAddColumn: () => void;
  onClose: () => void;
};

const Radio = (props: { checked: boolean }) => (
  <span class={`wl-settings-radio${props.checked ? " checked" : ""}`} aria-hidden="true" />
);

export function WatchlistSettingsMenu(props: Props) {
  // Outside-click / Escape close; ignore the gear (it toggles us itself).
  const ref = createPopover(undefined, {
    onClose: () => props.onClose(),
    placement: false,
    insideSelector: '[data-name="settings-button"]',
    press: "mousedown",
    escape: "pass",
    on: { target: "window", capture: true },
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
        <SwitchMark variant="menu" on={props.settings.tableView} />
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
            <CheckMarkBox variant="menu" checked={props.settings.columns[c.key]} />
            <span class="wl-settings-label apply-overflow-tooltip">{c.menuLabel}</span>
          </button>
        )}
      </For>
      <For each={props.settings.added}>
        {(c) => (
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked="true"
            class="wl-settings-item wl-settings-item--check"
            data-qa-id={c.key}
            onClick={() => props.onChange({ ...props.settings, added: props.settings.added.filter((a) => a.key !== c.key) })}
          >
            <CheckMarkBox variant="menu" checked />
            <span class="wl-settings-label apply-overflow-tooltip" data-no-translate>{addedTitle(c)}</span>
          </button>
        )}
      </For>
      <button type="button" role="menuitem" class="wl-settings-item wl-settings-item--check" data-qa-id="add-column" onClick={() => props.onAddColumn()}>
        <span class="wl-settings-add" aria-hidden="true" innerHTML={WL_ICONS.plus} />
        <span class="wl-settings-label apply-overflow-tooltip">Add column…</span>
      </button>

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
        <CheckMarkBox variant="menu" checked={props.settings.logo} />
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
