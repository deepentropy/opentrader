/*
 * Header "Trade" button while Bar Replay is on (trading through the replay
 * broker): a pill with the replay mark that shows / hides the order ticket,
 * and a "Trading options" chevron menu: "Replay settings…", "Exit replay
 * mode". (The reference app also offers "Connect to broker…"; this build has
 * no broker connection.)
 */
import { Show, createSignal } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { Popover, PopDivider, PopItem } from "../screener/Popover";
import { tradingUi } from "../../data/trading/trading-ui";
import { requestCloseReplay } from "../replay/ReplayHeaderButton";

export function TradeHeaderButton() {
  let chevron: HTMLButtonElement | undefined;
  const [menu, setMenu] = createSignal(false);
  return (
    <div class="trd-trade-btn" data-name="trade-button">
      <Tooltip text="Place an order via order ticket or DOM" side="bottom">
        <button type="button" class="trd-trade-pill" aria-pressed={tradingUi.ticketOpen()} onClick={() => tradingUi.toggleTicket()}>
          <span class="trd-trade-mark">
            <Icon name="replay-status" size={14} />
          </span>
          Trade
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
          <PopItem
            icon="header-settings"
            title="Replay settings…"
            onClick={() => {
              setMenu(false);
              tradingUi.openReplaySettings();
            }}
          />
          <PopDivider />
          <PopItem
            icon="trade-exit-replay"
            title="Exit replay mode"
            onClick={() => {
              setMenu(false);
              requestCloseReplay();
            }}
          />
        </Popover>
      </Show>
    </div>
  );
}
