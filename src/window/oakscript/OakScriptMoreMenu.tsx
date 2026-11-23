/*
 * The OakScript editor's More menu (#324), from the ⋯ button at the right of its header, as the reference's: Editor
 * settings…, "Open editor" (#325: New window / New tab under the chart, In-place out of it), "Developer tools":
 * Profiler mode (a switch, #312; not out of the chart), Logs (#323) and Command palette, then Release notes (a dot
 * until the notes of the shown engine version are opened) and Help ▸ (help-links.ts).
 */
import { For, Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { createPopover } from "../../components/popover";
import { fitToWindow } from "../../components/menu-fit";
import { SwitchMark } from "../../components/form";
import { Icon } from "../../components/Icon";
import type { DetachMode } from "./detached-editor";
import { HELP_SECTIONS, RELEASE_NOTES_URL, openHelpLink, releaseNotesNew, releaseNotesOpened } from "./help-links";

export type OpenEditorItem = "in-place" | DetachMode;

const OPEN_EDITOR_ITEMS: Record<OpenEditorItem, { label: string; icon: string; qa: string }> = {
  window: { label: "New window", icon: "oak-open-window", qa: "detach-window" },
  tab: { label: "New tab", icon: "oak-open-tab", qa: "detach-tab" },
  "in-place": { label: "In-place", icon: "oak-open-in-place", qa: "detach-inplace" },
};

type Props = {
  anchor: HTMLElement;
  /** Profiler mode's switch; null: not offered. */
  profiler: boolean | null;
  /** The "Open editor" rows offered (none: no section). */
  openEditor: OpenEditorItem[];
  onOpenEditor: (where: OpenEditorItem) => void;
  onEditorSettings: () => void;
  onProfiler: () => void;
  onLogs: () => void;
  onCommandPalette: () => void;
  /** Help ▸ Keyboard shortcuts (absent: not offered, a window without the panel). */
  onShortcuts?: () => void;
  onClose: () => void;
};

export function OakScriptMoreMenu(props: Props) {
  const popover = createPopover(() => props.anchor, {
    onClose: () => props.onClose(),
    placement: { side: "above", gap: 6, align: "end" },
    // The Help submenu is a popup of its own: a press in it is not outside.
    insideSelector: ".oak-panel__more-btn, .oak-more-submenu",
    escape: "pass",
    on: { target: "window", capture: false },
  });
  const [helpRow, setHelpRow] = createSignal<HTMLElement | null>(null);
  let closeTimer: number | undefined;
  onCleanup(() => clearTimeout(closeTimer));
  const showHelp = (row: HTMLElement) => {
    clearTimeout(closeTimer);
    setHelpRow(row);
  };
  // Leaving the Help row for the submenu keeps it open.
  const hideHelpSoon = () => {
    clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => setHelpRow(null), 250);
  };

  const item = (label: string, action: () => void, icon?: string, qa?: string) => (
    <button
      type="button"
      role="menuitem"
      class="ot-menu-item"
      data-qa-id={qa}
      onMouseEnter={() => hideHelpSoon()}
      onClick={() => {
        action();
        props.onClose();
      }}
    >
      <span class="ot-menu-item__icon" aria-hidden="true">
        <Show when={icon}>{(name) => <Icon name={name()} size={28} />}</Show>
      </span>
      <span class="ot-menu-item__label">{label}</span>
    </button>
  );
  return (
    <Portal>
      <div ref={popover} class="ot-popover oak-more-menu" role="menu" aria-label="More">
        {item("Editor settings…", props.onEditorSettings)}
        <Show when={props.openEditor.length > 0}>
          <div class="ot-popover__divider" />
          <div class="oak-script-menu__section">Open editor</div>
          <For each={props.openEditor}>
            {(where) => item(OPEN_EDITOR_ITEMS[where].label, () => props.onOpenEditor(where), OPEN_EDITOR_ITEMS[where].icon, OPEN_EDITOR_ITEMS[where].qa)}
          </For>
        </Show>
        <div class="ot-popover__divider" />
        <div class="oak-script-menu__section">Developer tools</div>
        <Show when={props.profiler !== null}>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={!!props.profiler}
            class="ot-menu-item oak-more-menu__switch-row"
            data-qa-id="oakscript-profiler-mode"
            onMouseEnter={() => hideHelpSoon()}
            onClick={() => props.onProfiler()}
          >
            <span class="ot-menu-item__icon" aria-hidden="true" />
            <span class="ot-menu-item__label">Profiler mode</span>
            <SwitchMark on={!!props.profiler} variant="header" />
          </button>
        </Show>
        {item("Logs", props.onLogs)}
        {item("Command palette", props.onCommandPalette)}
        <div class="ot-popover__divider" />
        <button
          type="button"
          role="menuitem"
          class="ot-menu-item oak-more-menu__link-row"
          data-qa-id="oakscript-release-notes"
          onMouseEnter={() => hideHelpSoon()}
          onClick={() => {
            releaseNotesOpened();
            openHelpLink(RELEASE_NOTES_URL);
            props.onClose();
          }}
        >
          <span class="ot-menu-item__icon" aria-hidden="true" />
          <span class="ot-menu-item__label">
            Release notes
            <Show when={releaseNotesNew()}>
              <span class="oak-more-menu__new-dot" aria-hidden="true" />
            </Show>
          </span>
          <span class="oak-more-menu__trail" aria-hidden="true">
            <Icon name="oak-external-link" size={18} />
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={helpRow() !== null}
          class="ot-menu-item oak-more-menu__link-row"
          classList={{ "ot-menu-item--current": helpRow() !== null }}
          data-qa-id="oakscript-help"
          onMouseEnter={(e) => showHelp(e.currentTarget)}
          onMouseLeave={() => hideHelpSoon()}
          onClick={(e) => showHelp(e.currentTarget)}
        >
          <span class="ot-menu-item__icon" aria-hidden="true" />
          <span class="ot-menu-item__label">Help</span>
          <span class="oak-more-menu__chevron" aria-hidden="true">›</span>
        </button>
      </div>
      <Show when={helpRow()}>
        {(row) => (
          <div
            ref={(el) =>
              queueMicrotask(() => {
                const r = row().getBoundingClientRect();
                // Toward the start side: the More menu sits at the end edge of the editor.
                fitToWindow(el, r.left, r.top - 4, true);
              })
            }
            class="ot-popover oak-more-menu oak-more-submenu"
            role="menu"
            aria-label="Help"
            data-qa-id="oakscript-help-menu"
            onMouseEnter={() => clearTimeout(closeTimer)}
            onMouseLeave={() => hideHelpSoon()}
          >
            <For each={HELP_SECTIONS}>
              {(section, i) => (
                <>
                  <Show when={i() > 0}>
                    <div class="ot-popover__divider" />
                  </Show>
                  <div class="oak-script-menu__section">{section.title}</div>
                  <For each={section.items.filter((x) => x.url || props.onShortcuts)}>
                    {(link) => (
                      <button
                        type="button"
                        role="menuitem"
                        class="ot-menu-item oak-more-menu__link-row"
                        onClick={() => {
                          if (link.url) openHelpLink(link.url);
                          else props.onShortcuts?.();
                          props.onClose();
                        }}
                      >
                        <span class="ot-menu-item__icon" aria-hidden="true">
                          <Icon name={link.icon} size={28} />
                        </span>
                        <span class="ot-menu-item__label">{link.label}</span>
                        <Show when={link.url}>
                          <span class="oak-more-menu__trail" aria-hidden="true">
                            <Icon name="oak-external-link" size={18} />
                          </span>
                        </Show>
                      </button>
                    )}
                  </For>
                </>
              )}
            </For>
          </div>
        )}
      </Show>
    </Portal>
  );
}
