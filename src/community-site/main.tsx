/*
 * OpenTrader Community website (community.opentrader.markets): a community
 * that informs, then lets you go. Every post declares a type; ideas carry
 * levels and settle against price, so authors build a track record, not a
 * following; readers say why a post was useful instead of voting. The home
 * feed starts at the last visit and ends when you're caught up.
 *
 * Reading is open to everyone; posting, replying and rating need a sign-in
 * (pop-up, public/community-auth.html). The desktop app's Community panel
 * is the other, compact design of the same content; the account, the
 * notifications and the moderation queue reuse its views, restyled here.
 */
import { render } from "solid-js/web";
import { Match, Show, Switch, createResource, createSignal } from "solid-js";
import { hydrateKv } from "../data/kv";
import { api } from "../data/community/api";
import { initSession, me } from "../data/community/session";
import { startNotifications } from "../data/community/notifications";
import { ModQueue } from "../window/right-rail/community/ModQueue";
import { AboutView, AccountView, NotificationsView } from "../window/right-rail/community/MoreViews";
import { SignInBox } from "../community-shared/parts";
import { ContactPage } from "./ContactPage";
import { TopBar } from "./TopBar";
import { Home } from "./Home";
import { PostPage } from "./PostPage";
import { Compose } from "./Compose";
import { GeneralPage, TickerPage } from "./TickerPage";
import { SearchPage } from "./SearchPage";
import { ProfilePage } from "./ProfilePage";
import { TickersPage } from "./TickersPage";
import { SuggestCompose, SuggestionsPage } from "./SuggestionsPage";
import { go, navigate, route, type Route } from "./router";
import { communityHref } from "./ui";
import "./site.css";

const APP_URL = "https://opentrader.markets";

const TITLES: Partial<Record<Route["page"], string>> = {
  home: "OpenTrader Community",
  tickers: "Tickers · OpenTrader Community",
  suggestions: "Suggestions · OpenTrader Community",
  suggest: "Suggest a feature · OpenTrader Community",
  submit: "New post · OpenTrader Community",
  notifications: "Notifications · OpenTrader Community",
  account: "Account · OpenTrader Community",
  queue: "Moderation queue · OpenTrader Community",
  contact: "Contact and reports · OpenTrader Community",
  signin: "Sign in · OpenTrader Community",
  notfound: "Page not found · OpenTrader Community",
};

function back(): void {
  if (history.length > 1) history.back();
  else navigate("/");
}

function SignInPage(props: { next: string }) {
  const [providers] = createResource(() => api.providers().then((r) => r.providers).catch(() => [] as string[]));
  const [error, setError] = createSignal<string | null>(null);
  return (
    <section class="cs-signin">
      <SignInBox providers={providers() ?? null} error={error()} onError={setError} onSignedIn={() => navigate(props.next)} />
    </section>
  );
}

function AboutPage(props: { id: string }) {
  const [community] = createResource(() => [props.id, me()?.user.name ?? ""] as const, ([id]) => api.community(id).then((r) => r.community));
  return (
    <Show when={community()} fallback={<p class="cs-loading">Loading…</p>}>
      <div class="cs-panel-page">
        <AboutView community={community()!} onBack={() => navigate(communityHref(props.id))} onOpenPost={(id) => navigate(`/p/${id}`)} />
      </div>
    </Show>
  );
}

/** The panel's views (account, notifications, moderation, contact), in a narrow column. */
function Narrow(props: { children: any }) {
  return <main id="cs-main" class="cs-narrow">{props.children}</main>;
}

function Site() {
  void initSession().then(startNotifications);
  const r = route;
  const syncTitle = () => {
    const t = TITLES[r().page];
    if (t) document.title = t;
    return null;
  };
  return (
    <div class="cs-site">
      <a class="cs-skip" href="#cs-main">Skip to the content</a>
      <Show when={r().page !== "submit"}><TopBar /></Show>
      {syncTitle()}
      <div class="cs-frame">
        <Switch>
          <Match when={r().page === "home"}><Home /></Match>
          <Match when={r().page === "ticker" && (r() as { ticker: string }).ticker}>{(t) => <TickerPage ticker={t()} />}</Match>
          <Match when={r().page === "general"}><GeneralPage /></Match>
          <Match when={r().page === "post" && (r() as { id: string }).id}>{(id) => <PostPage id={id()} />}</Match>
          <Match when={r().page === "submit" && (r() as Extract<Route, { page: "submit" }>)}>{(s) => <Compose to={s().to} type={s().type} />}</Match>
          <Match when={r().page === "search"}><SearchPage q={(r() as { q: string }).q} /></Match>
          <Match when={r().page === "user" && (r() as { name: string }).name}>{(n) => <ProfilePage name={n()} />}</Match>
          <Match when={r().page === "tickers"}><TickersPage /></Match>
          <Match when={r().page === "suggestions"}><SuggestionsPage /></Match>
          <Match when={r().page === "suggest"}><SuggestCompose /></Match>
          <Match when={r().page === "about" && (r() as { community: string }).community}>{(id) => <Narrow><AboutPage id={id()} /></Narrow>}</Match>
          <Match when={r().page === "notifications"}>
            <Narrow><div class="cs-panel-page"><NotificationsView onBack={back} onOpenPost={(id) => navigate(`/p/${id}`)} /></div></Narrow>
          </Match>
          <Match when={r().page === "account"}><Narrow><div class="cs-panel-page"><AccountView onBack={() => navigate("/")} /></div></Narrow></Match>
          <Match when={r().page === "queue"}>
            <Narrow><div class="cs-panel-page"><ModQueue onBack={back} onOpenPost={(id) => id && navigate(`/p/${id}`)} /></div></Narrow>
          </Match>
          <Match when={r().page === "contact"}><Narrow><div class="cs-panel-page"><ContactPage onBack={back} /></div></Narrow></Match>
          <Match when={r().page === "signin" && (r() as { next: string }).next}>{(next) => <Narrow><SignInPage next={next()} /></Narrow>}</Match>
          <Match when={r().page === "notfound"}>
            <Narrow><p class="cs-page-msg">This page doesn't exist. <a href="/" onClick={go("/")}>Back to the community</a>.</p></Narrow>
          </Match>
        </Switch>
      </div>
      <footer class="cs-foot">
        <a href={`${APP_URL}/community-rules.html`}>Guidelines</a>
        <a href={`${APP_URL}/terms.html`}>Terms</a>
        <a href={`${APP_URL}/privacy.html`}>Privacy</a>
        <a href={`${APP_URL}/legal.html`}>Legal notice</a>
        <a href="/contact" onClick={go("/contact")}>Contact and reports</a>
        <a href={`${APP_URL}/download.html`}>Get the app</a>
        <span>Posts are members' opinions, not financial advice. Prices delayed 15 minutes. Markets: US stocks.</span>
      </footer>
    </div>
  );
}

// The server writes the page's content in for search engines (deploy/community/src/pages.ts): the live page replaces it.
void hydrateKv().finally(() => {
  const root = document.getElementById("root")!;
  root.textContent = "";
  render(() => <Site />, root);
});
