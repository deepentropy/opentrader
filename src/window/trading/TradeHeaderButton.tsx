/*
 * Header "Trade" button. In Bar Replay it trades through the replay broker: the pill shows / hides the order ticket,
 * the "Trading options" chevron offers "Replay settings…", "Connect to broker…" (leaves replay for the broker
 * selection) and "Exit replay mode". Otherwise it trades through the
 * broker plugin the user connected (#315): the pill opens the broker picker until one is connected, then the order
 * ticket; the chevron opens the trading settings, connects another broker, turns trading on or off, shows the account
 * manager and disconnects.
 * DEMO / LIVE next to the title tells which account the orders go to.
 */
import { Show, createSignal } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { Popover, PopDivider, PopItem } from "../screener/Popover";
import { emitAppEvent } from "../../data/app-events";
import { replayEnabled } from "../../data/replay";
import { pluginBroker } from "../../data/trading/plugin-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import { translate } from "../../i18n/translator";
import { requestCloseReplay } from "../replay/ReplayHeaderButton";
import { leaveReplayForBroker } from "./connect-broker";

export function TradeHeaderButton() {
  let chevron: HTMLButtonElement | undefined;
  const [menu, setMenu] = createSignal(false);
  const replay = () => replayEnabled();
  const account = () => pluginBroker.account()?.account ?? null;
  const onPill = () => {
    if (!replay() && !pluginBroker.status()?.active) tradingUi.setBrokerPicker(true);
    else tradingUi.toggleTicket();
  };
  const run = (fn: () => void) => () => {
    setMenu(false);
    fn();
  };
  return (
    <div class="trd-trade-btn" data-name="trade-button">
      <Tooltip text="Place an order via order ticket or DOM" side="bottom">
        <button type="button" class="trd-trade-pill" aria-pressed={tradingUi.ticketOpen()} onClick={onPill}>
          <Show when={replay()}>
            <span class="trd-trade-mark">
              <Icon name="replay-status" size={14} />
            </span>
          </Show>
          Trade
          <Show when={!replay() && account()}>
            {(a) => (
              <span class="trd-account-kind" classList={{ "is-live": !a().isDemo, "is-off": !pluginBroker.status()?.tradingEnabled }} data-name="trade-account-kind">
                {a().isDemo ? translate("DEMO") : translate("LIVE")}
              </span>
            )}
          </Show>
        </button>
      </Tooltip>
      <Tooltip text="Trading options" side="bottom">
        <button
          type="button"
          ref={chevron}
          class="trd-trade-chevron"
          classList={{ "is-open": menu() }}
          aria-label="Trading options"
          aria-haspopup="menu"
          aria-expanded={menu()}
          onClick={() => setMenu(!menu())}
        >
          <Icon name="header-replay-mode" size={8} />
        </button>
      </Tooltip>
      <Show when={menu()}>
        <Popover anchor={chevron} onClose={() => setMenu(false)} class="trd-trade-menu" offset={{ x: 0, y: 4 }}>
          <Show
            when={!replay()}
            fallback={
              <>
                <PopItem icon="header-settings" title="Replay settings…" onClick={run(() => tradingUi.openReplaySettings())} />
                <PopDivider />
                <PopItem icon="trade-connect-broker" title={translate("Connect to broker…")} onClick={run(leaveReplayForBroker)} />
                <PopDivider />
                <PopItem icon="trade-exit-replay" title="Exit replay mode" onClick={run(requestCloseReplay)} />
              </>
            }
          >
            <PopItem iconSpace title={translate("Trading settings…")} onClick={run(() => emitAppEvent("chart-open-settings", { tab: "trading" }))} />
            <PopItem
              iconSpace
              title={pluginBroker.status()?.active ? translate("Connect another broker…") : translate("Connect broker…")}
              onClick={run(() => tradingUi.setBrokerPicker(true))}
            />
            <Show when={pluginBroker.status()?.active}>
              <PopItem
                iconSpace
                title={pluginBroker.status()?.tradingEnabled ? translate("Turn trading off") : translate("Turn trading on")}
                description={pluginBroker.status()?.tradingEnabled ? undefined : translate("Orders can't be placed until trading is on.")}
                onClick={run(() => void pluginBroker.setTradingEnabled(!pluginBroker.status()?.tradingEnabled))}
              />
              <PopItem iconSpace title={translate("Account manager")} onClick={run(() => tradingUi.showAccountManager())} />
              <PopDivider />
              <PopItem iconSpace title={translate("Disconnect the broker")} onClick={run(() => void pluginBroker.setActive(null))} />
            </Show>
          </Show>
        </Popover>
      </Show>
    </div>
  );
}
