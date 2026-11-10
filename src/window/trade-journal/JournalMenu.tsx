/*
 * Context menu of the Trade journal tab (its caret, like a strategy tab's):
 * the journals to show, Import trades (once there is a journal: before, the
 * panel's own Import button is the way in), Rename / Read the values again /
 * Delete the one shown, and closing the tab.
 */
import { For, Show } from "solid-js";
import { showConfirm, showRename } from "../../components/Dialogs";
import { Popover, PopItem, PopDivider } from "../screener/Popover";
import { tradeJournal } from "../../data/trade-journal";
import { pickTradeFile } from "./ImportTradesDialog";
import { translateWith } from "../../i18n/translator";

export function JournalMenu(props: { anchor: HTMLElement; onClose: () => void }) {
  const journal = () => tradeJournal.active();
  /** Close the menu, then run `fn` (the menu's accessors go stale once closed). */
  const run = (fn: () => void) => () => {
    props.onClose();
    fn();
  };
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} class="st-tab-menu" offset={{ x: 0, y: 4 }}>
      <For each={tradeJournal.journals()}>
        {(j) => <PopItem title={j.name} right={<span class="st-check">{j.id === journal()?.id ? "✓" : ""}</span>} onClick={run(() => tradeJournal.setActiveId(j.id))} />}
      </For>
      <Show when={tradeJournal.journals().length > 0}>
        <PopDivider />
      </Show>
      <Show when={journal()}>
        {(j) => {
          const { id, name, trades } = j();
          return (
            <>
              <PopItem title="Import trades…" onClick={run(pickTradeFile)} />
              <PopItem
                title="Rename…"
                onClick={run(() =>
                  showRename({
                    title: "Rename journal",
                    label: "Name",
                    maxLength: 64,
                    names: tradeJournal.journals().filter((x) => x.id !== id).map((x) => x.name),
                    replaceText: (n) => `A journal named "${n}" exists. Use this name too?`,
                    initialValue: name,
                    onSave: (n) => tradeJournal.rename(id, n),
                  }),
                )}
              />
              <PopItem title="Read the values again" onClick={run(() => tradeJournal.recompute(id))} />
              <PopItem
                title="Delete…"
                onClick={run(() =>
                  showConfirm({
                    title: "Delete journal",
                    text: translateWith(trades.length === 1 ? 'Delete "{0}" and its {1} trade?' : 'Delete "{0}" and its {1} trades?', name, trades.length),
                    mainText: "Delete",
                    cancelText: "Cancel",
                    intent: "danger",
                    onConfirm: () => tradeJournal.remove(id),
                  }),
                )}
              />
            </>
          );
        }}
      </Show>
      <Show when={journal()}>
        <PopDivider />
      </Show>
      <PopItem title="Close trade journal" onClick={run(() => tradeJournal.setOpen(false))} />
    </Popover>
  );
}
