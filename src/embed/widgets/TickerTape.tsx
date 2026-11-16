/*
 * Ticker tape (#339): each symbol's logo, ticker, last price and change. In a
 * row that scrolls on its own (paused under the pointer), or in a column. A
 * click on a symbol tells the page.
 */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { EmbedConfig } from "../config";
import { tickerOf } from "../../data/datafeed";
import { createWidgetQuotes } from "./widget-quotes";
import { changeText, moveClass, percentText, pickSymbol, priceText, SymbolLogo } from "./parts";

/** Scrolling speed of the row, in pixels a second. */
const SPEED = 50;

export function TickerTape(props: { config: EmbedConfig }) {
  const symbols = () => props.config.symbols;
  const data = createWidgetQuotes(symbols);
  const vertical = () => props.config.direction === "vertical";

  const item = (s: string) => {
    const q = () => data.quotes[s];
    return (
      <button type="button" class="ot-w-tape-item" onClick={() => pickSymbol(s)} title={data.infos[s]?.name ?? s}>
        <Show when={!props.config.hideLogos}>
          <SymbolLogo symbol={s} url={data.infos[s]?.logo} size={vertical() ? 28 : 20} />
        </Show>
        <span class="ot-w-tape-names">
          <span class="ot-w-ticker" data-no-translate>{tickerOf(s)}</span>
          <Show when={vertical()}>
            <span class="ot-w-name" data-no-translate>{data.infos[s]?.name ?? ""}</span>
          </Show>
        </span>
        <span class="ot-w-tape-values">
          <span class="ot-w-last ot-value">{priceText(q()?.last)}</span>
          <span class={`ot-w-change ot-value ${moveClass(q()?.change)}`}>
            {changeText(q()?.change)} ({percentText(q()?.changePercent)})
          </span>
        </span>
      </button>
    );
  };

  // The row scrolls by its own width: the items twice, moved left by one set.
  let track: HTMLDivElement | undefined;
  const [duration, setDuration] = createSignal(60);
  onMount(() => {
    if (!track) return;
    const ro = new ResizeObserver(() => setDuration(Math.max(10, track!.scrollWidth / 2 / SPEED)));
    ro.observe(track);
    onCleanup(() => ro.disconnect());
  });

  return (
    <Show
      when={!vertical()}
      fallback={
        <div class="ot-w-tape is-vertical">
          <For each={symbols()}>{(s) => item(s)}</For>
        </div>
      }
    >
      <div class="ot-w-tape is-horizontal">
        <div ref={track} class="ot-w-tape-track" style={{ "animation-duration": `${duration()}s` }}>
          <For each={symbols()}>{(s) => item(s)}</For>
          <For each={symbols()}>{(s) => item(s)}</For>
        </div>
      </div>
    </Show>
  );
}
