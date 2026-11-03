/*
 * The feed of a community (or of all, or of the followed ones): its header
 * (the community's tag, description, Follow), Hot / New / Top, and the post
 * cards. A card shows its chart wide when it has one, the community's tag
 * pinned on it like a price-axis label.
 */
import { For, Show, createEffect, createResource, createSignal, on } from "solid-js";
import { api, imageUrl, type Community, type Post, type Sort } from "../data/community/api";
import { plainText } from "../data/community/markdown";
import { me, ready, refreshMe } from "../data/community/session";
import * as kv from "../data/kv";
import { BotBadge, SentimentBar, Vote, errorText } from "../window/right-rail/community/parts";
import { shortIntervalLabel } from "../window/chart/interval-favorites";
import { ago, communityPath, go, navigate } from "./router";

const SORT_KEY = "ot:community:web-sort";
const SORTS: { id: Sort; label: string }[] = [
  { id: "hot", label: "Hot" },
  { id: "new", label: "New" },
  { id: "top", label: "Top" },
];
const PERIODS = [
  { id: "day", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "year", label: "This year" },
  { id: "all", label: "All time" },
];

function signInPath(): string {
  return `/signin?next=${encodeURIComponent(location.pathname)}`;
}

export function PostCard(props: { post: Post; showCommunity: boolean; onChange: (p: Post) => void }) {
  const p = () => props.post;
  const [copied, setCopied] = createSignal(false);
  const share = async (e: MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard?.writeText(`${location.origin}/p/${p().id}`).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const open = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a, button")) return;
    navigate(`/p/${p().id}`);
  };
  return (
    <article class="cs-card" onClick={open}>
      <Vote
        vertical
        type="post"
        id={p().id}
        score={p().score}
        myVote={p().my_vote}
        onChange={(score, my) => props.onChange({ ...p(), score, my_vote: my })}
        onNeedSignIn={() => navigate(signInPath())}
        onError={() => {}}
      />
      <div class="cs-card-body">
        <div class="cs-card-meta">
          <Show when={props.showCommunity}>
            <a class="cs-tag is-small" href={communityPath(p().community.id)} onClick={go(communityPath(p().community.id))}>{p().community.title}</a>
          </Show>
          <span>
            {p().author ?? "[deleted]"}, {ago(p().created_at)}
          </span>
          <BotBadge show={p().author_bot} />
        </div>
        <h2 class="cs-card-title">
          <a href={`/p/${p().id}`} onClick={go(`/p/${p().id}`)}>{p().title}</a>
        </h2>
        <Show
          when={p().image_url}
          fallback={<Show when={p().excerpt}><p class="cs-card-excerpt">{plainText(p().excerpt)}</p></Show>}
        >
          <a class="cs-card-chart" href={`/p/${p().id}`} onClick={go(`/p/${p().id}`)}>
            <img src={imageUrl(p().image_url!)} alt={`Chart shared with "${p().title}"`} loading="lazy" />
            <span class="cs-tag cs-chart-tag">{p().community.title}</span>
          </a>
        </Show>
        <div class="cs-card-foot">
          <a href={`/p/${p().id}`} onClick={go(`/p/${p().id}`)}>
            {p().comment_count} comment{p().comment_count === 1 ? "" : "s"}
          </a>
          <button type="button" onClick={share}>{copied() ? "Link copied" : "Share"}</button>
        </div>
      </div>
    </article>
  );
}

