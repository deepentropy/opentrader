/*
 * Trading confirmations of the chart lines: "Cancel order" (Keep order /
 * Cancel order) and "Close position" (Cancel / Close position), each with the
 * symbol logo, the symbol and the order or position.
 */
import { Show, createSignal } from "solid-js";
import { showConfirm } from "../../components/Dialogs";
import { replayBroker } from "../../data/trading/replay-broker";
import type { TradingOrder, TradingPosition } from "../../data/trading/types";
import { cancelTitle, orderSummary, positionSummary } from "../chart/trading-lines-model";

function tickOf(): number {
  return replayBroker.quote()?.minTick ?? 0.01;
}

/** Symbol logo (round, 32 px); its first letter when there is none. */
function SymbolLogo(props: { symbol: string }) {
  const [failed, setFailed] = createSignal(false);
  const url = () => replayBroker.iconUrl(props.symbol);
  const letter = () => (props.symbol.split(":").pop() ?? props.symbol).charAt(0).toUpperCase();
  return (
    <Show when={url() && !failed()} fallback={<span class="ot-trd-confirm__logo is-letter">{letter()}</span>}>
      <img class="ot-trd-confirm__logo" src={url()!} alt="" onError={() => setFailed(true)} />
    </Show>
  );
}

function Body(props: { symbol: string; line: string }) {
  return (
    <div class="ot-trd-confirm">
      <SymbolLogo symbol={props.symbol} />
      <div class="ot-trd-confirm__text">
        <div class="ot-trd-confirm__symbol">{props.symbol}</div>
        <div class="ot-trd-confirm__line">{props.line}</div>
      </div>
    </div>
  );
}

export function confirmCancelOrder(order: TradingOrder, onConfirm: () => void) {
  const line = orderSummary(order, tickOf());
  showConfirm({
    title: cancelTitle(order),
    text: "",
    mainText: "Cancel order",
    cancelText: "Keep order",
    intent: "neutral",
    body: () => <Body symbol={order.symbol} line={line} />,
    onConfirm,
  });
}

export function confirmClosePosition(pos: TradingPosition, onConfirm: () => void) {
  const line = positionSummary(pos, tickOf());
  showConfirm({
    title: "Close position",
    text: "",
    mainText: "Close position",
    cancelText: "Cancel",
    intent: "neutral",
    body: () => <Body symbol={pos.symbol} line={line} />,
    onConfirm,
  });
}
