/*
 * Pieces the embedded widgets share (#339): the symbol's logo, its price and
 * change texts, and the click that tells the page which symbol was picked.
 */
import { Show } from "solid-js";
import { numberText } from "../../i18n/format";
import { tickerOf } from "../../data/datafeed";
import { postToPage } from "../host";

/** The page hears of a picked symbol (the loader's ot-symbol-click). */
export const pickSymbol = (symbol: string): void => postToPage("symbol-click", { symbol });

export const priceText = (n: number | null | undefined): string =>
  n == null ? "—" : numberText(n, { minimumFractionDigits: 2, maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 4 : 2 });

export const changeText = (n: number | null | undefined): string =>
  n == null ? "" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${numberText(Math.abs(n), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const percentText = (n: number | null | undefined): string => (n == null ? "" : `${changeText(n)}%`);

/** "is-up" / "is-down" / "" for a change. */
export const moveClass = (n: number | null | undefined): string => (n == null || n === 0 ? "" : n > 0 ? "is-up" : "is-down");

/** The symbol's logo, or its first letter in a circle. */
export function SymbolLogo(props: { symbol: string; url: string | null | undefined; size?: number }) {
  const size = () => `${props.size ?? 24}px`;
  return (
    <span class="ot-w-logo" style={{ width: size(), height: size() }} aria-hidden="true">
      <Show when={props.url} fallback={<span class="ot-w-logo-letter">{tickerOf(props.symbol).charAt(0)}</span>}>
        {(url) => <img src={url()} alt="" loading="lazy" />}
      </Show>
    </span>
  );
}
