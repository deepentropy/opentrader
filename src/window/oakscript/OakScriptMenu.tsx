/*
 * OakScriptMenu — the dropdown opened from the script-name button in the
 * OakScript drawer header: actions, a
 * "Recently used" script list with the current one highlighted, then open/
 * import/export. Same .ot-popover / .ot-menu-item idiom as WatchlistMenu;
 * opens UPWARD (the drawer hugs the window bottom).
 *
 * A built-in shown read-only (reference rules): "Make a copy…" stays,
 * "Rename…" is disabled; it cannot be deleted either. "Built-in…" (the
 * reference's Create new > Built-in…) opens the list of built-in sources.
 */
import { For, Show, onCleanup, onMount } from "solid-js";
import type { OakScriptMeta } from "../../data/oakscript-store";

type Props = {
  scriptsList: OakScriptMeta[];
  currentId: string;
  /** The current script is a built-in shown read-only. */
  readOnly?: boolean;
  onSelect: (id: string) => void;
  onCopy: () => void;
  onRename: () => void;
  onCreateNew: () => void;
  onBuiltin: () => void;
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

  const item = (label: string, action: () => void, opts: { danger?: boolean; disabled?: boolean } = {}) => (
    <button
      type="button"
      role="menuitem"
      class={`ot-menu-item${opts.danger ? " oak-script-menu__danger" : ""}${opts.disabled ? " ot-menu-item--disabled" : ""}`}
      disabled={opts.disabled}
      aria-disabled={opts.disabled}
      onClick={() => {
        if (opts.disabled) return;
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
      {item("Make a copy…", props.onCopy)}
      {item("Rename…", props.onRename, { disabled: props.readOnly })}
      <div class="ot-popover__divider" />
      {item("Create new indicator", props.onCreateNew)}
      {item("Built-in…", props.onBuiltin)}
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
      {item("Delete script", props.onDelete, { danger: true, disabled: props.readOnly })}
    </div>
  );
}
