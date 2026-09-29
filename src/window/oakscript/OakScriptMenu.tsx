/*
 * OakScriptMenu — the dropdown opened from the script-name button in the
 * OakScript drawer header: actions, a
 * "Recently used" script list with the current one highlighted, then open/
 * import/export. Same .ot-popover / .ot-menu-item idiom as WatchlistMenu;
 * opens UPWARD (the drawer hugs the window bottom).
 *
 * "Open built-in source" (Create new → Built-in...) is deliberately
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
      class={`ot-menu-item${danger ? " oak-script-menu__danger" : ""}`}
      onClick={() => {
        action();
        props.onClose();
      }}
    >
      {/* .ot-menu-item is a 28px|1fr|auto grid — keep the icon cell even
          when empty so the label lands in the text column. */}
      <span class="ot-menu-item__icon" aria-hidden="true" />
      <span class="ot-menu-item__label">{label}</span>
    </button>
  );

  return (
    <div ref={root} class="ot-popover oak-script-menu" role="menu" aria-label="Script menu">
      {item("Make a copy", props.onCopy)}
      {item("Rename…", props.onRename)}
      <div class="ot-popover__divider" />
      {item("Create new indicator", props.onCreateNew)}
      <div class="ot-popover__divider" />
      <Show when={props.scriptsList.length > 0}>
        <div class="oak-script-menu__section">Recently used</div>
        <For each={props.scriptsList}>
          {(s) => (
            <button
              type="button"
              role="menuitem"
              class={`ot-menu-item${s.id === props.currentId ? " ot-menu-item--current" : ""}`}
              onClick={() => {
                props.onSelect(s.id);
                props.onClose();
              }}
            >
              <span class="ot-menu-item__icon" aria-hidden="true" />
              <span class="ot-menu-item__label">{s.name}</span>
            </button>
          )}
        </For>
        <div class="ot-popover__divider" />
      </Show>
      {item("Export script…", props.onExport)}
      {item("Import script…", props.onImport)}
      <div class="ot-popover__divider" />
      {item("Delete script", props.onDelete, true)}
    </div>
  );
}
