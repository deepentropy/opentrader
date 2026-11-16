/*
 * Quote (#339): one symbol's logo, ticker and name, its last price with the
 * currency, and the day's change. A click tells the page.
 */
import type { EmbedConfig } from "../config";
import { tickerOf } from "../../data/datafeed";
import { createWidgetQuotes } from "./widget-quotes";
import { changeText, moveClass, percentText, pickSymbol, priceText, SymbolLogo } from "./parts";

export function QuoteCard(props: { config: EmbedConfig }) {
  const s = props.config.symbol;
  const data = createWidgetQuotes(() => [s]);
  const q = () => data.quotes[s];
  const info = () => data.infos[s];
  return (
    <button type="button" class="ot-w-quote" onClick={() => pickSymbol(s)}>
      <SymbolLogo symbol={s} url={info()?.logo} size={36} />
      <span class="ot-w-quote-names">
        <span class="ot-w-ticker" data-no-translate>{tickerOf(s)}</span>
        <span class="ot-w-name" data-no-translate>{info()?.name ?? ""}</span>
      </span>
      <span class="ot-w-quote-values">
        <span class="ot-w-last-line">
          <span class="ot-w-last ot-value">{priceText(q()?.last)}</span>
          <span class="ot-w-currency" data-no-translate>{info()?.currency?.toUpperCase() ?? ""}</span>
        </span>
        <span class={`ot-w-change ot-value ${moveClass(q()?.change)}`}>
          {changeText(q()?.change)} {percentText(q()?.changePercent)}
        </span>
      </span>
    </button>
  );
}
