/*
 * ScreenerTopbar: screen name menu, Save button, Undo / Redo (TradingView
 * Desktop 3.4.1 topbar: padding 8 20 12, 20 px / 600 title with an 18 px
 * caret, 34 px buttons).
 *
 * Screen menu (local actions only): Save screen, Make a copy…, Rename…,
 * Create new screen…, Recently used, Open screen…. The account items
 * (Autosave, Share screen) and Download results as CSV are not shown.
 */
import { For, Show, createSignal } from "solid-js";
import { Icon } from "../../components/Icon";
import { LayoutNameDialog } from "../header/LayoutNameDialog";
import { screenerStore } from "../../data/screener-store";
import { PopDivider, PopItem, PopSectionTitle, Popover } from "./Popover";
import { ScreenBrowserDialog } from "./ScreenBrowserDialog";

type NameDialog = { mode: "saveAs" | "copy" | "rename" | "create"; initial: string };

export function ScreenerTopbar() {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [dialog, setDialog] = createSignal<NameDialog | null>(null);
  const [browserOpen, setBrowserOpen] = createSignal(false);
  let nameBtn!: HTMLDivElement;

  const save = () => {
    if (!screenerStore.save()) setDialog({ mode: "saveAs", initial: screenerStore.screen().title });
  };
  const submitName = (name: string) => {
    const d = dialog();
    if (!d) return;
    if (d.mode === "rename") screenerStore.rename(name);
    else if (d.mode === "create") screenerStore.createNew(name);
    else screenerStore.saveAs(name);
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
      <div class="scr-topbar-controls">
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
      </div>

      <Show when={menuOpen()}>
        <Popover anchor={nameBtn} onClose={() => setMenuOpen(false)} width={320} class="scr-screen-menu">
          <PopItem title="Save screen" iconSpace disabled={!screenerStore.unsaved()} onClick={() => run(save)} />
          <PopItem
            title="Make a copy…"
            icon="scr-menu-copy"
            onClick={() => run(() => setDialog({ mode: "copy", initial: `${screenerStore.screen().title} copy` }))}
          />
          <PopItem title="Rename…" icon="scr-menu-rename" onClick={() => run(() => setDialog({ mode: "rename", initial: screenerStore.screen().title }))} />
          <PopDivider />
          <PopItem title="Create new screen…" iconSpace onClick={() => run(() => setDialog({ mode: "create", initial: "" }))} />
          <Show when={screenerStore.recentScreens().length > 0}>
            <PopDivider />
            <PopSectionTitle title="Recently used" />
            <For each={screenerStore.recentScreens()}>
              {(s) => (
                <PopItem title={s.screen.title} selected={s.id === screenerStore.savedId()} onClick={() => run(() => screenerStore.open(s.id))} />
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
        <ScreenBrowserDialog onClose={() => setBrowserOpen(false)} />
      </Show>
    </div>
  );
}