export function CommunityHeader(props: { community: Community; onChange: (c: Community) => void }) {
  const [error, setError] = createSignal<string | null>(null);
  const follow = async () => {
    if (!me()) return navigate(signInPath());
    try {
      await api.follow(props.community.id, !props.community.followed);
      props.onChange({ ...props.community, followed: !props.community.followed });
      void refreshMe();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <header class="cs-feed-head">
      <div class="cs-feed-title">
        <h1 class="cs-tag is-large">{props.community.title}</h1>
        <div class="cs-feed-actions">
          <button type="button" class={"cs-btn" + (props.community.followed ? "" : " is-primary")} onClick={follow}>
            {props.community.followed ? "Following" : "Follow"}
          </button>
          <a class="cs-btn" href={`/submit?to=${encodeURIComponent(props.community.id)}`} onClick={go(`/submit?to=${encodeURIComponent(props.community.id)}`)}>New post</a>
        </div>
      </div>
      <p class="cs-feed-desc">
        {props.community.description || (props.community.kind === "ticker" ? `Ideas, analysis and questions about ${props.community.title}.` : "")}
      </p>
      <Show when={props.community.kind === "ticker"}>
        <SentimentBar community={props.community.id} onNeedSignIn={() => navigate(signInPath())} />
      </Show>
      <Show when={error()}><p class="cs-error">{error()}</p></Show>
    </header>
  );
}

export function Feed(props: { source: string; popular: { id: string; title: string }[] }) {
  const [sort, setSort] = createSignal<Sort>((kv.getItem(SORT_KEY) as Sort | null) ?? "hot");
  const [period, setPeriod] = createSignal("week");
  const [posts, setPosts] = createSignal<Post[]>([]);
  const [next, setNext] = createSignal<number | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const single = () => props.source.startsWith("t:") || props.source.startsWith("c:");
  const [community, { mutate: setCommunity }] = createResource(
    () => (single() ? [props.source, me()?.user.name ?? ""] as const : null),
    ([id]) => api.community(id).then((r) => r.community),
  );

  let seq = 0;
  const page = (offset: number) => {
    if (single()) return api.posts(props.source, sort(), offset, period());
    return api.feed(props.source === "following" ? "following" : "all", sort(), offset, period());
  };
  const load = async (offset = 0) => {
    const mine = ++seq;
    setLoading(true);
    setError(null);
    try {
      if (props.source === "following" && !me()) {
        setPosts([]);
        setNext(null);
        return;
      }
      const r = await page(offset);
      if (mine !== seq) return;
      setPosts((l) => (offset ? [...l, ...r.posts.filter((n) => !l.some((o) => o.id === n.id))] : r.posts));
      setNext(r.next_offset);
    } catch (e) {
      if (mine === seq) setError(errorText(e));
    } finally {
      if (mine === seq) setLoading(false);
    }
  };
  createEffect(on([() => props.source, sort, period, ready, () => me()?.user.name], () => { if (ready()) void load(0); }));
  createEffect(() => kv.setItem(SORT_KEY, sort()));

  const title = () => (props.source === "following" ? "Following" : props.source === "all" ? "All communities" : "");
  return (
    <section class="cs-feed" aria-label="Posts">
      <Show when={props.source === "all" && ready() && !me()}>
        <div class="cs-hero">
          <h1>Trading ideas, one community per ticker.</h1>
          <p>
            Every stock, ETF and crypto has its own discussion, themes gather the rest. Read freely; sign in with Google, GitHub or Discord to post,
            and share charts with their drawings from the OpenTrader app.
          </p>
          <Show when={props.popular.length}>
            <div class="cs-hero-tags" aria-label="Popular tickers">
              <For each={props.popular.slice(0, 8)}>
                {(t) => <a class="cs-tag" href={communityPath(t.id)} onClick={go(communityPath(t.id))}>{t.title}</a>}
              </For>
            </div>
          </Show>
          <div class="cs-hero-actions">
            <a class="cs-btn is-primary" href={signInPath()} onClick={go(signInPath())}>Sign in to post</a>
            <a class="cs-btn" href="https://opentrader.markets/download.html">Get the app</a>
          </div>
        </div>
      </Show>
      <Show
        when={single()}
        fallback={
          <header class="cs-feed-head">
            <div class="cs-feed-title">
              <h1 class="cs-feed-h1">{title()}</h1>
              <a class="cs-btn is-primary" href="/submit" onClick={go("/submit")}>New post</a>
            </div>
          </header>
        }
      >
        <Show when={community()}>
          <CommunityHeader community={community()!} onChange={(c) => setCommunity(c)} />
        </Show>
        <Show when={community.error}><p class="cs-error">{errorText(community.error)}</p></Show>
      </Show>
      <div class="cs-sorts" role="tablist" aria-label="Sort">
        <For each={SORTS}>
          {(s) => (
            <button type="button" role="tab" aria-selected={sort() === s.id} class={sort() === s.id ? "is-current" : ""} onClick={() => setSort(s.id)}>
              {s.label}
            </button>
          )}
        </For>
        <Show when={sort() === "top"}>
          <select aria-label="Period" value={period()} onChange={(e) => setPeriod(e.currentTarget.value)}>
            <For each={PERIODS}>{(p) => <option value={p.id}>{p.label}</option>}</For>
          </select>
        </Show>
      </div>
      <Show when={error()}><p class="cs-error">{error()}</p></Show>
      <For
        each={posts()}
        fallback={
          <Show when={!loading() && !error()}>
            <div class="cs-empty">
              <Show
                when={props.source === "following" && !me()}
                fallback={
                  <>
                    <p>{props.source === "following" ? "Nothing yet from the communities you follow." : "No posts here yet."}</p>
                    <a class="cs-btn is-primary" href={`/submit${single() ? `?to=${encodeURIComponent(props.source)}` : ""}`} onClick={go(`/submit${single() ? `?to=${encodeURIComponent(props.source)}` : ""}`)}>
                      Write the first post
                    </a>
                  </>
                }
              >
                <p>Sign in to see the posts of the communities you follow.</p>
                <a class="cs-btn is-primary" href={signInPath()} onClick={go(signInPath())}>Sign in</a>
              </Show>
            </div>
          </Show>
        }
      >
        {(p) => <PostCard post={p} showCommunity={!single()} onChange={(n) => setPosts((l) => l.map((x) => (x.id === n.id ? n : x)))} />}
      </For>
      <Show when={loading()}><p class="cs-loading">Loading posts…</p></Show>
      <Show when={next() !== null && !loading()}>
        <button type="button" class="cs-more" onClick={() => load(next()!)}>Show more posts</button>
      </Show>
    </section>
  );
}

/** The chart summary of a card or post: "AAPL, 1D". */
export const chartLabel = (symbol: string, interval: string) => `${symbol.split(":").pop()}, ${shortIntervalLabel(interval)}`;
