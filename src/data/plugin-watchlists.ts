/*
 * Data plugins' ready-made watchlists (#381, `data.watchlists` in plugins/PROTOCOL.md): the index members, the
 * contracts of the month… The Watchlists dialog offers them under each plugin's name. A list opened once becomes a
 * store list tied to the plugin's list (`source`): read-only, and brought up to date by the main window whenever the
 * plugin sends its lists again. A list the plugin's set leaves out stays as it was, marked, with the user's favourite,
 * sections and alert, until the plugin sends it again (#423: a plugin waiting for its login sent none, and the lists
 * came back without their favourite); the user deletes it, or it goes with its plugin when that is removed. The lists of
 * a plugin turned off stay as they were. "Make a copy" gives the user a list of their own.
 */
import { createRoot, createEffect, createSignal, on } from "solid-js";
import { commands, events, type PluginWatchlist, type PluginWatchlists } from "../bindings";
import { newRow, watchlistStore } from "./watchlist-store";
import type { Group, Row } from "./watchlist";

const [sets, setSets] = createSignal<PluginWatchlists[]>([]);

/** The data plugins' watchlists, by plugin (empty outside the desktop app). */
export const pluginWatchlists = sets;

let listening = false;
/** Read the plugins' lists, and again whenever one sends its own. Each window calls it once. */
function listen(): void {
  if (listening || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  listening = true;
  const read = () => void commands.pluginWatchlists().then(setSets, () => undefined);
  void events.pluginWatchlistsChanged.listen(read);
  read();
}
listen();

/** A plugin's list as store rows: its symbols with no section, then its sections. */
export function listRows(l: PluginWatchlist): { groups: Group[]; extras: Row[] } {
  return {
    extras: l.symbols.map(newRow),
    groups: l.sections.map((s) => ({ name: s.name, rows: s.symbols.map(newRow) })),
  };
}

/** Symbols of a plugin's list (the dialog's count). */
export const itemCount = (l: PluginWatchlist): number => l.symbols.length + l.sections.reduce((n, s) => n + s.symbols.length, 0);

/** Open a plugin's list: its store list, made the first time. */
export function openPluginList(plugin: string, l: PluginWatchlist): void {
  const { groups, extras } = listRows(l);
  watchlistStore.setActive(watchlistStore.setPluginList({ plugin, list: l.id }, l.name, groups, extras));
}

/** Main window: the store lists of the plugins' lists follow what the plugins send, and go with a removed plugin. */
export function startPluginListSync(): () => void {
  const removed = events.pluginRemoved.listen(({ payload }) => watchlistStore.deletePluginLists(payload.plugin));
  return createRoot((dispose) => {
    createEffect(on(sets, (all) => syncPluginLists(all)));
    return () => {
      dispose();
      void removed.then((stop) => stop());
    };
  });
}

export function syncPluginLists(all: readonly PluginWatchlists[]): void {
  for (const set of all) {
    const sent = new Map(set.lists.map((l) => [l.id, l]));
    for (const l of watchlistStore.lists().filter((x) => x.source?.plugin === set.plugin)) {
      const p = sent.get(l.source!.list);
      if (!p) {
        watchlistStore.markPluginListUnsent(l.id);
        continue;
      }
      const { groups, extras } = listRows(p);
      watchlistStore.setPluginList(l.source!, p.name, groups, extras);
    }
  }
}
