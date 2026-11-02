/*
 * Shown in every window once the market data server stops serving this
 * version (`updateRequired`, see src-tauri/src/app_update.rs): the charts and
 * quotes stay empty until the app is updated. Offers the update as far as it
 * got: relaunch when it is ready, its progress meanwhile, the download page
 * where the app cannot update itself (Linux, or a failed download).
 */
import { Match, Show, Switch } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { appUpdateStatus, installUpdate, updateRequired } from "../../data/app-update";

const DOWNLOAD_URL = "https://opentrader.markets";

export function UpdateRequiredBanner() {
  const state = () => appUpdateStatus().state;
  return (
    <Show when={updateRequired()}>
      <div class="ot-update-required" role="alert">
        <span>This version is no longer supported. Update to restore market data.</span>
        <Switch
          fallback={
            <button type="button" onClick={() => void openUrl(DOWNLOAD_URL).catch((e) => console.warn("[update] open download page failed", e))}>
              Download update
            </button>
          }
        >
          <Match when={state() === "ready-to-install"}>
            <button type="button" onClick={installUpdate}>
              Relaunch to update
            </button>
          </Match>
          <Match when={state() === "checking" || state() === "downloading"}>
            <span>Downloading the update…</span>
          </Match>
          <Match when={state() === "installing"}>
            <span>Installing…</span>
          </Match>
        </Switch>
      </div>
    </Show>
  );
}
