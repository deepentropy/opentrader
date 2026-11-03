/*
 * CommunityPanel — right-rail "community" tab: posts per ticker (US stocks
 * and ETFs) and in General, served by deploy/community. The website
 * (src/community-site) is the full design of the same content; the panel
 * keeps a compact one.
 *
 * The header picks what the list shows: the ticker of the active chart (the
 * default: it follows the chart), my tickers, all posts, General, or any
 * ticker typed in. Newest / Most useful sort it. Every post has a type
 * (idea, analysis, question, post-mortem); an idea carries locked levels
 * and settles against price. A post opens in the panel with its replies;
 * writing, rating and reporting need an account (data/community/session.ts).
 * The panel also sends chart snapshots to the account (for posts written on
 * the website) and syncs the member's tickers with the active watchlist.
 */
import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js";
import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/IconButton";
import { PanelHeader } from "../../../components/PanelHeader";
import { SegmentedControl } from "../../../components/SegmentedControl";
import { tickerOf } from "../../../data/symbol-name";
import * as kv from "../../../data/kv";
import { plainText } from "../../../data/community/markdown";
import { GENERAL, api, imageUrl, tickerCommunityId, type Direction, type Post, type PostType, type Sort } from "../../../data/community/api";
import { TYPE_LABEL, TYPES, price } from "../../../data/community/format";
import { blobToBase64, chartBridge, type ChartCapture } from "../../../data/community/chart-share";
import { shortIntervalLabel } from "../../chart/interval-favorites";
import { initSession, me, ready, refreshMe, signOut } from "../../../data/community/session";
import { watchlistStore, listItems, isSectionId } from "../../../data/watchlist-store";
import { PostView } from "./PostView";
import { AboutView, AccountView, NotificationsView } from "./MoreViews";
import { openPost, startNotifications, unread } from "../../../data/community/notifications";
import { withPostingCheck } from "../../../data/community/posting-check";
import { shareRequest, takeShare } from "../../../data/community/share";
import { ModQueue } from "./ModQueue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Age, Author, AuthorRecord, BotBadge, CONTACT_URL, ErrorBanner, ExternalLink, PostState, PostingCheckPrompt, RULES_URL, SignInBox, TypeBadges, errorText } from "./parts";

/** "chart" (follows the chart), "following" (my tickers), "all", or a community id. */
type Source = string;
type View =
  | { kind: "list" }
  | { kind: "post"; id: string; openChart?: boolean }
  | { kind: "compose" }
  | { kind: "signin" }
  | { kind: "queue" }
  | { kind: "account" }
  | { kind: "notifications" }
  | { kind: "about" };

const SOURCE_KEY = "ot:community:source";
const SORT_KEY = "ot:community:sort";
const WEBSITE = "https://community.opentrader.markets";

const SORTS = [
  { id: "new" as const, label: "Newest" },
  { id: "useful" as const, label: "Most useful" },
];

const DISCLAIMER = "Posts are members' opinions, not financial advice.";

const inWeeks = (n: number) => new Date(Date.now() + n * 7 * 86_400_000).toISOString().slice(0, 10);

/** The active watchlist's stock tickers (the server keeps the US stocks and ETFs). */
function watchlistTickers(): string[] {
  const l = watchlistStore.active();
  if (!l) return [];
  return [...new Set(listItems(l).filter((id) => !isSectionId(id)).map((s) => tickerOf(s)).filter((t) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)))];
}

type Props = { symbol?: string };

