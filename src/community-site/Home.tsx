/*
 * Home: the posts since the member's last visit (a week for visitors),
 * Most useful or Newest, filtered by type, ending with "You're caught up".
 * Left: the member's tickers with their new posts, the type filter. Right:
 * the community's record over 30 days, the ideas resolving this week, the
 * questions still without an answer, the most wanted and recently shipped
 * suggestions.
 */
import { For, Show, createResource, createSignal } from "solid-js";
import { api, type HomeView, type Post, type PostType, type Sort } from "../data/community/api";
import { me, ready } from "../data/community/session";
import * as kv from "../data/kv";
import { errorText } from "../window/right-rail/community/parts";
import { go } from "./router";
import {
  DirTag, OriginTag, Pills, STATUS_LABEL, Snapshot, TYPE_PLURAL, TYPES, TickerTag, TypeTag, UserLink, age, communityHref, dateTime, daysLeft, fmtR, postState, recordLine, signInPath, tickerName,
} from "./ui";

const SORT_KEY = "ot:community:home-sort";
const SORTS: { id: Sort; label: string }[] = [
  { id: "useful", label: "Most useful" },
  { id: "new", label: "Newest" },
];

export function FeedItem(props: { post: Post }) {
  const p = () => props.post;
  const state = () => postState(p());
  return (
    <article class="cs-item">
      <div class="cs-item-main">
        <div class="cs-meta">
          <TypeTag type={p().type} />
          <Show when={p().idea}><DirTag dir={p().idea!.direction} /></Show>
          <OriginTag post={p()} />
          <TickerTag id={p().community.id} />
          <span>·</span>
          <UserLink name={p().author} />
          <Show when={!p().author_bot} fallback={<span class="cs-bot">bot</span>}><span>{recordLine(p().author_record)}</span></Show>
          <span>·</span>
          <span>{age(p().created_at)}</span>
        </div>
        <h4 class="cs-item-title"><a href={`/p/${p().id}`} onClick={go(`/p/${p().id}`)}>{p().title}</a></h4>
        <Show when={p().excerpt}><p class="cs-item-ex">{plain(p().excerpt)}</p></Show>
        <div class="cs-item-foot">
          <span class="cs-useful">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
            <strong>{p().useful_count}</strong> found useful
          </span>
          <a class="cs-replies" href={`/p/${p().id}`} onClick={go(`/p/${p().id}`)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            {p().comment_count} {p().comment_count === 1 ? "reply" : "replies"}
          </a>
          <Show when={state()}><span class="cs-state" style={{ color: state()!.color }}>{state()!.text}</span></Show>
        </div>
      </div>
      <div class="cs-item-chart"><Snapshot post={p()} /></div>
    </article>
  );
}

/** Markdown marks out of an excerpt. */
export function plain(s: string): string {
  return s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_~`>|]/g, "").replace(/\s+/g, " ").trim();
}

/** The idea's bar: stop on the left, target on the right, the price filled, a tick at the entry. */
export function LevelBar(props: { stop: number; target: number; entry: number; last: number | null; direction: "long" | "short" }) {
  const pos = (v: number) => Math.max(0, Math.min(100, ((v - props.stop) / (props.target - props.stop)) * 100));
  const fill = () => (props.last == null ? 0 : pos(props.last));
  // The price on the stop's side of the entry: not triggered, or losing.
  const behind = () => props.last != null && fill() < pos(props.entry);
  return (
    <div class="cs-lvbar" aria-hidden="true">
      <div class="cs-lvbar-fill" style={{ width: `${fill()}%`, background: behind() ? "var(--cs-signal)" : "var(--cs-chalk)" }} />
      <div class="cs-lvbar-tick" style={{ left: `${pos(props.entry)}%` }} />
    </div>
  );
}

export function Home() {
  const [sort, setSort] = createSignal<Sort>((kv.getItem(SORT_KEY) as Sort | null) ?? "useful");
  const [type, setType] = createSignal<PostType | null>(null);
  // A new sort or filter keeps the page while the next one loads (the visit's start stays within the visit).
  const [data] = createResource(
    () => (ready() ? [sort(), type(), me()?.user.name ?? ""] as const : null),
    ([s, t]) => api.home(s, t),
  );
  const view = (): HomeView | undefined => data.latest;
  const pick = (s: Sort) => {
    setSort(s);
    kv.setItem(SORT_KEY, s);
  };
  const since = () => view()?.since ?? 0;
  const filters = (): { id: PostType | null; label: string; n: number }[] => [
    { id: null, label: "All", n: view()?.counts.all ?? 0 },
    ...TYPES.map((t) => ({ id: t, label: TYPE_PLURAL[t], n: view()?.counts[t] ?? 0 })),
  ];
  const r30 = () => view()?.record30;
  return (
    <div class="cs-grid is-home">
      <aside class="cs-left">
        <section>
          <div class="cs-label is-ruled">Your tickers</div>
          <Show
            when={me()}
            fallback={<p class="cs-note"><a href={signInPath()} onClick={go(signInPath())}>Sign in</a> to see what's new on your tickers.</p>}
          >
            <For each={view()?.my_tickers ?? []} fallback={<p class="cs-note">No tickers yet. Add them from a ticker's page, or sync your watchlist in the OpenTrader app.</p>}>
              {(t) => (
                <a class="cs-row-link" href={communityHref(t.id)} onClick={go(communityHref(t.id))}>
                  <span class="cs-strong">{tickerName(t.id)}</span>
                  <span class="cs-fog">{t.fresh} new</span>
                </a>
              )}
            </For>
            <a class="cs-small-link" href="/tickers" onClick={go("/tickers")}>Edit list — synced from OpenTrader</a>
          </Show>
        </section>
        <section>
          <div class="cs-label is-ruled">Post type</div>
          <For each={filters()}>
            {(f) => (
              <button type="button" class={"cs-filter" + (type() === f.id ? " is-on" : "")} aria-pressed={type() === f.id} onClick={() => setType(f.id)}>
                <span>{f.label}</span>
                <span>{f.n}</span>
              </button>
            )}
          </For>
        </section>
      </aside>

      <main id="cs-main" class="cs-center">
        <div class="cs-head is-strong">
          <div>
            <div class="cs-label">{view()?.visitor ? "The past week" : `Since your last visit · ${dateTime(since())}`}</div>
            <h2>
              {view()?.counts.all ?? 0} post{(view()?.counts.all ?? 0) === 1 ? "" : "s"}, {view()?.resolved ?? 0} idea{view()?.resolved === 1 ? "" : "s"} resolved
            </h2>
          </div>
          <Pills items={SORTS} value={sort()} onChange={pick} label="Sort" />
        </div>
        <Show when={data.error}><p class="cs-error">{errorText(data.error)}</p></Show>
        <Show when={view()} fallback={<p class="cs-loading">Loading…</p>}>
          <For each={view()!.posts}>{(p) => <FeedItem post={p} />}</For>
          <div class="cs-caught">
            <span class="cs-caught-mark" />
            <div>
              <strong>You're caught up.</strong> <span class="cs-fog">Older posts are in <a href="/search" onClick={go("/search")}>Search</a> and on each ticker page.</span>
            </div>
          </div>
        </Show>
      </main>

      <aside class="cs-right">
        <section>
          <div class="cs-label">Community record · 30 days</div>
          <div class="cs-stats">
            <div><div class="cs-stat">{r30()?.resolved ?? 0}</div><div class="cs-stat-l">ideas resolved</div></div>
            <div><div class="cs-stat">{r30()?.hit_pct == null ? "—" : `${r30()!.hit_pct}%`}</div><div class="cs-stat-l">hit target</div></div>
            <div><div class="cs-stat">{r30()?.avg_r == null ? "—" : fmtR(r30()!.avg_r)}</div><div class="cs-stat-l">avg result</div></div>
          </div>
        </section>
        <section>
          <h5>Resolving this week</h5>
          <div class="cs-note">Bar runs from stop (left) to target (right); tick = entry.</div>
          <For each={view()?.resolving ?? []} fallback={<div class="cs-ruled-row cs-fog">No idea expires this week.</div>}>
            {(r) => (
              <a class="cs-resolving" href={`/p/${r.id}`} onClick={go(`/p/${r.id}`)}>
                <div class="cs-resolving-top">
                  <span><strong>{r.ticker}</strong> {r.direction === "long" ? "Long" : "Short"} · {r.author ?? "[deleted]"}</span>
                  <span class="cs-fog">{daysLeft(r.expires)}d left</span>
                </div>
                <LevelBar stop={r.stop} target={r.target} entry={r.entry} last={r.last_price} direction={r.direction} />
              </a>
            )}
          </For>
        </section>
        <section>
          <h5>Questions without an answer</h5>
          <For each={view()?.open_questions ?? []} fallback={<div class="cs-ruled-row cs-fog">Every recent question has an answer.</div>}>
            {(q) => (
              <a class="cs-ruled-row cs-q" href={`/p/${q.id}`} onClick={go(`/p/${q.id}`)}>
                <div class="cs-q-t">{q.title}</div>
                <div class="cs-q-m">
                  Question · {age(q.created_at)} · {q.comment_count ? `${q.comment_count} repl${q.comment_count === 1 ? "y" : "ies"}, not marked answered` : "0 replies"}
                </div>
              </a>
            )}
          </For>
        </section>
        <section>
          <h5>Suggestions</h5>
          <div class="cs-note">What members want next in OpenTrader.</div>
          <For each={[...(view()?.suggestions?.open ?? []), ...(view()?.suggestions?.shipped ?? [])]} fallback={<div class="cs-ruled-row cs-fog">No suggestion yet.</div>}>
            {(s) => (
              <a class="cs-ruled-row cs-q" href={`/p/${s.id}`} onClick={go(`/p/${s.id}`)}>
                <div class="cs-q-t">{s.title}</div>
                <div class="cs-q-m">{STATUS_LABEL[s.status]} · {s.supporters} supporter{s.supporters === 1 ? "" : "s"}</div>
              </a>
            )}
          </For>
          <div class="cs-row cs-sg-home">
            <a href="/suggestions" onClick={go("/suggestions")}>All suggestions</a>
            <a href="/suggestions/new" onClick={go("/suggestions/new")}>Suggest a feature</a>
          </div>
        </section>
      </aside>
    </div>
  );
}
