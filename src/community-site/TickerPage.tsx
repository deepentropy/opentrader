/*
 * A ticker's page: the ticker big, the company, the delayed price; the
 * daily chart with the open ideas' entries; the open ideas by their authors'
 * record; the discussion by type. Right: who is on which side, the ideas
 * resolved over 90 days, the answered questions. General has the discussion
 * alone.
 */
import { For, Show, createEffect, createResource, createSignal, onCleanup, onMount } from "solid-js";
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import { GENERAL, api, type Bar, type Post, type PostType, type TickerView } from "../data/community/api";
import { me, refreshMe } from "../data/community/session";
import { errorText } from "../community-shared/parts";
import { go, navigate } from "./router";
import { DOWN, FOG, Pills, TypeTag, UP, UserLink, age, date, fmtPct, fmtR, price, rColor, signInPath } from "./ui";

type Level = { price: number; label: string; long: boolean };

/** The open ideas' entries, one line per price and side: "148.20 L ×3". */
export function entryLevels(v: TickerView): Level[] {
  const map = new Map<string, Level & { n: number }>();
  for (const o of v.open_ideas) {
    const long = o.idea.direction === "long";
    const k = `${o.idea.entry}:${long}`;
    const cur = map.get(k);
    map.set(k, { price: o.idea.entry, long, label: "", n: (cur?.n ?? 0) + 1 });
  }
  return [...map.values()].map((l) => ({ ...l, label: `${price(l.price)} ${l.long ? "L" : "S"}${l.n > 1 ? ` ×${l.n}` : ""}` }));
}

function LevelsChart(props: { bars: Bar[]; levels: Level[] }) {
  let el!: HTMLDivElement;
  let chart: IChartApi | null = null;
  let series: ISeriesApi<"Candlestick"> | null = null;
  // The chart library loads with the first ticker page, not with the site.
  const draw = () => {
    if (!series || !chart) return;
    series.setData(props.bars.map((b) => ({ time: b.time as never, open: b.open, high: b.high, low: b.low, close: b.close })));
    for (const l of props.levels) series.createPriceLine({ price: l.price, color: l.long ? "#2962ff" : "#787b86", lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: l.label });
    chart.timeScale().fitContent();
  };
  onMount(async () => {
    const lc = await import("lightweight-charts");
    if (!el.isConnected) return;
    chart = lc.createChart(el, {
      autoSize: true,
      layout: { background: { type: lc.ColorType.Solid, color: "#0f0f0f" }, textColor: FOG, fontFamily: "Inter, -apple-system, Segoe UI, sans-serif", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: "#1e2026" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      crosshair: { horzLine: { labelBackgroundColor: "#2a2c33" }, vertLine: { labelBackgroundColor: "#2a2c33" } },
      handleScroll: false,
      handleScale: false,
      // The website is in English: month names too.
      localization: { locale: "en-US" },
    });
    series = chart.addSeries(lc.CandlestickSeries, { upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false, priceLineVisible: false, lastValueVisible: true });
    draw();
  });
  onCleanup(() => chart?.remove());
  return <div class="cs-tchart" ref={el} />;
}

const DISCUSSION: { id: PostType | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "analysis", label: "Analysis" },
  { id: "question", label: "Questions" },
  { id: "postmortem", label: "Post-mortems" },
];

function Discussion(props: { community: string }) {
  const [type, setType] = createSignal<PostType | "all">("all");
  const [posts, setPosts] = createSignal<Post[]>([]);
  const [next, setNext] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const load = async (offset: number) => {
    try {
      const t = type();
      const r = await api.posts(props.community, "new", offset, t === "all" ? null : t);
      setPosts((l) => (offset ? [...l, ...r.posts] : r.posts));
      setNext(r.next_offset);
    } catch (e) {
      setError(errorText(e));
    }
  };
  createEffect(() => {
    type();
    void load(0);
  });
  return (
    <div>
      <div class="cs-head is-strong is-sub">
        <h4>Discussion</h4>
        <Pills items={DISCUSSION} value={type()} onChange={setType} label="Kind of post" />
      </div>
      <Show when={error()}><p class="cs-error">{error()}</p></Show>
      <For each={posts()} fallback={<p class="cs-note">Nothing here yet. <a href={`/submit?to=${encodeURIComponent(props.community)}`} onClick={go(`/submit?to=${encodeURIComponent(props.community)}`)}>Write the first post</a>.</p>}>
        {(p) => (
          <a class="cs-disc" href={`/p/${p.id}`} onClick={go(`/p/${p.id}`)}>
            <span><TypeTag type={p.type} /></span>
            <span class="cs-strong">{p.title}</span>
            <span class="cs-fog">{p.author ?? "[deleted]"} · {age(p.created_at)}</span>
            <span class="cs-right-al"><strong>{p.useful_count}</strong> useful</span>
          </a>
        )}
      </For>
      <Show when={next() !== null}><button type="button" class="cs-more" onClick={() => load(next()!)}>More posts</button></Show>
    </div>
  );
}