export function CommunityPanel(props: Props) {
  const saved = kv.getItem(SOURCE_KEY);
  const [source, setSource] = createSignal<Source>(saved && (saved === "chart" || saved === "following" || saved === "all" || saved === GENERAL || saved.startsWith("t:")) ? saved : "chart");
  const savedSort = kv.getItem(SORT_KEY);
  const [sort, setSort] = createSignal<Sort>(savedSort === "useful" ? "useful" : "new");
  const [view, setView] = createSignal<View>({ kind: "list" });
  /** Where the sign-in view goes back to. */
  let afterSignIn: View = { kind: "list" };
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);

  createEffect(() => kv.setItem(SOURCE_KEY, source()));
  createEffect(() => kv.setItem(SORT_KEY, sort()));
  onMount(() => void initSession().then(startNotifications));

  /** A snapshot of the active chart, sent to the account: picked on the website when posting there. */
  const sendSnapshot = async () => {
    setError(null);
    try {
      const c = await chartBridge()?.capture();
      if (!c) return setError("No chart to send: open a chart first.");
      await api.addSnapshot(c.chart, await blobToBase64(c.image), c.image.type || "image/png");
      setNotice(`Snapshot of ${c.chart.symbol}, ${shortIntervalLabel(c.chart.interval)} sent. Attach it to a post or a reply on the website.`);
    } catch (e) {
      setError(errorText(e));
    }
  };
  // "Share to Community" elsewhere in the app: the composer, or the snapshot sent (after a sign-in when needed).
  let pendingSnapshot = false;
  createEffect(on(shareRequest, (s) => {
    if (!s) return;
    if (s.snapshotOnly) {
      takeShare();
      if (me()) void sendSnapshot();
      else {
        pendingSnapshot = true;
        afterSignIn = { kind: "list" };
        setView({ kind: "signin" });
      }
      return;
    }
    if (me()) setView({ kind: "compose" });
    else {
      afterSignIn = { kind: "compose" };
      setView({ kind: "signin" });
    }
  }));
  // A notification's pop-up asked for its post.
  createEffect(on(openPost, (o) => o && setView({ kind: "post", id: o.id, openChart: o.openChart })));

  const chartCommunity = () => (props.symbol ? tickerCommunityId(tickerOf(props.symbol)) : null);
  /** The single community shown, or null for a feed. */
  const communityId = createMemo(() => {
    const s = source();
    if (s === "chart") return chartCommunity();
    if (s === "following" || s === "all") return null;
    return s;
  });

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

  /** The member's tickers become the active watchlist's. */
  const syncTickers = async () => {
    setError(null);
    const list = watchlistTickers();
    if (!list.length) return setError("The active watchlist has no stock symbols.");
    try {
      const r = await api.setTickers(list);
      await refreshMe();
      const n = r.follows.filter((f) => f.kind === "ticker").length;
      setNotice(`Your tickers are the ${n} US stocks and ETFs of the watchlist "${watchlistStore.active()?.name ?? ""}".`);
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

  const label = (id: string) => (id === GENERAL ? "General" : id.slice(2));
  const sourceLabel = () => {
    const s = source();
    if (s === "chart") return chartCommunity() ? label(chartCommunity()!) : "This chart";
    if (s === "following") return "My tickers";
    if (s === "all") return "All posts";
    return label(s);
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
      <button type="button" class="ot-menu-item" onClick={() => choose("chart")}>
        <span class="ot-menu-item__label">{chartCommunity() ? label(chartCommunity()!) : "Chart symbol"}<span class="cm-muted"> · this chart</span></span>
      </button>
      <button type="button" class="ot-menu-item" onClick={() => choose("following")}><span class="ot-menu-item__label">My tickers</span></button>
      <button type="button" class="ot-menu-item" onClick={() => choose("all")}><span class="ot-menu-item__label">All posts</span></button>
      <button type="button" class="ot-menu-item" onClick={() => choose(GENERAL)}><span class="ot-menu-item__label">General</span></button>
      <Show when={me()?.follows.some((f) => f.kind === "ticker")}>
        <div class="cm-picker-section">My tickers</div>
        <For each={me()!.follows.filter((f) => f.kind === "ticker")}>
          {(f) => (
            <button type="button" class="ot-menu-item" onClick={() => choose(f.id)}><span class="ot-menu-item__label">{label(f.id)}</span></button>
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

  const item = (text: string, fn: () => void) => (
    <button type="button" class="ot-menu-item" onClick={() => { setMenuOpen(false); fn(); }}><span class="ot-menu-item__label">{text}</span></button>
  );

  const Menu = () => (
    <div class="ot-popover cm-menu" role="menu">
      <Show when={me()} fallback={item("Sign in", needSignIn)}>
        <div class="cm-menu-user">Signed in as <strong>{me()!.user.name}</strong></div>
        <button type="button" class="ot-menu-item" onClick={() => { setMenuOpen(false); setView({ kind: "notifications" }); }}>
          <span class="ot-menu-item__label">Notifications<Show when={unread() > 0}><span class="cm-count">{unread()}</span></Show></span>
        </button>
        {item("My profile and record", () => void openUrl(`${WEBSITE}/u/${encodeURIComponent(me()!.user.name)}`))}
        {item("Account", () => setView({ kind: "account" }))}
        <Show when={chartBridge()}>{item("Send snapshot to Community", () => void sendSnapshot())}</Show>
        {item("Sync my tickers with the watchlist", () => void syncTickers())}
        <Show when={isMod()}>{item("Moderation queue", () => setView({ kind: "queue" }))}</Show>
        {item("Sign out", () => void signOut())}
      </Show>
      <div class="ot-popover-separator cm-menu-separator" />
      {item("Open the Community website", () => void openUrl(WEBSITE))}
      {item("Community guidelines", () => void openUrl(RULES_URL))}
      {item("Contact and reports", () => void openUrl(CONTACT_URL))}
    </div>
  );

  // ── Views ─────────────────────────────────────────────────────────────
  const PostRow = (p: { post: Post }) => (
    <div class="cm-post-row is-plain" role="button" tabIndex={0} onClick={() => setView({ kind: "post", id: p.post.id })} onKeyDown={(e) => e.key === "Enter" && setView({ kind: "post", id: p.post.id })}>
      <div class="cm-post-main">
        <div class="cm-meta">
          <TypeBadges post={p.post} />
          <Show when={!communityId()}>
            <button type="button" class="cm-community-link" onClick={(e) => { e.stopPropagation(); choose(p.post.community.id); }}>{label(p.post.community.id)}</button>
          </Show>
        </div>
        <div class="cm-post-title">{p.post.title}</div>
        <Show when={p.post.excerpt}><div class="cm-post-excerpt">{plainText(p.post.excerpt)}</div></Show>
        <div class="cm-meta">
          <Author name={p.post.author} />
          <BotBadge show={p.post.author_bot} />
          <AuthorRecord post={p.post} />
          <span class="cm-dot">·</span>
          <Age at={p.post.created_at} />
        </div>
        <div class="cm-meta">
          <span>{p.post.useful_count} useful</span>
          <span class="cm-dot">·</span>
          <span class="cm-comment-count"><Icon name="community-comment" size={18} />{p.post.comment_count}</span>
          <PostState post={p.post} />
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
              <div class="cm-info-title">{label(info()!.id)}</div>
              <Show when={info()!.kind === "ticker"}>
                <button type="button" class={"cm-btn is-small" + (info()!.followed ? "" : " is-primary")} onClick={toggleFollow}>
                  {info()!.followed ? "In my tickers" : "Add to my tickers"}
                </button>
              </Show>
            </div>
            <Show when={info()!.description}><div class="cm-muted">{info()!.description}</div></Show>
            <div class="cm-muted">
              {info()!.post_count} post{info()!.post_count === 1 ? "" : "s"}
              {" · "}
              <ExternalLink href={`${WEBSITE}${info()!.id === GENERAL ? "/c/general" : `/t/${encodeURIComponent(info()!.id.slice(2))}`}`}>Open ideas and record on the website</ExternalLink>
              <Show when={info()!.post_count > 0}>
                {" · "}
                <button type="button" class="cm-community-link is-small" onClick={() => setView({ kind: "about" })}>Moderators and log</button>
              </Show>
            </div>
          </div>
        </Show>
        <ErrorBanner text={error()} onClose={() => setError(null)} />
        <Show when={notice()}>
          <div class="cm-notice" role="status"><span>{notice()}</span><button type="button" class="cm-error-close" aria-label="Close" onClick={() => setNotice(null)}>×</button></div>
        </Show>
        <Switch>
          <Match when={source() === "following" && !me()}>
            <div class="ot-empty-state">Sign in to see the posts on your tickers.</div>
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
                    {source() === "following" ? "No posts on your tickers yet." : "No posts yet. Start the discussion."}
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
      const add = (id: string | null) => id && !list.some((t) => t.id === id) && list.push({ id, title: label(id) });
      add(communityId());
      add(chartCommunity());
      for (const f of me()?.follows ?? []) if (f.kind === "ticker") add(f.id);
      add(GENERAL);
      return list;
    });
    // A share request from elsewhere fills the post in.
    const seed = takeShare();
    const [type, setType] = createSignal<PostType>(seed?.body ? "analysis" : "idea");
    const [target, setTarget] = createSignal(seed?.to && targets().some((t) => t.id === seed.to) ? seed.to : targets()[0]?.id ?? GENERAL);
    const [title, setTitle] = createSignal(seed?.title ?? "");
    const [body, setBody] = createSignal(seed?.body ?? "");
    const [direction, setDirection] = createSignal<Direction>("long");
    const [entry, setEntry] = createSignal("");
    const [stop, setStop] = createSignal("");
    const [target2, setTarget2] = createSignal("");
    const [expires, setExpires] = createSignal(inWeeks(6));
    const [rule, setRule] = createSignal<"close" | "touch">("close");
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
        // A post about the chart goes to its ticker by default.
        const ticker = tickerCommunityId(tickerOf(c.chart.symbol));
        if (ticker && !seed?.to && targets().some((t) => t.id === ticker)) setTarget(ticker);
      } catch (e) {
        setErr(errorText(e));
      } finally {
        setCapturing(false);
      }
    };
    // "Share to Community" asked for the chart: attached at once.
    if (seed?.attach) queueMicrotask(() => void attach(true));
    const n = (s: string) => (s.trim() ? Number(s) : NaN);
    const levels = createMemo(() => {
      const e = n(entry()), s = n(stop()), t = n(target2());
      const ok = [e, s, t].every((v) => Number.isFinite(v) && v > 0) && (direction() === "long" ? s < e && e < t : t < e && e < s);
      return { e, s, t, ok, rr: ok ? Math.abs(t - e) / Math.abs(e - s) : null };
    });
    const isIdea = () => type() === "idea";
    const ready = () => title().trim().length >= 3 && !!target() && (!isIdea() || (target() !== GENERAL && levels().ok && !!expires()));
    const submit = async () => {
      setBusy(true);
      setErr(null);
      try {
        const a = attached();
        const attachment = a ? { chart: a.chart, image: await blobToBase64(a.image), imageType: a.image.type || "image/png" } : null;
        const l = levels();
        const r = await withPostingCheck(() =>
          api.createPost(target(), {
            type: type(),
            title: title(),
            body: body(),
            idea: isIdea() ? { direction: direction(), entry: l.e, stop: l.s, target: l.t, expires: expires(), entry_rule: rule() } : undefined,
            attach: attachment,
          }),
        );
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
          <label class="cm-label">Kind of post</label>
          <SegmentedControl items={TYPES.map((t) => ({ id: t, label: TYPE_LABEL[t] }))} value={type()} onChange={setType} ariaLabel="Kind of post" />
          <label class="cm-label">Ticker</label>
          <select class="cm-input" value={target()} onChange={(e) => setTarget(e.currentTarget.value)}>
            <For each={targets()}>{(t) => <option value={t.id}>{t.title}</option>}</For>
          </select>
          <label class="cm-label">Title</label>
          <input class="cm-input" maxLength={300} placeholder={isIdea() ? "State the setup, not the hype" : ""} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
          <Show when={isIdea()}>
            <Show when={target() === GENERAL}><div class="cm-muted cm-hint">An idea is on a ticker: pick one above.</div></Show>
            <label class="cm-label">Levels, locked once posted</label>
            <SegmentedControl items={[{ id: "long" as const, label: "Long" }, { id: "short" as const, label: "Short" }]} value={direction()} onChange={setDirection} ariaLabel="Direction" />
            <div class="cm-levels-form">
              <input class="cm-input" inputMode="decimal" placeholder="Entry" aria-label="Entry" value={entry()} onInput={(e) => setEntry(e.currentTarget.value)} />
              <input class="cm-input" inputMode="decimal" placeholder="Stop" aria-label="Stop" value={stop()} onInput={(e) => setStop(e.currentTarget.value)} />
              <input class="cm-input" inputMode="decimal" placeholder="Target" aria-label="Target" value={target2()} onInput={(e) => setTarget2(e.currentTarget.value)} />
            </div>
            <label class="cm-label">Expires</label>
            <input class="cm-input" type="date" value={expires()} onInput={(e) => setExpires(e.currentTarget.value)} />
            <div class="cm-muted cm-hint">
              Reward : risk {levels().rr == null ? "—" : levels().rr!.toFixed(1)} · risk per share {levels().ok ? price(Math.abs(levels().e - levels().s)) : "—"} · entry on{" "}
              <button type="button" class="cm-community-link is-small" onClick={() => setRule(rule() === "close" ? "touch" : "close")}>{rule() === "close" ? "a daily close" : "a trade through it"}</button>
            </div>
            <div class="cm-muted cm-hint">Tracked against the price and added to your public record whatever the outcome. You can add updates, not move levels.</div>
          </Show>
          <label class="cm-label">{isIdea() ? "Thesis, trigger and risk" : "Text"}</label>
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
            <button type="button" class="cm-btn is-primary" disabled={busy() || !ready()} onClick={submit}>{isIdea() ? "Post idea" : "Post"}</button>
          </div>
          <div class="cm-disclaimer">{DISCLAIMER} Promotion, coordinated buying and undisclosed positions are removed: read the <ExternalLink href={RULES_URL}>community guidelines</ExternalLink>.</div>
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
              openChart={(view() as { openChart?: boolean }).openChart}
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
        <Match when={view().kind === "signin"}>
          <div class="cm-post-view">
            <div class="cm-subheader">
              <IconButton aria-label="Back" onClick={() => setView(afterSignIn)}><Icon name="community-back" size={28} /></IconButton>
            </div>
            <div class="cm-scroll">
              <SignInBox
                providers={providers() ?? null}
                error={error()}
                onError={setError}
                onSignedIn={() => {
                  setView(afterSignIn);
                  if (pendingSnapshot) {
                    pendingSnapshot = false;
                    void sendSnapshot();
                  }
                }}
              />
            </div>
          </div>
        </Match>
      </Switch>
    </aside>
  );
}
