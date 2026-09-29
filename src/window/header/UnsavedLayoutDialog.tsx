/*
 * UnsavedLayoutDialog — TV's "unsaved-changes" warning, shown before another
 * layout replaces the active tab while it has unsaved changes (TV's
 * loadChart: showWarning when chartWidgetCollection.hasChanges()).
 *
 * Captured from the desktop 3.4.1 on 23/09/2026 by rendering TV's own
 * showWarning: a 480px
 * #1F1F1F panel, radius 6, centred, no dimmed backdrop; 40px margins; title
 * 20/600, text 16/400; footer buttons right-aligned Cancel / Don't save /
 * Save (34px, radius 6, 12px apart); a 34px close button top-right.
 * Save = save then switch, Don't save = switch, Cancel / close / Esc = stay.
 */
import { onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

type Props = {
  onSave: () => void;
  onDontSave: () => void;
  onCancel: () => void;
};

export function UnsavedLayoutDialog(props: Props) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  return (
    <Portal mount={document.body}>
      {/* Transparent click-blocker, like TV's (no dimming). */}
      <div class="unsaved-layout-overlay">
        <div class="unsaved-layout-dialog" role="dialog" aria-modal="true" data-name="warning-dialog"
          aria-labelledby="unsaved-layout-title">
          <div class="unsaved-layout-main">
            <div class="unsaved-layout-title" id="unsaved-layout-title">Save layout before switching?</div>
            <div class="unsaved-layout-content">
              You'll lose unsaved changes in a chart layout if you switch to another without saving.
            </div>
            <div class="unsaved-layout-footer">
              <button type="button" class="unsaved-layout-btn is-gray" data-name="cancel" onClick={() => props.onCancel()}>
                Cancel
              </button>
              <button type="button" class="unsaved-layout-btn is-stroke" data-name="dontSave" onClick={() => props.onDontSave()}>
                Don't save
              </button>
              <button type="button" class="unsaved-layout-btn is-primary" data-name="save" onClick={() => props.onSave()}>
                Save
              </button>
            </div>
          </div>
          <button type="button" class="unsaved-layout-close" data-name="close" aria-label="Close" onClick={() => props.onCancel()}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 17 17" width="17" height="17" fill="currentColor">
              <path d="m.58 1.42.82-.82 15 15-.82.82z" />
              <path d="m.58 15.58 15-15 .82.82-15 15z" />
            </svg>
          </button>
        </div>
      </div>
    </Portal>
  );
}
