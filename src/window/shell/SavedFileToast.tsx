/*
 * "File downloaded" (#369): after an export is saved on the desktop
 * (data/save-file.ts), as the reference app's download toast: a bar at the
 * bottom centre of the window with a check, the text and "Show in folder",
 * gone after 4 s or when the window is resized.
 */
import { Show, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { commands } from "../../bindings";
import { hideSavedFile, savedFile } from "../../data/save-file";
import { CheckIcon } from "../trading/icons";

const HIDE_MS = 4_000;

export function SavedFileToast() {
  createEffect(() => {
    if (!savedFile()) return;
    const timer = window.setTimeout(hideSavedFile, HIDE_MS);
    window.addEventListener("resize", hideSavedFile);
    onCleanup(() => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", hideSavedFile);
    });
  });
  return (
    <Show when={savedFile()}>
      {(f) => (
        <Portal>
          <div class="ot-saved-toast" role="status" data-name="file-downloaded-toast">
            <span class="ot-saved-toast-icon"><CheckIcon /></span>
            <span class="ot-saved-toast-text">File downloaded</span>
            <button
              type="button"
              class="ot-saved-toast-btn"
              onClick={() => {
                void commands.openFolder(f().folder).catch(() => {});
                hideSavedFile();
              }}
            >
              Show in folder
            </button>
          </div>
        </Portal>
      )}
    </Show>
  );
}
