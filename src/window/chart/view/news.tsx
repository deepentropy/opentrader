/*
 * Latest news of a chart view (Events tab): the newest headline of the symbol
 * as a lollipop on the last bar, and its card.
 */
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { NEWS_MAX_AGE_MS, NEWS_UPDATE_MS, formatAgo, formatNewsDate } from "../news-lollipop";
import { getLatestNews, type NewsItem } from "../../../data/datafeed-rest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isSecondResolution } from "../../../data/datafeed";
import { type ChartCx } from "./context";
import type { Accessor, JSX, Setter } from "solid-js";

/** What createNews adds to the chart context. */
export interface NewsApi {
  NewsCard: () => JSX.Element;
  newsCardOpen: Accessor<boolean>;
  setNewsCardOpen: Setter<boolean>;
  toggleNewsCard: () => void;
}

export function createNews(cx: ChartCx): NewsApi {
  const { appearance, fullSymbol, hidden, newsLollipop, onShownHooks, props } = cx;
  // -- Latest news (Events tab) ------------------------------------------
  // Latest updates: the newest headline of the symbol, refreshed
  // every 5 min; none if it is older than 31 days; not on seconds
  // intervals. A headline that arrives after the first load raises the red
  // "new" dot until the lollipop is clicked.
  const [news, setNews] = createSignal<NewsItem | null>(null);
  const [newsHasNew, setNewsHasNew] = createSignal(false);
  const [newsCardOpen, setNewsCardOpen] = createSignal(false);
  const newsAvailable = createMemo(() => !isSecondResolution(props.interval ?? "1D"));
  createEffect(() => {
    const sym = fullSymbol();
    const on = appearance().latestNews ?? true;
    const available = newsAvailable();
    setNews(null);
    setNewsHasNew(false);
    setNewsCardOpen(false);
    if (!sym || !on || !available) return;
    let alive = true;
    let lastId: string | null | undefined;
    const load = () =>
      getLatestNews(sym, 1)
        .then((list) => {
          if (!alive) return;
          const it = list[0] ?? null;
          const fresh = it && Date.now() - it.published < NEWS_MAX_AGE_MS ? it : null;
          if (lastId !== undefined && fresh && fresh.id !== lastId) setNewsHasNew(true);
          lastId = fresh?.id ?? null;
          setNews(fresh);
        })
        .catch(() => {});
    load();
    let lastLoad = Date.now();
    const timer = setInterval(() => {
      if (hidden()) return;
      lastLoad = Date.now();
      load();
    }, NEWS_UPDATE_MS);
    const onShow = () => {
      if (Date.now() - lastLoad < NEWS_UPDATE_MS) return;
      lastLoad = Date.now();
      load();
    };
    onShownHooks.add(onShow);
    onCleanup(() => { alive = false; clearInterval(timer); onShownHooks.delete(onShow); });
  });

  // Interval change closes the card.
  createEffect(() => { void props.interval; setNewsCardOpen(false); });
  createEffect(() => {
    newsLollipop.setState({ visible: news() !== null, hasNew: newsHasNew(), active: newsCardOpen() });
  });

  function toggleNewsCard() {
    if (!newsCardOpen()) setNewsHasNew(false);
    setNewsCardOpen(!newsCardOpen());
  }
  /** Card anchor (viewport px): point = lollipop centre - 10.5 - 8, card
   *  centred on it, bottom 6 px above it (measured on the earnings card). */
  const newsCardPos = () => {
    if (!newsCardOpen() || !cx.chart || !cx.paneRoot) return null;
    void cx.scaleGeom();
    void cx.mainPaneEpoch();
    const m = cx.mainPane();
    const c = newsLollipop.center(cx.chart.paneSize(m).height);
    if (!c) return null;
    const r = cx.paneRoot.getBoundingClientRect();
    const top = cx.paneBoxes().find((b) => b.index === m)?.top ?? 0;
    const x = r.left + cx.leftAxisWidth() + c.x;
    const pointY = r.top + top + c.y - 10.5 - 8;
    const width = 300;
    return {
      left: Math.max(0, Math.min(window.innerWidth - width, Math.round(x - width / 2))),
      bottom: Math.round(window.innerHeight - (pointY - 6)),
      maxHeight: Math.max(0, Math.round(pointY - 6 - 15)),
    };
  };

  function NewsCard() {
    return (
      <Show when={news() && newsCardPos()}>
        {(pos) => (
          <div
            class="ot-news-card"
            style={{ left: `${pos().left}px`, bottom: `${pos().bottom}px`, "max-height": `${pos().maxHeight}px` }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div class="ot-news-card-title">
              <svg class="ot-news-card-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
                <path fill="currentColor" d="M24.5 14A10.5 10.5 0 1 0 14 24.5V26a12 12 0 1 1 0-24 12 12 0 0 1 0 24v-1.5c5.8 0 10.5-4.7 10.5-10.5" />
                <path fill="currentColor" d="m17.03 7.5 1.02.9-4.02 4.93h5.29l-8.35 7.17-1.02-.9 4.02-4.93H8.68z" />
              </svg>
              <span class="ot-news-card-heading">Latest updates</span>
            </div>
            <div class="ot-news-card-main">
              {/* OT has no news view yet, so the headline opens the article
                  in the browser. */}
              <button
                type="button"
                class="ot-news-item"
                onClick={() => {
                  const url = news()?.url;
                  setNewsCardOpen(false);
                  if (url) void openUrl(url).catch((e) => console.warn("[news] open article failed", e));
                }}
              >
                <div class="ot-news-item-header">
                  <span><time title={formatNewsDate(news()!.published)}>{formatAgo(news()!.published, Date.now())}</time></span>
                  <span>{news()!.publisher}</span>
                </div>
                <div class="ot-news-item-title">{news()!.title}</div>
                {/* No "See all" footer: there is no news list view. */}
              </button>
            </div>
          </div>
        )}
      </Show>
    );
  }

  return {
    NewsCard,
    newsCardOpen,
    setNewsCardOpen,
    toggleNewsCard,
  };
}
