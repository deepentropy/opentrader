/*
 * The OakScript editor's More menu (#324), from the ⋯ button at the right of its header, as the reference's: Editor
 * settings…, then "Developer tools": Profiler mode (a switch, #312), Logs (#323) and Command palette.
 */
import { Portal } from "solid-js/web";
import { createPopover } from "../../components/popover";
import { SwitchMark } from "../../components/form";

type Props = {
  anchor: HTMLElement;
  profiler: boolean;
  onEditorSettings: () => void;
  onProfiler: () => void;
  onLogs: () => void;
  onCommandPalette: () => void;
  onClose: () => void;
};

export function OakScriptMoreMenu(props: Props) {
  const popover = createPopover(() => props.anchor, {
    onClose: () => props.onClose(),
    placement: { side: "above", gap: 6, align: "end" },
    insideSelector: ".oak-panel__more-btn",
    escape: "pass",
    on: { target: "window", capture: false },
  });
  const item = (label: string, action: () => void) => (
    <button
      type="button"
      role="menuitem"
      class="ot-menu-item"
      onClick={() => {
        action();
        props.onClose();
      }}
    >
      <span class="ot-menu-item__icon" aria-hidden="true" />
      <span class="ot-menu-item__label">{label}</span>
    </button>
  );
  return (
    <Portal>
      <div ref={popover} class="ot-popover oak-more-menu" role="menu" aria-label="More">
        {item("Editor settings…", props.onEditorSettings)}
        <div class="ot-popover__divider" />
        <div class="oak-script-menu__section">Developer tools</div>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={props.profiler}
          class="ot-menu-item oak-more-menu__switch-row"
          data-qa-id="oakscript-profiler-mode"
          onClick={() => props.onProfiler()}
        >
          <span class="ot-menu-item__icon" aria-hidden="true" />
          <span class="ot-menu-item__label">Profiler mode</span>
          <SwitchMark on={props.profiler} variant="header" />
        </button>
        {item("Logs", props.onLogs)}
        {item("Command palette", props.onCommandPalette)}
      </div>
    </Portal>
  );
}
