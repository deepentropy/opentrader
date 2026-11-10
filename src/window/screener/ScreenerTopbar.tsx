/*
 * ScreenerTopbar: screen name menu, Save button, Undo / Redo (the reference app
 * Desktop 3.4.1 topbar: padding 8 20 12, 20 px / 600 title with an 18 px
 * caret, 34 px buttons).
 *
 * Screen menu (local actions only): Save screen, Autosave (a saved screen's
 * changes saved at once), Make a copy…, Rename…,
 * Download results as CSV (./screener-csv), Create new screen…, Add alert… (on a saved screen: a symbol enters or
 * leaves it), Recently used, Open screen…. Leaving a changed screen asks
 * "Save changes?" (./leave-screen). The gear at the right opens "Screener
 * settings" (./ScreenerSettingsDialog). The account item Share screen is not
 * shown.
 *
 * Maximized (the control panel's Maximize): the bar is the screener's only head row: the screen name, the view's
 * tools (`tools`, from the panel), the gear and Minimize, whose badge counts the filters (each active filter, the
 * market, the watchlist). Undo / Redo are not shown.
 */
import { For, Show, createSignal, type JSX } from "solid-js";
import { Icon } from "../../components/Icon";
import { LayoutNameDialog } from "../header/LayoutNameDialog";
import { screenerStore } from "../../data/screener-store";
import type { Screen } from "../../data/screener-catalog";
import { PopDivider, PopItem, PopSectionTitle, Popover } from "./Popover";
import { ScreenBrowserDialog } from "./ScreenBrowserDialog";
import { openScreenAlertDialog } from "../alerts/screen-alert-dialog";
import { leaveScreen } from "./leave-screen";
import { ScreenerSettingsDialog } from "./ScreenerSettingsDialog";
import { screenerFields, screenerScan } from "../../data/screener-api";
import { planScreen } from "../../data/screener-query";
import { watchlistTickers } from "./FilterPills";
import { MAX_ROWS, csvFileName, downloadText, screenCsv } from "./screener-csv";

/** `copyOf`: "Make a copy" of an Open screen row (`source`), not opened. */
type NameDialog = { mode: "saveAs" | "copy" | "copyOf" | "rename" | "create"; initial: string; source?: Screen };

type Props = {
  /** The control panel's Maximize is on (see the header). */
  maximized?: boolean;
  /** Maximized: the view's tools and Refresh, before the gear. */
  tools?: JSX.Element;
  /** A tight screener (under 548 px): no Undo / Redo (the reference app). */
  compact?: boolean;
  /** Maximized: the filters the hidden pills hold. */
  filterCount?: number;
  onMinimize?: () => void;
};

