/*
 * OakScriptMenu — the dropdown opened from the script-name button in the
 * OakScript drawer header. Mirrors TV's Pine editor script menu (probed live):
 * actions, a
 * "Recently used" script list with the current one highlighted, then open/
 * import/export. Same .tv-popover / .tv-menu-item idiom as WatchlistMenu;
 * opens UPWARD (the drawer hugs the window bottom).
 *
 * "Open built-in source" (TV: Create new → Built-in...) is deliberately
 * absent: the lightweight-charts-indicators npm package ships dist/ only, so
 * there is no per-indicator source to open until the package publishes src/.
 */
import { For, Show, onCleanup, onMount } from "solid-js";
import type { OakScriptMeta } from "../../data/oakscript-store";

type Props = {
  scriptsList: OakScriptMeta[];
  currentId: string;
  onSelect: (id: string) => void;
  onCopy: () => void;
  onRename: () => void;
  onCreateNew: () => void;
  onExport: () => void;
  onImport: () => void;
  onDelete: () => void;
  onClose: () => void;
};

export function OakScriptMenu(props: Props) {
  let root!: HTMLDivElement;

  onMount(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (root.contains(t) || t.closest?.(".oak-panel__name-btn")) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    });
  });

  const item = (label: string, action: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      class={`tv-menu-item${danger ? " oak-script-menu__danger" : ""}`}
      onClick={() => {
        action();
        props.onClose();
      }}
    >
      {/* .tv-menu-item is a 28px|1fr|auto grid — keep the icon cell even
          when empty so the label lands in the text column. */}
      <span class="tv-menu-item__icon" aria-hidden="true" />
      <span class="tv-menu-item__label">{label}</span>
    </button>
  );

  return (
    <div ref={root} class="tv-popover oak-script-menu" role="menu" aria-label="Script menu">
      {item("Make a copy", props.onCopy)}
      {item("Rename…", props.onRename)}
      <div class="tv-popover__divider" />
      {item("Create new indicator", props.onCreateNew)}
      <div class="tv-popover__divider" />
      <Show when={props.scriptsList.length > 0}>
        <div class="oak-script-menu__section">Recently used</div>
        <For each={props.scriptsList}>
          {(s) => (
            <button
              type="button"
              role="menuitem"
              class={`tv-menu-item${s.id === props.currentId ? " tv-menu-item--current" : ""}`}
              onClick={() => {
                props.onSelect(s.id);
                props.onClose();
              }}
            >
              <span class="tv-menu-item__icon" aria-hidden="true" />
              <span class="tv-menu-item__label">{s.name}</span>
            </button>
          )}
        </For>
        <div class="tv-popover__divider" />
      </Show>
      {item("Export script…", props.onExport)}
      {item("Import script…", props.onImport)}
      <div class="tv-popover__divider" />
      {item("Delete script", props.onDelete, true)}
    </div>
  );
}
