/*
 * Shown in every window once the market data server stops serving this
 * version (`updateRequired`, see src-tauri/src/app_update.rs): the charts and
 * quotes stay empty until the app is updated. Offers the update as far as it
 * got: relaunch when it is ready, its progress meanwhile, the download page
 * where the app cannot update itself (Linux, or a failed download).
 *
 * Also shown when the server disabled this copy (`installDisabled`, a revoked
 * install, gateway#16): the support address and the code to quote, which can
 * be copied. Lifted on the server's side, the banner goes at the next call.
 */
import { Match, Show, Switch } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { appUpdateStatus, installDisabled, installUpdate, updateRequired } from "../../data/app-update";
import { translateWith } from "../../i18n/translator";

const SUPPORT = "support@opentrader.markets";

const DOWNLOAD_URL = "https://opentrader.markets";

export function UpdateRequiredBanner() {
  const state = () => appUpdateStatus().state;
  return (
    <>
    <Show when={installDisabled()}>
      {(code) => (
        <div class="ot-update-required" role="alert">
          <span>{translateWith("This copy of OpenTrader has been disabled. If you think this is a mistake, write to {0} with the code:", SUPPORT)}</span>
          <code>{code()}</code>
          <button type="button" onClick={() => void navigator.clipboard.writeText(code()).catch((e) => console.warn("[install] copy code failed", e))}>
            Copy code
          </button>
        </div>
      )}
    </Show>
    <Show when={updateRequired() && !installDisabled()}>
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
    </>
  );
}
