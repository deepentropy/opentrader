/*
 * CommunityPanel — right-rail "community" tab: discussion communities per
 * ticker ($AAPL) and per theme (Penny Stocks, Options…), served by
 * deploy/community.
 *
 * The header picks what the list shows: the community of the active chart's
 * symbol (the default: it follows the chart), the posts of the followed
 * communities, all posts, a theme, or any ticker typed in. Hot / New / Top
 * sort it. A post opens in the panel with its comments; writing, voting and
 * reporting need an account (sign-in with an existing one, see
 * data/community/session.ts).
 *
 * The public website (src/community-site) shows the same panel full width:
 * `web` drops the chart's community, `route` / `onRoute` tie what is shown
 * to the page address.
 */
import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js";
import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/IconButton";
import { PanelHeader } from "../../../components/PanelHeader";
import { SegmentedControl } from "../../../components/SegmentedControl";
import { tickerOf } from "../../../data/symbol-name";
import * as kv from "../../../data/kv";
import { plainText } from "../../../data/community/markdown";
import { api, imageUrl, tickerCommunityId, type Community, type Post, type Sort } from "../../../data/community/api";
import { blobToBase64, chartBridge, type ChartCapture } from "../../../data/community/chart-share";
import { shortIntervalLabel } from "../../chart/interval-favorites";
import { initSession, me, ready, refreshMe, signOut } from "../../../data/community/session";
import { PostView } from "./PostView";
import { AboutView, AccountView, NotificationsView, ProposeView } from "./MoreViews";
import { openPost, startNotifications, unread } from "../../../data/community/notifications";
import { withPostingCheck } from "../../../data/community/posting-check";
import { ModQueue } from "./ModQueue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Age, Author, CONTACT_URL, ErrorBanner, ExternalLink, PostingCheckPrompt, RULES_URL, SignInBox, Vote, errorText } from "./parts";

/** "chart" (follows the chart), "following", "all", or a community id. */
type Source = string;
/** What the page address shows (the website). */
export type CommunityRoute = { source: string; postId: string | null };
type View =
  | { kind: "list" }
  | { kind: "post"; id: string }
  | { kind: "compose" }
  | { kind: "signin" }
  | { kind: "queue" }
  | { kind: "account" }
  | { kind: "notifications" }
  | { kind: "about" }
  | { kind: "propose" };

const SOURCE_KEY = "ot:community:source";
const SORT_KEY = "ot:community:sort";

const SORTS = [
  { id: "hot" as const, label: "Hot" },
  { id: "new" as const, label: "New" },
  { id: "top" as const, label: "Top" },
];

const DISCLAIMER = "Posts are members' opinions, not financial advice.";

type Props = {
  symbol?: string;
  /** The website: no chart, the address holds the state. */
  web?: boolean;
  route?: CommunityRoute;
  onRoute?: (route: CommunityRoute) => void;
};

