/*
 * OpenTrader Community website (community.opentrader.markets): browsing the
 * communities in a browser, the desktop app's Community panel being the other
 * design of the same content. Reading is open to everyone; posting,
 * commenting and voting need a sign-in (pop-up, public/community-auth.html).
 *
 * Layout: top bar, communities on the left (a drawer on narrow screens), the
 * page in the middle, the community card and rules on the right. Post pages
 * and the account pages reuse the panel's views (PostView, …) restyled here.
 */
import { render } from "solid-js/web";
import { Match, Show, Switch, createResource, createSignal } from "solid-js";
import { hydrateKv } from "../data/kv";
import { api, type Community } from "../data/community/api";
import { initSession, me } from "../data/community/session";
import { startNotifications } from "../data/community/notifications";
import { PostView } from "../window/right-rail/community/PostView";
import { ModQueue } from "../window/right-rail/community/ModQueue";
import { AboutView, AccountView, NotificationsView, ProposeView } from "../window/right-rail/community/MoreViews";
import { SignInBox } from "../window/right-rail/community/parts";
import { ContactPage } from "./ContactPage";
import { TopBar } from "./TopBar";
import { LeftNav } from "./LeftNav";
import { Feed } from "./Feed";
import { Sidebar } from "./Sidebar";
import { WebComposer } from "./WebComposer";
import { communityPath, go, navigate, route, type Route } from "./router";
import "./site.css";

const APP_URL = "https://opentrader.markets";

const TITLES: Partial<Record<Route["page"], string>> = {
  submit: "New post",
  notifications: "Notifications",
  account: "Account",
  queue: "Moderation queue",
  propose: "Propose a community",
  contact: "Contact and reports",
  signin: "Sign in",
};

function back(): void {
  if (history.length > 1) history.back();
  else navigate("/");
}

function SignInPage(props: { next: string }) {
  const [providers] = createResource(() => api.providers().then((r) => r.providers).catch(() => [] as string[]));
  const [error, setError] = createSignal<string | null>(null);
  return (
    <section class="cs-page cs-signin">
      <SignInBox providers={providers() ?? null} error={error()} onError={setError} onSignedIn={() => navigate(props.next)} />
    </section>
  );
}

function AboutPage(props: { id: string }) {
  const [community] = createResource(() => [props.id, me()?.user.name ?? ""] as const, ([id]) => api.community(id).then((r) => r.community));
  return (
    <Show when={community()} fallback={<p class="cs-loading">Loading…</p>}>
      <div class="cs-panel-page">
        <AboutView community={community()!} onBack={() => navigate(communityPath(props.id))} onOpenPost={(id) => navigate(`/p/${id}`)} />
      </div>
    </Show>
  );
}

function Site() {
  const [themes] = createResource(() => api.themes().then((r) => r.communities).catch(() => [] as Community[]));
  const [navOpen, setNavOpen] = createSignal(false);
  void initSession().then(startNotifications);

  const sideCommunity = () => {
    const r = route();
    if (r.page === "feed") return r.source;
    if (r.page === "about") return r.community;
    return null;
  };
  const signIn = () => navigate(`/signin?next=${encodeURIComponent(location.pathname)}`);
  const showSide = () => ["feed", "post", "about"].includes(route().page);
  const r = route;

  return (
    <div class="cs-site">
      <a class="cs-skip" href="#cs-main">Skip to the posts</a>
      <TopBar themes={themes() ?? []} onMenu={() => setNavOpen((o) => !o)} />
      <div class={"cs-layout" + (showSide() ? "" : " no-side")}>
        <LeftNav themes={themes() ?? []} open={navOpen()} onClose={() => setNavOpen(false)} />
        <main id="cs-main" class="cs-main">
          <Switch>
            <Match when={r().page === "feed" && (r() as { source: string }).source}>{(source) => <Feed source={source()} />}</Match>
            <Match when={r().page === "post" && (r() as { id: string }).id}>
              {(id) => (
                <div class="cs-post">
                  <PostView postId={id()} onBack={back} onOpenCommunity={(c) => navigate(communityPath(c))} onNeedSignIn={signIn} onChanged={() => {}} />
                </div>
              )}
            </Match>
            <Match when={r().page === "about" && (r() as { community: string }).community}>{(id) => <AboutPage id={id()} />}</Match>
            <Match when={r().page === "submit"}>
              <Show when={themes()}><WebComposer community={(r() as { community: string | null }).community} themes={themes()!} /></Show>
            </Match>
            <Match when={r().page === "notifications"}>
              <div class="cs-panel-page"><NotificationsView onBack={back} onOpenPost={(id) => navigate(`/p/${id}`)} /></div>
            </Match>
            <Match when={r().page === "account"}>
              <div class="cs-panel-page"><AccountView onBack={() => navigate("/")} /></div>
            </Match>
            <Match when={r().page === "queue"}>
              <div class="cs-panel-page"><ModQueue onBack={back} onOpenPost={(id) => id && navigate(`/p/${id}`)} /></div>
            </Match>
            <Match when={r().page === "propose"}>
              <div class="cs-panel-page"><ProposeView onBack={back} /></div>
            </Match>
            <Match when={r().page === "contact"}>
              <div class="cs-panel-page"><ContactPage onBack={back} /></div>
            </Match>
            <Match when={r().page === "signin" && (r() as { next: string }).next}>{(next) => <SignInPage next={next()} />}</Match>
          </Switch>
        </main>
        <Show when={showSide()}><Sidebar community={sideCommunity()} /></Show>
      </div>
      <footer class="cs-foot">
        <a href={`${APP_URL}/community-rules.html`}>Rules</a>
        <a href={`${APP_URL}/terms.html`}>Terms</a>
        <a href={`${APP_URL}/privacy.html`}>Privacy</a>
        <a href={`${APP_URL}/legal.html`}>Legal notice</a>
        <a href="/contact" onClick={go("/contact")}>Contact and reports</a>
        <span>Posts are members' opinions, not financial advice.</span>
      </footer>
    </div>
  );
}

// The page title follows the address (post and community pages get theirs from the server first).
function syncTitle(): void {
  const page = route().page;
  const t = TITLES[page];
  if (t) document.title = `${t} · OpenTrader Community`;
}
window.addEventListener("popstate", syncTitle);

void hydrateKv().finally(() => render(() => <Site />, document.getElementById("root")!));