export function TickerPage(props: { ticker: string }) {
  const [view, { mutate }] = createResource(() => [props.ticker, me()?.user.name ?? ""] as const, ([t]) => api.ticker(t));
  const [bars] = createResource(() => props.ticker, (t) => api.tickerBars(t).then((r) => r.bars).catch(() => [] as Bar[]));
  const [error, setError] = createSignal<string | null>(null);
  createEffect(() => { document.title = `${props.ticker} · OpenTrader Community`; });
  const follow = async () => {
    const v = view();
    if (!v) return;
    if (!me()) return navigate(signInPath());
    try {
      await api.follow(v.community.id, !v.community.followed);
      mutate({ ...v, community: { ...v.community, followed: !v.community.followed } });
      void refreshMe();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const postHref = () => `/submit?to=${encodeURIComponent(`t:${props.ticker}`)}`;
  return (
    <Show when={!view.error} fallback={<div class="cs-page-msg">{errorText(view.error)}</div>}>
      <Show when={view()} fallback={<p class="cs-loading">Loading…</p>}>
        {(() => {
          const v = () => view()!;
          const q = () => v().quote;
          const pos = () => v().positioning;
          const r90 = () => v().resolved90;
          return (
            <>
              <div class="cs-tickerhead">
                <div>
                  <h1 class="cs-tk is-big">{v().ticker}</h1>
                  <div class="cs-fog">{v().reference ? [v().reference!.name, v().reference!.exchange, v().reference!.sector].filter(Boolean).join(" · ") : "US stock"}</div>
                </div>
                <div class="cs-quote">
                  <Show when={q()} fallback={<span class="cs-fog">No price right now</span>}>
                    <span class="cs-quote-last">{price(q()!.last)}</span>
                    <span class="cs-quote-chg" style={{ color: rColor(q()!.change) }}>
                      {q()!.change == null ? "" : `${q()!.change! >= 0 ? "+" : "−"}${Math.abs(q()!.change!).toFixed(2)} · ${fmtPct(q()!.change_pct)}`}
                    </span>
                    <span class="cs-fog cs-small">Delayed 15 min</span>
                  </Show>
                </div>
                <div class="cs-row">
                  <button type="button" class="cs-btn" onClick={follow}>{v().community.followed ? "Remove from my tickers" : "Add to my tickers"}</button>
                  <a class="cs-btn is-primary" href={postHref()} onClick={go(postHref())}>Post on {v().ticker}</a>
                </div>
              </div>
              <Show when={error()}><p class="cs-error">{error()}</p></Show>
              <div class="cs-grid is-ticker">
                <main id="cs-main" class="cs-center is-wide cs-stack">
                  <figure class="cs-tfig">
                    <div class="cs-tfig-head">
                      <span><strong>Open community levels</strong> on the daily chart</span>
                      <span class="cs-fog">Entries of {v().open_ideas.length} open idea{v().open_ideas.length === 1 ? "" : "s"} · delayed 15 min</span>
                    </div>
                    <div class="cs-tfig-box">
                      <Show when={(bars() ?? []).length} fallback={<div class="cs-tchart is-empty">{bars.loading ? "Loading the chart…" : "No chart data."}</div>}>
                        <LevelsChart bars={bars()!} levels={entryLevels(v())} />
                      </Show>
                    </div>
                  </figure>

                  <div>
                    <div class="cs-head is-strong is-sub"><h4>Open ideas</h4><span class="cs-fog cs-small">Sorted by author's resolved record</span></div>
                    <Show when={v().open_ideas.length} fallback={<p class="cs-note">No open idea on {v().ticker}. <a href={`${postHref()}&type=idea`} onClick={go(`${postHref()}&type=idea`)}>Post one with its levels</a>.</p>}>
                      <table class="cs-table">
                        <thead><tr><th>Author</th><th>Record</th><th>Dir</th><th>Entry</th><th>Stop</th><th>Target</th><th>Posted</th><th>Now</th></tr></thead>
                        <tbody>
                          <For each={v().open_ideas}>
                            {(o) => (
                              <tr class="is-link" onClick={() => navigate(`/p/${o.id}`)}>
                                <td class="cs-strong"><UserLink name={o.author} /></td>
                                <td class="cs-fog">{o.author_record?.resolved ? `${o.author_record.resolved} · ${o.author_record.hit_pct}%` : "new"}</td>
                                <td class="cs-strong">{o.idea.direction === "long" ? "Long" : "Short"}</td>
                                <td>{price(o.idea.entry)}</td>
                                <td>{price(o.idea.stop)}</td>
                                <td>{price(o.idea.target)}</td>
                                <td class="cs-fog">{age(o.created_at)}</td>
                                <td class="cs-strong" style={{ color: o.idea.status === "open" ? rColor(o.idea.result_r) : FOG }}>{o.idea.status === "open" ? fmtR(o.idea.result_r) : "Not triggered"}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </Show>
                  </div>
                  <Discussion community={v().community.id} />
                </main>
                <aside class="cs-right is-ticker">
                  <section>
                    <h5>Positioning in open ideas</h5>
                    <Show when={pos().long + pos().short} fallback={<div class="cs-note">No open idea yet.</div>}>
                      <div class="cs-split">
                        <Show when={pos().long}><div style={{ flex: pos().long, background: UP }}>{pos().long} long</div></Show>
                        <Show when={pos().short}><div style={{ flex: pos().short, background: DOWN }}>{pos().short} short</div></Show>
                      </div>
                      <div class="cs-note">Weighted by author record: {pos().weighted_long_pct}% long. Not a signal — a map of who's on which side.</div>
                    </Show>
                  </section>
                  <section>
                    <h5>Resolved on {v().ticker} · 90 days</h5>
                    <div class="cs-stats is-tight">
                      <div><div class="cs-stat">{r90().resolved}</div><div class="cs-stat-l">ideas</div></div>
                      <div><div class="cs-stat">{r90().hit_pct == null ? "—" : `${r90().hit_pct}%`}</div><div class="cs-stat-l">hit target</div></div>
                      <div><div class="cs-stat">{r90().avg_r == null ? "—" : fmtR(r90().avg_r)}</div><div class="cs-stat-l">avg</div></div>
                    </div>
                    <For each={r90().recent}>
                      {(r) => (
                        <a class="cs-resolved" href={`/p/${r.id}`} onClick={go(`/p/${r.id}`)}>
                          <span>{r.author ?? "[deleted]"} · {r.direction === "long" ? "Long" : "Short"}</span>
                          <span class="cs-fog">{r.status === "target" ? "Target" : r.status === "stopped" ? "Stopped" : "Expired"} · {date(r.resolved_at)}</span>
                          <strong style={{ color: rColor(r.result_r) }}>{fmtR(r.result_r)}</strong>
                        </a>
                      )}
                    </For>
                  </section>
                  <section>
                    <h5>Answered questions</h5>
                    <For each={v().answered} fallback={<div class="cs-ruled-row cs-fog">No answered question yet.</div>}>
                      {(a) => (
                        <a class="cs-ruled-row cs-q" href={`/p/${a.id}`} onClick={go(`/p/${a.id}`)}>
                          <div class="cs-q-t">{a.title}</div>
                          <div class="cs-q-m">Answer by {a.answer_by ?? "[deleted]"} · {a.useful_count} useful</div>
                        </a>
                      )}
                    </For>
                  </section>
                  <section class="cs-quiet">
                    <a href={`/t/${encodeURIComponent(v().ticker)}/about`} onClick={go(`/t/${encodeURIComponent(v().ticker)}/about`)}>Moderators and moderation log</a>
                  </section>
                </aside>
              </div>
            </>
          );
        })()}
      </Show>
    </Show>
  );
}

/** General: posts about no one ticker. */
export function GeneralPage() {
  createEffect(() => { document.title = "General · OpenTrader Community"; });
  return (
    <>
      <div class="cs-tickerhead">
        <div>
          <h1 class="cs-tk is-big">General</h1>
          <div class="cs-fog">Markets, process and questions that are not about one ticker.</div>
        </div>
        <span />
        <div class="cs-row">
          <a class="cs-btn is-primary" href="/submit?to=c%3Ageneral" onClick={go("/submit?to=c%3Ageneral")}>Post in General</a>
        </div>
      </div>
      <div class="cs-grid is-ticker">
        <main id="cs-main" class="cs-center is-wide"><Discussion community={GENERAL} /></main>
        <aside class="cs-right is-ticker">
          <section class="cs-quiet">
            Posts about one ticker go on its page: an idea, with its levels, is always on a ticker.{" "}
            <a href="/c/general/about" onClick={go("/c/general/about")}>Moderators and moderation log</a>
          </section>
        </aside>
      </div>
    </>
  );
}