export function CommunityPanel(props: Props) {
  const [source, setSource] = createSignal<Source>(props.route?.source ?? (props.web ? "all" : kv.getItem(SOURCE_KEY) ?? "chart"));
  const [sort, setSort] = createSignal<Sort>((kv.getItem(SORT_KEY) as Sort | null) ?? "hot");
  const [view, setView] = createSignal<View>(props.route?.postId ? { kind: "post", id: props.route.postId } : { kind: "list" });
  /** Where the sign-in view goes back to. */
  let afterSignIn: View = { kind: "list" };
  const [error, setError] = createSignal<string | null>(null);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);

  createEffect(() => { if (!props.web) kv.setItem(SOURCE_KEY, source()); });

  // The address and the panel follow each other (website): back / forward
  // change the panel, the panel's moves change the address.
  const postIdOf = (v: View) => (v.kind === "post" ? v.id : null);
  createEffect(on(() => props.route, (r) => {
    if (!r) return;
    if (r.source !== source()) setSource(r.source);
    if (r.postId !== postIdOf(view())) setView(r.postId ? { kind: "post", id: r.postId } : { kind: "list" });
  }, { defer: true }));
  createEffect(() => {
    const route = { source: source(), postId: postIdOf(view()) };
    // Sign-in, composer and the other inner views keep the address.
    if (view().kind === "list" || view().kind === "post") props.onRoute?.(route);
  });
  createEffect(() => kv.setItem(SORT_KEY, sort()));
  onMount(() => void initSession().then(startNotifications));
  // A notification's pop-up asked for its post.
  createEffect(on(openPost, (o) => o && setView({ kind: "post", id: o.id })));

  const chartCommunity = () => (props.symbol ? tickerCommunityId(tickerOf(props.symbol)) : null);
  /** The single community shown, or null for a feed. */
  const communityId = createMemo(() => {
    const s = source();
    if (s === "chart") return chartCommunity();
    if (s === "following" || s === "all") return null;
    return s;
  });

  const [themes] = createResource(() => api.themes().then((r) => r.communities).catch(() => [] as Community[]));
  const [providers] = createResource(() => api.providers().then((r) => r.providers).catch(() => [] as string[]));
  const [info, { mutate: setInfo, refetch: refetchInfo }] = createResource(
    () => [communityId(), me()?.user.name ?? ""] as const,
    ([id]) => (id ? api.community(id).then((r) => r.community).catch(() => null) : Promise.resolve(null)),
  );

  // ── The list ──────────────────────────────────────────────────────────
  const [posts, setPosts] = createSignal<Post[]>([]);
  const [nextOffset, setNextOffset] = createSignal<number | null>(null);
  const [loading, setLoading] = createSignal(false);
  let loadSeq = 0;

  const fetchPage = (offset: number) => {
    const id = communityId();
    const s = source();
    if (id) return api.posts(id, sort(), offset);
    if (s === "following") return api.feed("following", sort(), offset);
    if (s === "all") return api.feed("all", sort(), offset);
    return Promise.resolve({ posts: [] as Post[], next_offset: null });
  };

  const reload = async () => {
    const seq = ++loadSeq;
    setLoading(true);
    setError(null);
    try {
      if (source() === "following" && !me()) {
        setPosts([]);
        setNextOffset(null);
        return;
      }
      const r = await fetchPage(0);
      if (seq !== loadSeq) return;
      setPosts(r.posts);
      setNextOffset(r.next_offset);
    } catch (e) {
      if (seq === loadSeq) {
        setPosts([]);
        setError(errorText(e));
      }
    } finally {
      if (seq === loadSeq) setLoading(false);
    }
  };

  const loadMore = async () => {
    const offset = nextOffset();
    if (offset === null || loading()) return;
    setLoading(true);
    try {
      const r = await fetchPage(offset);
      setPosts((p) => [...p, ...r.posts.filter((n) => !p.some((o) => o.id === n.id))]);
      setNextOffset(r.next_offset);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  createEffect(on([communityId, source, sort, () => me()?.user.name, ready], () => { if (ready()) void reload(); }));

  // ── Navigation ────────────────────────────────────────────────────────
  const needSignIn = () => {
    afterSignIn = view().kind === "signin" ? { kind: "list" } : view();
    setView({ kind: "signin" });
  };
  const choose = (s: Source) => {
    setSource(s);
    setPickerOpen(false);
    setView({ kind: "list" });
  };

  const toggleFollow = async () => {
    const c = info();
    if (!c) return;
    if (!me()) return needSignIn();
    try {
      await api.follow(c.id, !c.followed);
      setInfo({ ...c, followed: !c.followed });
      void refreshMe();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const isMod = () => {
    const m = me()?.moderates;
    return m === "all" || (Array.isArray(m) && m.length > 0);
  };

  // A click outside closes the picker and the menu.
  let headerRef: HTMLDivElement | undefined;
  const onDocDown = (e: PointerEvent) => {
    if (headerRef && !headerRef.contains(e.target as Node)) {
      setPickerOpen(false);
      setMenuOpen(false);
    }
  };
  document.addEventListener("pointerdown", onDocDown, true);
  onCleanup(() => document.removeEventListener("pointerdown", onDocDown, true));

  const sourceLabel = () => {
    const s = source();
    if (s === "chart") return chartCommunity() ? `$${chartCommunity()!.slice(2)}` : "This chart";
    if (s === "following") return "Following";
    if (s === "all") return "All communities";
    if (s.startsWith("t:")) return `$${s.slice(2)}`;
    return themes()?.find((t) => t.id === s)?.title ?? s.slice(2);
  };

  // ── Header ────────────────────────────────────────────────────────────
  const [tickerInput, setTickerInput] = createSignal("");
  const goTicker = () => {
    const id = tickerCommunityId(tickerInput());
    if (id) {
      setTickerInput("");
      choose(id);
    }
  };

  const Picker = () => (
    <div class="ot-popover cm-picker" role="menu">
      <Show when={!props.web}>
        <button type="button" class="ot-menu-item" onClick={() => choose("chart")}>
          <span class="ot-menu-item__label">{chartCommunity() ? `$${chartCommunity()!.slice(2)}` : "Chart symbol"}<span class="cm-muted"> · this chart</span></span>
        </button>
      </Show>
      <button type="button" class="ot-menu-item" onClick={() => choose("following")}><span class="ot-menu-item__label">Following</span></button>
      <button type="button" class="ot-menu-item" onClick={() => choose("all")}><span class="ot-menu-item__label">All communities</span></button>
      <div class="cm-picker-section">Themes</div>
      <For each={themes() ?? []}>
        {(t) => (
          <button type="button" class="ot-menu-item" onClick={() => choose(t.id)}><span class="ot-menu-item__label">{t.title}</span></button>
        )}
      </For>
      <Show when={me()?.follows.some((f) => f.kind === "ticker")}>
        <div class="cm-picker-section">Followed tickers</div>
        <For each={me()!.follows.filter((f) => f.kind === "ticker")}>
          {(f) => (
            <button type="button" class="ot-menu-item" onClick={() => choose(f.id)}><span class="ot-menu-item__label">{f.title}</span></button>
          )}
        </For>
      </Show>
      <div class="cm-picker-section">Go to a ticker</div>
      <div class="cm-picker-input">
        <input
          class="cm-input"
          placeholder="Ticker, e.g. MSFT"
          value={tickerInput()}
          onInput={(e) => setTickerInput(e.currentTarget.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && goTicker()}
        />
      </div>
    </div>
  );

  const Menu = () => (
    <div class="ot-popover cm-menu" role="menu">
      <Show
        when={me()}
        fallback={
          <button type="button" class="ot-menu-item" onClick={() => { setMenuOpen(false); needSignIn(); }}><span class="ot-menu-item__label">Sign in</span></button>
        }
      >
        <div class="cm-menu-user">Signed in as <strong>{me()!.user.name}</strong></div>
        <button type="button" class="ot-menu-item" onClick={() => { setMenuOpen(false); setView({ kind: "notifications" }); }}>
          <span class="ot-menu-item__label">Notifications<Show when={unread() > 0}><span class="cm-count">{unread()}</span></Show></span>
        </button>
        <button type="button" class="ot-menu-item" onClick={() => { setMenuOpen(false); setView({ kind: "account" }); }}><span class="ot-menu-item__label">Account</span></button>
        <button type="button" class="ot-menu-item" onClick={() => { setMenuOpen(false); setView({ kind: "propose" }); }}><span class="ot-menu-item__label">Propose a community</span></button>
        <Show when={isMod()}>
          <button type="button" class="ot-menu-item" onClick={() => { setMenuOpen(false); setView({ kind: "queue" }); }}><span class="ot-menu-item__label">Moderation queue</span></button>
        </Show>
        <button type="button" class="ot-menu-item" onClick={() => { setMenuOpen(false); void signOut(); }}><span class="ot-menu-item__label">Sign out</span></button>
      </Show>
      <div class="ot-popover-separator cm-menu-separator" />
      <button type="button" class="ot-menu-item" onClick={() => { setMenuOpen(false); void openUrl(RULES_URL); }}><span class="ot-menu-item__label">Community rules</span></button>
      <button type="button" class="ot-menu-item" onClick={() => { setMenuOpen(false); void openUrl(CONTACT_URL); }}><span class="ot-menu-item__label">Contact and reports</span></button>
    </div>
  );

  // ── Views ─────────────────────────────────────────────────────────────
  const PostRow = (p: { post: Post }) => (
    <div class="cm-post-row" role="button" tabIndex={0} onClick={() => setView({ kind: "post", id: p.post.id })} onKeyDown={(e) => e.key === "Enter" && setView({ kind: "post", id: p.post.id })}>
      <Vote
        vertical type="post" id={p.post.id} score={p.post.score} myVote={p.post.my_vote}
        onChange={(score, my) => setPosts((list) => list.map((x) => (x.id === p.post.id ? { ...x, score, my_vote: my } : x)))}
        onNeedSignIn={needSignIn} onError={setError}
      />
      <div class="cm-post-main">
        <div class="cm-post-title">{p.post.title}</div>
        <Show when={p.post.excerpt}><div class="cm-post-excerpt">{plainText(p.post.excerpt)}</div></Show>
        <div class="cm-meta">
          <Show when={!communityId()}>
            <button type="button" class="cm-community-link" onClick={(e) => { e.stopPropagation(); choose(p.post.community.id); }}>{p.post.community.title}</button>
            <span class="cm-dot">·</span>
          </Show>
          <Author name={p.post.author} />
          <span class="cm-dot">·</span>
          <Age at={p.post.created_at} />
          <span class="cm-dot">·</span>
          <span class="cm-comment-count"><Icon name="community-comment" size={18} />{p.post.comment_count}</span>
          <Show when={p.post.has_chart}><span class="cm-badge">Chart</span></Show>
        </div>
      </div>
      <Show when={p.post.image_url}>
        <img class="cm-thumb" src={imageUrl(p.post.image_url!)} alt="" loading="lazy" />
      </Show>
    </div>
  );

  const ListView = () => (
    <>
      <div class="cm-toolbar">
        <SegmentedControl items={SORTS} value={sort()} onChange={setSort} ariaLabel="Sort" />
      </div>
      <div class="cm-scroll">
        <Show when={info()}>
          <div class="cm-info">
            <div class="cm-info-row">
              <div class="cm-info-title">{info()!.title}</div>
              <button type="button" class={"cm-btn is-small" + (info()!.followed ? "" : " is-primary")} onClick={toggleFollow}>
                {info()!.followed ? "Following" : "Follow"}
              </button>
            </div>
            <Show when={info()!.description}><div class="cm-muted">{info()!.description}</div></Show>
            <div class="cm-muted">
              {info()!.post_count} post{info()!.post_count === 1 ? "" : "s"}
              <Show when={!info()!.id.startsWith("t:") || info()!.post_count > 0}>
                {" · "}
                <button type="button" class="cm-community-link is-small" onClick={() => setView({ kind: "about" })}>About, moderators and log</button>
              </Show>
            </div>
          </div>
        </Show>
        <ErrorBanner text={error()} onClose={() => setError(null)} />
        <Switch>
          <Match when={source() === "following" && !me()}>
            <div class="ot-empty-state">Sign in to see the posts of the communities you follow.</div>
          </Match>
          <Match when={source() === "chart" && !chartCommunity()}>
            <div class="ot-empty-state">This symbol has no community.</div>
          </Match>
          <Match when={true}>
            <For
              each={posts()}
              fallback={
                <Show when={!loading()}>
                  <div class="ot-empty-state">
                    {source() === "following" ? "No posts from the communities you follow." : "No posts yet. Start the discussion."}
                  </div>
                </Show>
              }
            >
              {(p) => <PostRow post={p} />}
            </For>
            <Show when={loading()}><div class="ot-empty-state">Loading…</div></Show>
            <Show when={nextOffset() !== null && !loading()}>
              <button type="button" class="cm-more" onClick={loadMore}>Show more</button>
            </Show>
          </Match>
        </Switch>
        <div class="cm-disclaimer">{DISCLAIMER}</div>
      </div>
    </>
  );

  const Composer = () => {
    const targets = createMemo(() => {
      const list: { id: string; title: string }[] = [];
      const add = (id: string | null, title: string) => id && !list.some((t) => t.id === id) && list.push({ id, title });
      const cur = communityId();
      if (cur) add(cur, info()?.title ?? (cur.startsWith("t:") ? `$${cur.slice(2)}` : cur));
      const chart = chartCommunity();
      if (chart) add(chart, `$${chart.slice(2)}`);
      for (const t of themes() ?? []) add(t.id, t.title);
      return list;
    });
    const [target, setTarget] = createSignal(targets()[0]?.id ?? "");
    const [title, setTitle] = createSignal("");
    const [body, setBody] = createSignal("");
    const [busy, setBusy] = createSignal(false);
    const [err, setErr] = createSignal<string | null>(null);
    // "Attach my chart": the active chart's picture and state, taken when ticked.
    const [attached, setAttached] = createSignal<ChartCapture | null>(null);
    const [preview, setPreview] = createSignal<string | null>(null);
    const [capturing, setCapturing] = createSignal(false);
    onCleanup(() => { const u = preview(); if (u) URL.revokeObjectURL(u); });
    const attach = async (on: boolean) => {
      const old = preview();
      if (old) URL.revokeObjectURL(old);
      setPreview(null);
      setAttached(null);
      if (!on) return;
      setCapturing(true);
      try {
        const c = await chartBridge()?.capture();
        if (!c) return setErr("No chart to attach: open a chart first.");
        setAttached(c);
        setPreview(URL.createObjectURL(c.image));
        // A post about the chart goes to its ticker's community by default.
        const ticker = tickerCommunityId(tickerOf(c.chart.symbol));
        if (ticker && !title() && targets().some((t) => t.id === ticker)) setTarget(ticker);
      } catch (e) {
        setErr(errorText(e));
      } finally {
        setCapturing(false);
      }
    };
    const submit = async () => {
      setBusy(true);
      setErr(null);
      try {
        const a = attached();
        const attachment = a ? { chart: a.chart, image: await blobToBase64(a.image), imageType: a.image.type || "image/png" } : null;
        const r = await withPostingCheck(() => api.createPost(target(), title(), body(), attachment));
        if (source() !== "chart" || target() !== chartCommunity()) setSource(target());
        void reload();
        setView({ kind: "post", id: r.post.id });
      } catch (e) {
        setErr(errorText(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div class="cm-post-view">
        <div class="cm-subheader">
          <IconButton aria-label="Back" onClick={() => setView({ kind: "list" })}><Icon name="community-back" size={28} /></IconButton>
          <span class="cm-subheader-title is-static">New post</span>
        </div>
        <div class="cm-scroll cm-composer">
          <label class="cm-label">Community</label>
          <select class="cm-input" value={target()} onChange={(e) => setTarget(e.currentTarget.value)}>
            <For each={targets()}>{(t) => <option value={t.id}>{t.title}</option>}</For>
          </select>
          <label class="cm-label">Title</label>
          <input class="cm-input" maxLength={300} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
          <label class="cm-label">Text</label>
          <textarea class="cm-textarea is-tall" maxLength={20000} value={body()} onInput={(e) => setBody(e.currentTarget.value)} />
          <div class="cm-muted cm-hint">Markdown: **bold**, *italic*, [link](https://…), - lists, &gt; quotes.</div>
          <Show when={chartBridge()}>
            <label class="cm-radio cm-attach">
              <input type="checkbox" checked={!!attached()} disabled={capturing()} onChange={(e) => void attach(e.currentTarget.checked)} />
              <span>Attach my chart (picture, symbol, interval and drawings)</span>
            </label>
            <Show when={preview()}>
              <img class="cm-chart-img" src={preview()!} alt="Attached chart" />
              <div class="cm-muted cm-hint">
                {attached()!.chart.symbol} · {shortIntervalLabel(attached()!.chart.interval)} · {attached()!.chart.drawings.length} drawing{attached()!.chart.drawings.length === 1 ? "" : "s"}
              </div>
            </Show>
          </Show>
          <ErrorBanner text={err()} />
          <div class="cm-form-actions">
            <button type="button" class="cm-btn" onClick={() => setView({ kind: "list" })}>Cancel</button>
            <button type="button" class="cm-btn is-primary" disabled={busy() || title().trim().length < 3 || !target()} onClick={submit}>Post</button>
          </div>
          <div class="cm-disclaimer">{DISCLAIMER} Promotion, coordinated buying and undisclosed positions are removed: read the <ExternalLink href={RULES_URL}>community rules</ExternalLink>.</div>
        </div>
      </div>
    );
  };


  return (
    <aside class="ot-rail-panel cm-panel" aria-label="Community">
      <div ref={headerRef} class="cm-header-wrap">
        <PanelHeader
          left={
            <button type="button" class="cm-source" aria-haspopup="menu" aria-expanded={pickerOpen()} onClick={() => { setMenuOpen(false); setPickerOpen((o) => !o); }}>
              <span class="cm-source-label">{sourceLabel()}</span>
              <Icon name="community-caret" size={18} />
            </button>
          }
          right={
            <>
              <IconButton aria-label="New post" title="New post" onClick={() => (me() ? setView({ kind: "compose" }) : needSignIn())}>
                <Icon name="community-new" size={28} />
              </IconButton>
              <IconButton aria-label="More" title="More" onClick={() => { setPickerOpen(false); setMenuOpen((o) => !o); }}>
                <Icon name="community-more" size={28} />
              </IconButton>
            </>
          }
        />
        <Show when={pickerOpen()}><Picker /></Show>
        <Show when={menuOpen()}><Menu /></Show>
      </div>
      <PostingCheckPrompt />
      <Switch>
        <Match when={view().kind === "list"}><ListView /></Match>
        <Match when={view().kind === "post" && (view() as { id: string }).id}>
          {(id) => (
            <PostView
              postId={id()}
              onBack={() => setView({ kind: "list" })}
              onOpenCommunity={choose}
              onNeedSignIn={needSignIn}
              onChanged={() => { void reload(); void refetchInfo(); }}
            />
          )}
        </Match>
        <Match when={view().kind === "compose"}><Composer /></Match>
        <Match when={view().kind === "queue"}>
          <ModQueue onBack={() => setView({ kind: "list" })} onOpenPost={(id) => id && setView({ kind: "post", id })} />
        </Match>
        <Match when={view().kind === "account"}><AccountView onBack={() => setView({ kind: "list" })} /></Match>
        <Match when={view().kind === "notifications"}>
          <NotificationsView onBack={() => setView({ kind: "list" })} onOpenPost={(id) => setView({ kind: "post", id })} />
        </Match>
        <Match when={view().kind === "about" && info()}>
          <AboutView community={info()!} onBack={() => setView({ kind: "list" })} onOpenPost={(id) => setView({ kind: "post", id })} />
        </Match>
        <Match when={view().kind === "propose"}><ProposeView onBack={() => setView({ kind: "list" })} /></Match>
        <Match when={view().kind === "signin"}>
          <div class="cm-post-view">
            <div class="cm-subheader">
              <IconButton aria-label="Back" onClick={() => setView(afterSignIn)}><Icon name="community-back" size={28} /></IconButton>
            </div>
            <div class="cm-scroll">
              <SignInBox providers={providers() ?? null} error={error()} onError={setError} onSignedIn={() => setView(afterSignIn)} />
            </div>
          </div>
        </Match>
      </Switch>
    </aside>
  );
}
