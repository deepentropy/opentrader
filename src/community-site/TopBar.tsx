/*
 * The website's top bar: the brand, Home / Tickers / Search / Guidelines, the
 * search box, New post and the account (initials; its menu holds the
 * notifications, the account and moderation). The composer has its own bar:
 * the brand, when the draft was saved, Discard.
 */
import { For, Show, createSignal, onCleanup } from "solid-js";
import { me, signOut } from "../data/community/session";
import { unread } from "../data/community/notifications";
import { go, navigate, route } from "./router";
import { SEARCH_ICON, initials, signInPath } from "./ui";
import icon from "../../docs/assets/site/icon-64.png";

export const RULES_URL = "https://opentrader.markets/community-rules.html";

export function Brand() {
  return (
    <a class="cs-brand" href="/" onClick={go("/")}>
      <img src={icon} width="30" height="30" alt="" />
      <span class="cs-word">Open<span class="cs-word-accent">Trader</span></span>
      <span class="cs-brand-sub">Community</span>
    </a>
  );
}

const NAV = [
  { id: "home", label: "Home", href: "/" },
  { id: "tickers", label: "Tickers", href: "/tickers" },
  { id: "search", label: "Search", href: "/search" },
];

export function TopBar() {
  const [query, setQuery] = createSignal("");
  const [menuOpen, setMenuOpen] = createSignal(false);
  const current = () => {
    const p = route().page;
    if (p === "ticker" || p === "general" || p === "tickers" || p === "about") return "tickers";
    if (p === "search") return "search";
    return p === "home" ? "home" : "";
  };
  const search = (e: Event) => {
    e.preventDefault();
    const q = query().trim();
    if (!q) return;
    setQuery("");
    navigate(`/search?q=${encodeURIComponent(q)}`);
  };
  let menuRef: HTMLDivElement | undefined;
  const outside = (e: PointerEvent) => menuRef && !menuRef.contains(e.target as Node) && setMenuOpen(false);
  document.addEventListener("pointerdown", outside, true);
  onCleanup(() => document.removeEventListener("pointerdown", outside, true));
  const isMod = () => {
    const m = me()?.moderates;
    return m === "all" || (Array.isArray(m) && m.length > 0);
  };
  const item = (path: string) => (e: MouseEvent) => {
    setMenuOpen(false);
    go(path)(e);
  };
  const newPost = () => {
    const r = route();
    if (r.page === "ticker") return `/submit?to=${encodeURIComponent(`t:${r.ticker}`)}`;
    if (r.page === "general") return "/submit?to=c%3Ageneral";
    return "/submit";
  };

  return (
    <header class="cs-top">
      <Brand />
      <nav class="cs-nav" aria-label="Sections">
        <For each={NAV}>
          {(n) => (
            <a href={n.href} onClick={go(n.href)} class={current() === n.id ? "is-on" : ""} aria-current={current() === n.id ? "page" : undefined}>
              {n.label}
            </a>
          )}
        </For>
        <a href={RULES_URL}>Guidelines</a>
      </nav>
      <Show when={route().page !== "search"}>
        <form class="cs-search" role="search" onSubmit={search}>
          <span class="cs-search-icon">{SEARCH_ICON()}</span>
          <input placeholder="Search posts, tickers, people" aria-label="Search posts, tickers, people" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        </form>
      </Show>
      <a class="cs-btn is-primary" href={newPost()} onClick={go(newPost())}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14" /><path d="M12 5v14" /></svg>
        New post
      </a>
      <Show
        when={me()}
        fallback={<a class="cs-btn" href={signInPath()} onClick={go(signInPath())}>Sign in</a>}
      >
        <div class="cs-account" ref={menuRef}>
          <button type="button" class="cs-me" aria-haspopup="menu" aria-expanded={menuOpen()} onClick={() => setMenuOpen((o) => !o)} title={me()!.user.name}
            aria-label={`${me()!.user.name}${unread() ? `, ${unread()} unread notifications` : ""}`}>
            {initials(me()!.user.name)}
            <Show when={unread() > 0}><span class="cs-badge">{unread() > 99 ? "99+" : unread()}</span></Show>
          </button>
          <Show when={menuOpen()}>
            <div class="cs-account-menu" role="menu">
              <div class="cs-account-name">{me()!.user.name}</div>
              <a role="menuitem" href={`/u/${encodeURIComponent(me()!.user.name)}`} onClick={item(`/u/${encodeURIComponent(me()!.user.name)}`)}>Profile</a>
              <a role="menuitem" href="/notifications" onClick={item("/notifications")}>Notifications<Show when={unread() > 0}> ({unread()})</Show></a>
              <a role="menuitem" href="/account" onClick={item("/account")}>Account</a>
              <Show when={isMod()}><a role="menuitem" href="/mod" onClick={item("/mod")}>Moderation queue</a></Show>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void signOut(); }}>Sign out</button>
            </div>
          </Show>
        </div>
      </Show>
    </header>
  );
}

/** The composer's bar: when the draft was saved, and Discard. */
export function ComposeBar(props: { savedAt: number | null; onDiscard: () => void }) {
  const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
  return (
    <header class="cs-top">
      <Brand />
      <span class="cs-top-spacer" />
      <Show when={props.savedAt}><span class="cs-draft">Draft saved {hhmm(props.savedAt!)}</span></Show>
      <button type="button" class="cs-btn" onClick={() => props.onDiscard()}>Discard</button>
    </header>
  );
}
