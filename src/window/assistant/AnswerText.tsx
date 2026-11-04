/*
 * The assistant's answer as markdown, with its tickers made links: a click shows the symbol on the active chart (as a
 * `$AAPL` mention of the Community does). A word is a ticker when the chat's tools met it (a screen's rows, a
 * watchlist's symbols, the chart) or when the symbol search knows it; common abbreviations (RSI, EMA, ETF…) never are.
 */
import { createMemo, createSignal } from "solid-js";
import { renderMarkdown } from "../../data/community/markdown";
import { chartBridge } from "../../data/community/chart-share";
import { toFullSymbol } from "../../data/datafeed";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Words written in capitals that are not tickers here. */
const NOT_TICKERS = new Set(
  "A I AI API ATH ATR AND ADX ADR BB CCI CEO CFO CPI DMA EMA EPS ETF ETN EU EUR FAQ FOMC GDP GBP HMA ID IPO JPY KPI MA MACD MFI NAV NYSE NASDAQ OBV OK OR PDF PE PEG PM AM Q1 Q2 Q3 Q4 RSI ROC ROE ROI RTH SAR SEC SMA SPX NDX DJI UK US USA USD UTC VIX VWAP WMA YOY YTD TTM ETH BTC".split(" "),
);

/** "AAPL", "BRK.B", "NASDAQ:AAPL": an optional exchange, then a ticker. */
const WORD = /\b(?:([A-Z]{2,10}):)?([A-Z][A-Z0-9]{0,5}(?:\.[A-Z])?)\b/g;

// Words looked up once per run: the symbol search's answer (its full name), or null.
const looked = new Map<string, string | null>();
const [lookups, setLookups] = createSignal(0);

function lookUp(word: string): void {
  if (looked.has(word)) return;
  looked.set(word, null);
  void toFullSymbol(word)
    .then((full) => {
      looked.set(word, full);
      setLookups((n) => n + 1);
    })
    .catch(() => {});
}

/** The answer's HTML (from renderMarkdown: its text escaped, its own tags only) with its tickers as links, left alone
 *  inside links and code. `known`: the chat's symbols (bare ticker → full name). */
export function linkTickers(html: string, known: Map<string, string>, find: (word: string) => string | null | undefined): string {
  let inside = 0;
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<(a|code|pre)\b/i.test(part)) inside++;
        else if (/^<\/(a|code|pre)>/i.test(part)) inside = Math.max(0, inside - 1);
        return part;
      }
      if (inside) return part;
      return part.replace(WORD, (whole: string, exchange: string | undefined, ticker: string) => {
        if (NOT_TICKERS.has(ticker) && !exchange) return whole;
        const full = exchange ? `${exchange}:${ticker}` : (known.get(ticker) ?? find(ticker));
        return full ? `<a href="#" class="cm-ticker asst-ticker" data-ticker="${full}">${whole}</a>` : whole;
      });
    })
    .join("");
}

/** Bare tickers → full names of every symbol in a JSON text (tool arguments and results): `symbol`, `symbols`,
 *  `ticker` values and "EXCHANGE:TICKER" strings. */
export function symbolsOf(json: string, into: Map<string, string>): void {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return;
  }
  const add = (s: string) => {
    const m = /^(?:([A-Z]{2,10}):)?([A-Z][A-Z0-9]{0,5}(?:\.[A-Z])?)$/.exec(s.trim().toUpperCase());
    if (m && !NOT_TICKERS.has(m[2])) into.set(m[2], m[1] ? `${m[1]}:${m[2]}` : (into.get(m[2]) ?? m[2]));
  };
  const walk = (x: unknown, key: string) => {
    if (typeof x === "string") {
      if (key === "symbol" || key === "symbols" || key === "ticker" || /^[A-Z]{2,10}:[A-Z]/.test(x)) add(x);
    } else if (Array.isArray(x)) x.forEach((y) => walk(y, key));
    else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) walk(y, k);
  };
  walk(v, "");
}

export function AnswerText(props: { text: string; known: Map<string, string> }) {
  const html = createMemo(() => {
    void lookups();
    const md = renderMarkdown(props.text);
    // Capitalised words the chat's tools did not meet: asked to the symbol search once.
    for (const m of props.text.matchAll(WORD)) {
      const [, exchange, ticker] = m;
      if (!exchange && ticker.length > 1 && !NOT_TICKERS.has(ticker) && !props.known.has(ticker)) lookUp(ticker);
    }
    return linkTickers(md, props.known, (w) => looked.get(w));
  });
  const onClick = (e: MouseEvent) => {
    const t = (e.target as HTMLElement).closest("a[data-ticker]") as HTMLAnchorElement | null;
    if (t) {
      e.preventDefault();
      void chartBridge()?.showSymbol(t.dataset.ticker!).catch((err) => console.warn("[assistant] symbol not shown", err));
      return;
    }
    const a = (e.target as HTMLElement).closest("a[data-external]") as HTMLAnchorElement | null;
    if (a) {
      e.preventDefault();
      void openUrl(a.href).catch(() => {});
    }
  };
  return <div class="cm-markdown asst-markdown" innerHTML={html()} onClick={onClick} />;
}
