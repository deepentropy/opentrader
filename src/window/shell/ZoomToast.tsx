/*
 * "Zoom 110%" for 2 s at the top of the window that changed the app zoom
 * (main menu Zoom row, Ctrl + = / - / 0), as the reference app shows it.
 */
import { Show } from "solid-js";
import { zoom, zoomPercent, zoomToastShown } from "../../data/app-zoom";
import { translateWith } from "../../i18n/translator";

export function ZoomToast() {
  return (
    <Show when={zoomToastShown()}>
      <div class="zoom-toast" role="status">{translateWith("Zoom {0}", `${zoomPercent(zoom())}%`)}</div>
    </Show>
  );
}
