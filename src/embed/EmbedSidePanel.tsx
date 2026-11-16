/*
 * Right panel of an embedded chart (#338, #339): the embed's watchlist or the
 * market movers (a switch picks one when both are on), over the shown
 * symbol's details, each when the site asks for it. A click on a row shows
 * that symbol.
 */
import { createSignal, Show } from "solid-js";
import { Watchlist } from "../window/right-rail/Watchlist";
import { WatchlistDetail } from "../window/right-rail/WatchlistDetail";
import { MoversPanel } from "./MoversPanel";

type Props = {
  watchlist: boolean;
  movers: boolean;
  details: boolean;
  activeSymbol: string;
  interval: string;
  onSymbolSelect: (symbol: string) => void;
  onAddCompare: (tickers: string[]) => void;
};

export function EmbedSidePanel(props: Props) {
  const [shown, setShown] = createSignal<"watchlist" | "movers">(props.watchlist ? "watchlist" : "movers");
  return (
    <div
      class="right-rail-container ot-embed-side-panel"
      style={{ display: "flex", "flex-direction": "column", width: "331px", "flex-shrink": 0, "min-height": 0, overflow: "hidden" }}
    >
      <Show when={props.watchlist && props.movers}>
        <div class="ot-embed-side-switch" role="tablist">
          <button type="button" role="tab" aria-selected={shown() === "watchlist"} classList={{ "is-active": shown() === "watchlist" }} onClick={() => setShown("watchlist")}>
            Watchlist
          </button>
          <button type="button" role="tab" aria-selected={shown() === "movers"} classList={{ "is-active": shown() === "movers" }} onClick={() => setShown("movers")}>
            Market movers
          </button>
        </div>
      </Show>
      <Show when={props.watchlist && shown() === "watchlist"}>
        <Watchlist
          activeSymbol={props.activeSymbol}
          activeTicker={props.activeSymbol}
          onSymbolSelect={props.onSymbolSelect}
          onAddCompare={props.onAddCompare}
          interval={props.interval}
        />
      </Show>
      <Show when={props.movers && shown() === "movers"}>
        <MoversPanel onSymbolSelect={props.onSymbolSelect} />
      </Show>
      <Show when={props.details}>
        <WatchlistDetail activeSymbol={props.activeSymbol} onSymbolSelect={props.onSymbolSelect} />
      </Show>
    </div>
  );
}
