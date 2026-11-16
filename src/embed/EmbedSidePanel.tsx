/*
 * Right panel of an embedded chart (#338): the embed's watchlist over the
 * shown symbol's details, each when the site asks for it. A click on a
 * watchlist row shows that symbol.
 */
import { Show } from "solid-js";
import { Watchlist } from "../window/right-rail/Watchlist";
import { WatchlistDetail } from "../window/right-rail/WatchlistDetail";

type Props = {
  watchlist: boolean;
  details: boolean;
  activeSymbol: string;
  interval: string;
  onSymbolSelect: (symbol: string) => void;
  onAddCompare: (tickers: string[]) => void;
};

export function EmbedSidePanel(props: Props) {
  return (
    <div
      class="right-rail-container ot-embed-side-panel"
      style={{ display: "flex", "flex-direction": "column", width: "331px", "flex-shrink": 0, "min-height": 0, overflow: "hidden" }}
    >
      <Show when={props.watchlist}>
        <Watchlist
          activeSymbol={props.activeSymbol}
          activeTicker={props.activeSymbol}
          onSymbolSelect={props.onSymbolSelect}
          onAddCompare={props.onAddCompare}
          interval={props.interval}
        />
      </Show>
      <Show when={props.details}>
        <WatchlistDetail activeSymbol={props.activeSymbol} onSymbolSelect={props.onSymbolSelect} />
      </Show>
    </div>
  );
}
