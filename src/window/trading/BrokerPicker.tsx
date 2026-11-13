/*
 * "Trade with your broker" (#315): the enabled broker plugins as cards; a click connects the window's trading to
 * it. Brokers come from plugins (Settings > Plugins), so the dialog ends with the way there.
 */
import { For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { createDialogKeys } from "../../components/Dialog";
import { pluginBroker } from "../../data/trading/plugin-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import { translate } from "../../i18n/translator";
import { setAppSettingsTab } from "../shell/app-dialogs";
import { CloseIcon } from "./icons";

/** Initials of a broker's name, as its mark. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

export function BrokerPicker() {
  const close = () => tradingUi.setBrokerPicker(false);
  createDialogKeys({ onEscape: close });
  const brokers = () => pluginBroker.status()?.brokers ?? [];
  return (
    <Portal>
      <div class="trd-dialog-layer" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div class="trd-select-dialog" data-name="select-broker-dialog" role="dialog" aria-label={translate("Trade with your broker")}>
          <button type="button" class="trd-dialog-close" aria-label={translate("Close")} onClick={close}>
            <CloseIcon />
          </button>
          <div class="trd-select-head">
            <h2 class="trd-select-title">Trade with your broker</h2>
          </div>
          <div class="trd-select-grid">
            <For each={brokers()} fallback={<div class="trd-select-empty">No broker plugin is enabled.</div>}>
              {(b) => (
                <button
                  type="button"
                  class="trd-broker-card"
                  classList={{ "is-active": pluginBroker.status()?.active === b.id }}
                  data-broker={b.id}
                  onClick={() => {
                    void pluginBroker.setActive(b.id);
                    close();
                    tradingUi.showAccountManager();
                  }}
                >
                  <span class="trd-broker-mark trd-broker-card-mark" data-no-translate>
                    {initials(b.name)}
                  </span>
                  <span class="trd-broker-card-name" data-no-translate>
                    {b.name}
                  </span>
                  <span class="trd-broker-card-note">{b.connected ? translate("Connected") : translate("Waiting for the plugin to connect")}</span>
                </button>
              )}
            </For>
          </div>
          <div class="trd-select-foot">
            <span>Brokers are plugins that run on this computer.</span>
            <button
              type="button"
              class="trd-select-link"
              onClick={() => {
                close();
                setAppSettingsTab("plugins");
              }}
            >
              Manage plugins…
            </button>
          </div>
          <Show when={pluginBroker.status()?.active}>
            <div class="trd-select-foot">
              <button
                type="button"
                class="trd-select-link"
                onClick={() => {
                  void pluginBroker.setActive(null);
                  close();
                }}
              >
                Disconnect the broker
              </button>
            </div>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
