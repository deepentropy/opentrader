/*
 * The website's top bar: the brand, "Go to $TICKER or a community", and the
 * account: sign-in, or notifications and the account menu.
 */
import { For, Show, createSignal, onCleanup } from "solid-js";
import { tickerCommunityId, type Community } from "../data/community/api";
import { me, signOut } from "../data/community/session";
import { unread } from "../data/community/notifications";
import { communityPath, go, navigate } from "./router";
import icon from "../assets/app-icon-32.png";

const APP_URL = "https://opentrader.markets";

export function TopBar(props: { themes: Community[]; onMenu: () => void }) {
  const [query, setQuery] = createSignal("");
  const [error, setError] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);

  const search = (e: Event) => {
    e.preventDefault();
    const q = query().trim().replace(/^\$/, "");
    if (!q) return;
    const theme = props.themes.find((t) => t.title.toLowerCase() === q.toLowerCase() || t.id === `c:${q.toLowerCase()}`);
    const id = theme?.id ?? tickerCommunityId(q);
    if (!id) return setError(true);
    setError(false);
    setQuery("");
    navigate(communityPath(id));
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

  return (
    <header class="cs-top">
      <button type="button" class="cs-icon-btn cs-menu-btn" aria-label="Communities" onClick={() => props.onMenu()}>
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
      <a class="cs-brand" href="/" onClick={go("/")}>
        <img src={icon} width="26" height="26" alt="" />
        <span>OpenTrader Community</span>
      </a>
      <form class={"cs-search" + (error() ? " is-invalid" : "")} role="search" onSubmit={search}>
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="m13 13 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        <input
          list="cs-themes"
          placeholder="Go to $TICKER or a community"
          aria-label="Go to a ticker or a community"
          value={query()}
          onInput={(e) => { setQuery(e.currentTarget.value); setError(false); }}
        />
        <datalist id="cs-themes">
          <For each={props.themes}>{(t) => <option value={t.title} />}</For>
        </datalist>
      </form>
      <nav class="cs-top-actions">
        <a class="cs-link-quiet cs-hide-narrow" href="https://demo.opentrader.markets/">Try the charts</a>
        <a class="cs-btn cs-hide-narrow" href={`${APP_URL}/download.html`}>Get the app</a>
        <Show
          when={me()}
          fallback={
            <a class="cs-btn is-primary" href={`/signin?next=${encodeURIComponent(location.pathname)}`} onClick={go(`/signin?next=${encodeURIComponent(location.pathname)}`)}>
              Sign in
            </a>
          }
        >
          <a class="cs-icon-btn cs-bell" href="/notifications" onClick={go("/notifications")} aria-label={`Notifications${unread() ? `, ${unread()} unread` : ""}`}>
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5H4l1.5-1.5Zm3 2.5a1.5 1.5 0 0 0 3 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg>
            <Show when={unread() > 0}><span class="cs-badge">{unread() > 99 ? "99+" : unread()}</span></Show>
          </a>
          <div class="cs-account" ref={menuRef}>
            <button type="button" class="cs-avatar" aria-haspopup="menu" aria-expanded={menuOpen()} onClick={() => setMenuOpen((o) => !o)} title={me()!.user.name}>
              {me()!.user.name.slice(0, 1).toUpperCase()}
            </button>
            <Show when={menuOpen()}>
              <div class="cs-account-menu" role="menu">
                <div class="cs-account-name">{me()!.user.name}</div>
                <a role="menuitem" href="/account" onClick={item("/account")}>Account</a>
                <a role="menuitem" href="/notifications" onClick={item("/notifications")}>Notifications</a>
                <Show when={isMod()}><a role="menuitem" href="/mod" onClick={item("/mod")}>Moderation queue</a></Show>
                <a role="menuitem" href="/propose" onClick={item("/propose")}>Propose a community</a>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void signOut(); }}>Sign out</button>
              </div>
            </Show>
          </div>
        </Show>
      </nav>
    </header>
  );
}