export function ScreenerTopbar(props: Props) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [dialog, setDialog] = createSignal<NameDialog | null>(null);
  const [browserOpen, setBrowserOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  let nameBtn!: HTMLDivElement;

  const save = () => {
    if (!screenerStore.save()) setDialog({ mode: "saveAs", initial: screenerStore.screen().title });
  };
  const submitName = (name: string) => {
    const d = dialog();
    if (!d) return;
    if (d.mode === "rename") screenerStore.rename(name);
    else if (d.mode === "create") leaveScreen(() => screenerStore.createNew(name));
    else if (d.mode === "copyOf" && d.source) screenerStore.copyOf(d.source, name);
    else screenerStore.saveAs(name);
  };
  /** Every row of the screen (its own scan), in the reference CSV format. */
  const downloadCsv = async () => {
    const s = screenerStore.screen();
    const known = new Set((await screenerFields()).filter((f) => f.available).map((f) => f.id));
    const plan = planScreen(s, (f) => known.has(f), watchlistTickers(s.watchlistId));
    const res = await screenerScan({ columns: plan.fields, filter: plan.filter, sort: plan.sort, range: [0, MAX_ROWS], tickers: plan.tickers });
    downloadText(csvFileName(s.title), screenCsv(res.rows, plan.columns, plan.fields));
  };
  const run = (fn: () => void) => {
    setMenuOpen(false);
    fn();
  };

  return (
    <div class="scr-topbar">
      <div class="scr-topbar-actions">
        <div
          ref={nameBtn}
          role="button"
          tabIndex={0}
          class="scr-screen-name"
          classList={{ "is-open": menuOpen() }}
          data-name="screener-topbar-screen-title"
          onClick={() => setMenuOpen(!menuOpen())}
        >
          <h2 class="scr-screen-title" title={screenerStore.screen().title}>{screenerStore.screen().title}</h2>
          <span class="scr-screen-caret" classList={{ "is-open": menuOpen() }}><Icon name="scr-caret" size={18} /></span>
        </div>
        <Show when={screenerStore.unsaved()}>
          <button type="button" class="scr-light-btn scr-save-btn" title="Save screen" onClick={save}>
            <Icon name="scr-save" size={28} />
            <span class="scr-light-btn-text">Save</span>
          </button>
        </Show>
      </div>
      <div class="scr-topbar-controls" classList={{ "is-maximized": !!props.maximized }}>
        <Show when={props.maximized}>{props.tools}</Show>
        <Show when={!props.maximized && !props.compact}>
        <button
          type="button"
          class="scr-light-btn scr-light-btn--ghost is-icon-only is-small-icon"
          title="Undo last action"
          aria-label="Undo last action"
          disabled={!screenerStore.canUndo()}
          onClick={() => screenerStore.undo()}
        >
          <Icon name="scr-undo" size={18} />
        </button>
        <button
          type="button"
          class="scr-light-btn scr-light-btn--ghost is-icon-only is-small-icon"
          title="Redo last action"
          aria-label="Redo last action"
          disabled={!screenerStore.canRedo()}
          onClick={() => screenerStore.redo()}
        >
          <Icon name="scr-redo" size={18} />
        </button>
        </Show>
        <button
          type="button"
          class="scr-light-btn scr-light-btn--secondary is-icon-only"
          title="Settings"
          aria-label="Settings"
          data-qa-id="screener-topbar-settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="scr-settings" size={28} />
        </button>
        <Show when={props.maximized}>
          <div class="scr-refresh-wrap">
            <button
              type="button"
              class="scr-light-btn scr-light-btn--secondary is-icon-only"
              title="Minimize"
              aria-label="Minimize"
              data-qa-id="screener-exit-fullscreen"
              onClick={() => props.onMinimize?.()}
            >
              <Icon name="scr-minimize" size={28} />
            </button>
            <Show when={(props.filterCount ?? 0) > 0}>
              <span class="scr-counter scr-counter--bold">{props.filterCount}</span>
            </Show>
          </div>
        </Show>
      </div>
      <Show when={settingsOpen()}>
        <ScreenerSettingsDialog onClose={() => setSettingsOpen(false)} />
      </Show>

      <Show when={menuOpen()}>
        <Popover anchor={nameBtn} onClose={() => setMenuOpen(false)} width={320} class="scr-screen-menu">
          <PopItem title="Save screen" iconSpace disabled={!screenerStore.unsaved()} onClick={() => run(save)} />
          <div
            class="scr-item scr-autosave"
            classList={{ "is-disabled": !screenerStore.saved() }}
            role="menuitemcheckbox"
            aria-checked={screenerStore.autosave()}
            aria-disabled={!screenerStore.saved()}
            title={screenerStore.saved() ? undefined : "Save the screen first"}
            onClick={() => screenerStore.saved() && screenerStore.setAutosave(!screenerStore.autosave())}
          >
            <span class="scr-item-icon" />
            <span class="scr-item-text"><span class="scr-item-title">Autosave</span></span>
            <span class={"switch-view" + (screenerStore.autosave() ? " checked" : "")} role="switch" aria-checked={screenerStore.autosave()}>
              <span class="switch-thumb" />
            </span>
          </div>
          <PopItem
            title="Make a copy…"
            icon="scr-menu-copy"
            onClick={() => run(() => setDialog({ mode: "copy", initial: `${screenerStore.screen().title} copy` }))}
          />
          <PopItem title="Rename…" icon="scr-menu-rename" onClick={() => run(() => setDialog({ mode: "rename", initial: screenerStore.screen().title }))} />
          <PopItem title="Download results as CSV" iconSpace onClick={() => run(() => void downloadCsv())} />
          <PopDivider />
          <PopItem title="Create new screen…" iconSpace onClick={() => run(() => setDialog({ mode: "create", initial: "" }))} />
          <PopItem
            title="Add alert…"
            description={screenerStore.savedId() ? undefined : "Save the screen first"}
            iconSpace
            disabled={!screenerStore.saved()}
            onClick={() => run(() => {
              const s = screenerStore.saved();
              if (s) openScreenAlertDialog({ screen: { id: s.id, title: s.screen.title } });
            })}
          />
          <Show when={screenerStore.recentScreens().length > 0}>
            <PopDivider />
            <PopSectionTitle title="Recently used" />
            <For each={screenerStore.recentScreens()}>
              {(s) => (
                <PopItem title={s.screen.title} selected={s.id === screenerStore.savedId()} onClick={() => run(() => leaveScreen(() => screenerStore.open(s.id)))} />
              )}
            </For>
          </Show>
          <PopDivider />
          <PopItem title="Open screen…" icon="scr-menu-open" onClick={() => run(() => setBrowserOpen(true))} />
        </Popover>
      </Show>
      <Show when={dialog()} keyed>
        {(d) => (
          <LayoutNameDialog
            title={d.mode === "rename" ? "Rename screen" : d.mode === "create" ? "Create new screen" : "Save screen as"}
            submitLabel={d.mode === "rename" ? "Rename" : "Save"}
            fieldLabel="New screen name"
            initialValue={d.initial}
            onSubmit={submitName}
            onClose={() => setDialog(null)}
          />
        )}
      </Show>
      <Show when={browserOpen()}>
        <ScreenBrowserDialog
          onClose={() => setBrowserOpen(false)}
          onCopy={(src) => setDialog({ mode: "copyOf", initial: `${src.title} copy`, source: src })}
        />
      </Show>
    </div>
  );
}
