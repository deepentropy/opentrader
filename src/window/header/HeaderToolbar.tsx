/*
 * HeaderToolbar — the top strip of the chart UI.
 *
 * Menu buttons (Candles, chart-interval, layout-setup,
 * show-favorite-indicators, save-load-menu) and the symbol-search widget
 * report through the onMenuOpen / onSymbolSearch callbacks; App opens the
 * dropdown menus (HeaderMenu) and the symbol search dialog.
 *
 * Per-item rendering is driven by flags on each Item, in priority order:
 *   widget         → inline placeholder box (Symbol search).
 *   chevron        → small 16×8 dropdown arrow, narrow 24px button.
 *   iconName+text  → icon followed by visible text label.
 *   iconName       → icon-only.
 *   text           → visible text only (e.g. "10s", "D", "DailySave").
 */
import { createSignal, For, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { avatarHue, ProfileMenu } from "./ProfileMenu";
import { SECTIONS, SLUG_TO_INTERVAL, type Item, type Section } from "../../data/header-toolbar";
import { CHART_TYPE_ICON, type ChartTypeId } from "../chart/chart-types";
import { iconNameForLayout, type LayoutId } from "../chart/layouts";
import { favoriteIntervals, longIntervalLabel, shortIntervalLabel } from "../chart/interval-favorites";
import { favoriteIndicatorTemplates } from "../../data/indicator-template-store";
import { favoriteLayouts } from "../../data/layout-store";

type Props = {
  /** Active tab title fragment shown in the Symbol widget (e.g. "INTC"). */
  symbol?: string;
  /** Active interval id (e.g. "60" for 1 hour). Drives which
   *  shortcut button in the 10s..1W strip is highlighted. */
  interval?: string;
  /** Active chart type — drives the icon shown on the Candles button. */
  chartType?: ChartTypeId;
  /** Active multi-chart layout — drives the icon shown on the layout-setup
   *  button (it matches the selected template). */
  layout?: LayoutId;
  /** User clicked an interval shortcut button. */
  onIntervalChange?: (id: string) => void;
  /** User clicked a dropdown-bearing button (Candles, chart-interval, ...).
   *  Passes the button's bounding rect so the parent can position the
   *  HeaderMenu popover. */
  onMenuOpen?: (itemId: string, anchor: DOMRect) => void;
  /** User clicked the Symbol-search widget (App opens the
   *  SymbolSearchDialog). */
  onSymbolSearch?: () => void;
  /** User clicked the "Indicators, metrics, and strategies" button (hotkey "/")
   *  — opens the IndicatorsDialog. */
  onOpenIndicators?: () => void;
  /** User clicked the Settings gear — opens the ChartPropertiesDialog. */
  onOpenSettings?: () => void;
  /** Logged-in user name — drives the avatar initial/colour + ProfileMenu. */
  userName?: string;
  /** ProfileMenu "Settings" → opens AppSettingsDialog on the given tab. */
  onOpenAppSettings?: (tab: "general") => void;
  /** User clicked the "Create alert" button (hotkey Alt+A) — opens AlertDialog. */
  onCreateAlert?: () => void;
  /** User clicked the Fullscreen button (hotkey Shift+F) — toggles fullscreen. */
  onToggleFullscreen?: () => void;
  /** Active saved-layout name shown on the save-status badge ("Unnamed" when
   *  the chart hasn't been saved yet). */
  layoutName?: string;
  /** TRUE when the active chart has unsaved changes vs its saved layout —
   *  drives the dirty dot + the "Save layout" tooltip/affordance. */
  layoutDirty?: boolean;
  /** User clicked the save-status badge — triggers a layout save. */
  onSaveLayout?: () => void;
  /** User clicked a favourite-template letter badge — applies that indicator
   *  template to the focused pane (one-click). */
  onApplyIndicatorTemplate?: (id: string) => void;
  /** Saved layout the active tab shows (its favorite circle renders filled). */
  activeLayoutId?: string;
  /** User clicked a favorite-layout circle — loads that layout into the
   *  active tab. */
  onOpenLayout?: (id: string) => void;
  /** Drawing undo/redo (header buttons; Ctrl+Z / Ctrl+Y do the same). The
   *  labels are dynamic ("Undo create trend line"). */
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  undoLabel?: string;
  redoLabel?: string;
  /** User clicked "Compare symbols" — opens the symbol search in compare mode. */
  onCompare?: () => void;
};

/** Ids of buttons that have a dropdown menu. Used for the chevron
 *  affordance + the aria-haspopup attribute. */
const MENU_OWNERS = new Set([
  "candles",
  "chart-interval",
  "layout-setup",
  "show-favorite-indicators",
  "indicator-templates",
  "save-load-menu",
  "take-a-snapshot",
]);

/** First user-perceived character of a layout name (a leading emoji stays
 *  whole); case kept. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function firstSegment(name: string): string {
  const first = graphemes.segment(name.trim())[Symbol.iterator]().next();
  return first.done ? " " : first.value.segment;
}

export function HeaderToolbar(props: Props) {
  const renderItem = (item: Item) => {
    if (item.widget) {
      const isSymbol = item.id === "symbol-search";
      // Reactive accessor — must re-read props.symbol so the symbol button
      // updates on tab switch / symbol search (a plain const would freeze it).
      const display = () => (isSymbol && props.symbol ? props.symbol : item.text ?? item.label);
      if (isSymbol) {
        return (
          <Tooltip text={item.label} side="bottom">
            <button
              type="button"
              id="header-toolbar-symbol-search"
              data-name={item.id}
              aria-label={item.label}
              aria-haspopup="dialog"
              class="header-toolbar-widget is-symbol"
              onClick={() => props.onSymbolSearch?.()}
            >
              {display()}
            </button>
          </Tooltip>
        );
      }
      return (
        <Tooltip text={item.label} side="bottom">
          <div class="header-toolbar-widget" data-name={item.id}>
            {display()}
          </div>
        </Tooltip>
      );
    }

    // Save-status badge — the layout name, with a small blue "Save" label
    // stacked beneath it while the chart has unsaved changes ("<name>" over
    // "Save"). Clicking saves the active layout.
    if (item.id === "all-changes-saved") {
      const dirty = () => !!props.layoutDirty;
      const name = () => props.layoutName ?? item.text ?? "Unnamed";
      // The dirty tooltip carries the Ctrl+S hotkey; "All changes saved" has none.
      const tip = () => (dirty() ? "Save all charts for all symbols and intervals on your layout" : "All changes saved");
      return (
        <Tooltip text={tip()} hotkey={dirty() ? "Ctrl + S" : undefined} side="bottom">
          <button
            type="button"
            data-name={item.id}
            aria-label={tip()}
            class={"ot-toolbar-button header-toolbar-btn header-toolbar-save-status" + (dirty() ? " is-dirty" : "")}
            onClick={() => props.onSaveLayout?.()}
          >
            <span class="header-toolbar-save-name">{name()}</span>
            <Show when={dirty()}>
              <span class="header-toolbar-save-action">Save</span>
            </Show>
          </button>
        </Tooltip>
      );
    }

    // Undo/Redo: dynamic label + enabled state from the drawing undo stack.
    if (item.id === "undo-toggle-maximized-pane-state" || item.id === "redo-toggle-maximized-pane-state") {
      const isUndo = item.id.startsWith("undo");
      const enabled = () => (isUndo ? !!props.canUndo : !!props.canRedo);
      const label = () => (isUndo ? props.undoLabel ?? "Undo" : props.redoLabel ?? "Redo");
      return (
        <Tooltip text={label()} hotkey={item.hotkey} side="bottom">
          <button
            type="button"
            data-name={item.id}
            aria-label={label()}
            class={"ot-toolbar-button header-toolbar-btn" + (enabled() ? "" : " is-disabled")}
            disabled={!enabled()}
            onClick={() => (isUndo ? props.onUndo?.() : props.onRedo?.())}
          >
            <Icon name={item.iconName!} size={28} />
          </button>
        </Tooltip>
      );
    }

    const slugInterval = SLUG_TO_INTERVAL[item.id];
    const isIntervalActive = () => !!slugInterval && slugInterval === props.interval;
    const hasMenu = MENU_OWNERS.has(item.id);

    const cls = () =>
      [
        "ot-toolbar-button",
        "header-toolbar-btn",
        item.chevron ? "is-chevron" : "",
        item.iconName && item.text ? "is-iconText" : "",
        item.template ? "is-template" : "",
        isIntervalActive() ? "active" : "",
        item.disabled ? "is-disabled" : "",
      ]
        .filter(Boolean)
        .join(" ");

    return (
      <Tooltip text={item.label} hotkey={item.hotkey} hotkeyText={item.hotkeyText} side="bottom">
        <button
          type="button"
          data-name={item.id}
          aria-label={item.label}
          class={cls()}
          disabled={item.disabled}
          aria-haspopup={hasMenu ? "menu" : undefined}
          onClick={(e) => {
            if (item.disabled) return;
            if (hasMenu) {
              props.onMenuOpen?.(item.id, e.currentTarget.getBoundingClientRect());
            } else if (item.id === "open-indicators-dialog") {
              props.onOpenIndicators?.();
            } else if (item.id === "header-toolbar-properties") {
              props.onOpenSettings?.();
            } else if (item.id === "compare-symbols") {
              props.onCompare?.();
            } else if (item.id === "create-alert") {
              props.onCreateAlert?.();
            } else if (item.id === "header-toolbar-fullscreen") {
              props.onToggleFullscreen?.();
            } else if (slugInterval) {
              props.onIntervalChange?.(slugInterval);
            }
          }}
        >
          <Show when={item.iconName}>
            <Icon
              name={
                item.id === "candles" && props.chartType
                  ? CHART_TYPE_ICON[props.chartType]
                  : item.id === "layout-setup" && props.layout
                    ? iconNameForLayout(props.layout)
                    : item.iconName!
              }
              size={item.chevron ? 8 : item.id === "layout-setup" ? undefined : 28}
            />
          </Show>
          <Show when={item.text}>
            {item.template ? (
              <span class="header-toolbar-template-badge">{item.text}</span>
            ) : (
              <span class="header-toolbar-label">{item.text}</span>
            )}
          </Show>
        </button>
      </Tooltip>
    );
  };

  const userName = () => props.userName ?? "Trader";
  const [profileAnchor, setProfileAnchor] = createSignal<DOMRect | null>(null);

  return (
    <div class="header-toolbar" role="toolbar" aria-label="Chart header">
      {/* Account/main menu — circular avatar at the far left, before the
          symbol field. No tooltip: there is no account to show. */}
        <button
          type="button"
          class={"header-toolbar-profile" + (profileAnchor() ? " is-open" : "")}
          data-qa-id="main-menu-button"
          aria-label="Main menu"
          aria-haspopup="menu"
          aria-expanded={!!profileAnchor()}
          onClick={(e) =>
            setProfileAnchor((cur) => (cur ? null : e.currentTarget.getBoundingClientRect()))
          }
        >
          <span class="header-toolbar-avatar" style={{ "background-color": `hsl(${avatarHue(userName())}, 25%, 50%)` }}>
            {userName().charAt(0).toUpperCase()}
          </span>
        </button>
      <Show when={profileAnchor()}>
        {(anchor) => (
          <ProfileMenu
            anchor={anchor()}
            userName={userName()}
            onClose={() => setProfileAnchor(null)}
            onAction={(action) => {
              if (action === "app-settings") props.onOpenAppSettings?.("general");
            }}
          />
        )}
      </Show>
      <For each={SECTIONS}>
        {(section: Section, si) => (
          <>
            <Show when={si() > 0}>
              <div class="header-toolbar-sep" />
            </Show>
            <div class="header-toolbar-section">
              {/* Indicators section: after the static buttons, the favourited
                  indicator templates render as live letter badges (20×20
                  round template favourites) — one click applies the template. */}
              <Show when={section.sectionIndex === 3}>
                <For each={section.items}>{(item) => renderItem(item)}</For>
                <For each={favoriteIndicatorTemplates()}>
                  {(tpl) => (
                    <Tooltip text={tpl.name} side="bottom">
                      <button
                        type="button"
                        data-name={`indicator-template-favorite-${tpl.id}`}
                        aria-label={`Apply indicator template ${tpl.name}`}
                        class="ot-toolbar-button header-toolbar-btn is-template"
                        onClick={() => props.onApplyIndicatorTemplate?.(tpl.id)}
                      >
                        <span class="header-toolbar-template-badge">
                          {tpl.name.charAt(0).toUpperCase()}
                        </span>
                      </button>
                    </Tooltip>
                  )}
                </For>
              </Show>
              <Show
                when={section.sectionIndex === 1}
                fallback={
                  <Show when={section.sectionIndex !== 3}>
                    <For each={section.items}>
                      {(item) => (
                        <>
                          {renderItem(item)}
                          {/* Favorite layouts sit right after Manage layouts,
                              inside the save-load group, sorted by name. */}
                          <Show when={item.id === "save-load-menu"}>
                            <For each={favoriteLayouts()}>
                              {(l, i) => (
                                <Tooltip text={l.name} side="bottom">
                                  <button
                                    type="button"
                                    data-name={`favorite-layout-${l.id}`}
                                    aria-label={l.name}
                                    class={
                                      "header-toolbar-fav-layout" +
                                      (i() === favoriteLayouts().length - 1 ? " is-last" : "")
                                    }
                                    onClick={() => props.onOpenLayout?.(l.id)}
                                  >
                                    <span
                                      class={
                                        "header-toolbar-fav-layout-round" +
                                        (l.id === props.activeLayoutId ? " is-active" : "")
                                      }
                                    >
                                      {firstSegment(l.name)}
                                    </span>
                                  </button>
                                </Tooltip>
                              )}
                            </For>
                          </Show>
                        </>
                      )}
                    </For>
                  </Show>
                }
              >
                {/* Interval strip: quick-access buttons regenerated from the
                    global favourites store, then the chart-interval dropdown. */}
                <For each={favoriteIntervals()}>
                  {(id) => (
                    <Tooltip text={longIntervalLabel(id)} side="bottom">
                      <button
                        type="button"
                        data-name={`interval-${id}`}
                        aria-label={id}
                        class={`ot-toolbar-button header-toolbar-btn${props.interval === id ? " active" : ""}`}
                        onClick={() => props.onIntervalChange?.(id)}
                      >
                        <span class="header-toolbar-label">{shortIntervalLabel(id)}</span>
                      </button>
                    </Tooltip>
                  )}
                </For>
                {/* Active interval that isn't favourited: it surfaces as a
                    highlighted button right before the chevron, so the current
                    timeframe is always visible without opening the dropdown. */}
                <Show when={props.interval && !favoriteIntervals().includes(props.interval)}>
                  <Tooltip text={longIntervalLabel(props.interval!)} side="bottom">
                    <button
                      type="button"
                      data-name={`interval-${props.interval}`}
                      aria-label={props.interval}
                      class="ot-toolbar-button header-toolbar-btn active"
                      onClick={() => props.onIntervalChange?.(props.interval!)}
                    >
                      <span class="header-toolbar-label">{shortIntervalLabel(props.interval!)}</span>
                    </button>
                  </Tooltip>
                </Show>
                <For each={section.items.filter((i) => i.id === "chart-interval")}>
                  {(item) => renderItem(item)}
                </For>
              </Show>
            </div>
          </>
        )}
      </For>
    </div>
  );
}
