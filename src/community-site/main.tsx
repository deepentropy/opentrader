/*
 * OpenTrader Community website: the app's Community panel, full width, at
 * community.opentrader.markets. Reading is open to everyone; posting,
 * commenting and voting need a sign-in (pop-up, public/community-auth.html).
 *
 * Addresses: / (all communities), /following, /t/AAPL, /c/penny-stocks,
 * /p/<post id>, /contact.
 */
import { render } from "solid-js/web";
import { Show, createSignal } from "solid-js";
import { hydrateKv } from "../data/kv";
import { CommunityPanel, type CommunityRoute } from "../window/right-rail/community/CommunityPanel";
import { ContactPage } from "./ContactPage";
import icon from "../assets/app-icon-32.png";
import "./site.css";

const APP_URL = "https://opentrader.markets";

type Page = { kind: "panel"; route: CommunityRoute } | { kind: "contact" };

export function parsePath(path: string): Page {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "contact") return { kind: "contact" };
  if (parts[0] === "p" && parts[1]) return { kind: "panel", route: { source: "all", postId: parts[1] } };
  if (parts[0] === "t" && parts[1]) return { kind: "panel", route: { source: `t:${parts[1].toUpperCase()}`, postId: null } };
  if (parts[0] === "c" && parts[1]) return { kind: "panel", route: { source: `c:${parts[1]}`, postId: null } };
  if (parts[0] === "following") return { kind: "panel", route: { source: "following", postId: null } };
  return { kind: "panel", route: { source: "all", postId: null } };
}

export function pathOf(r: CommunityRoute): string {
  if (r.postId) return `/p/${encodeURIComponent(r.postId)}`;
  if (r.source.startsWith("t:")) return `/t/${encodeURIComponent(r.source.slice(2))}`;
  if (r.source.startsWith("c:")) return `/c/${encodeURIComponent(r.source.slice(2))}`;
  if (r.source === "following") return "/following";
  return "/";
}

function titleOf(r: CommunityRoute): string {
  if (r.postId) return document.title;
  if (r.source.startsWith("t:")) return `$${r.source.slice(2)} · OpenTrader Community`;
  if (r.source === "following") return "Following · OpenTrader Community";
  return "OpenTrader Community";
}

function Site() {
  const [page, setPage] = createSignal<Page>(parsePath(location.pathname));
  window.addEventListener("popstate", () => setPage(parsePath(location.pathname)));

  const go = (path: string) => {
    if (path !== location.pathname) history.pushState(null, "", path);
    setPage(parsePath(path));
  };
  const onRoute = (r: CommunityRoute) => {
    const path = pathOf(r);
    if (path !== location.pathname) {
      history.pushState(null, "", path);
      document.title = titleOf(r);
    }
  };
  const route = () => {
    const p = page();
    return p.kind === "panel" ? p.route : undefined;
  };

  return (
    <div class="cs-page">
      <header class="cs-top">
        <a class="cs-brand" href="/" onClick={(e) => { e.preventDefault(); go("/"); }}>
          <img src={icon} width="28" height="28" alt="" />
          <span>OpenTrader <strong>Community</strong></span>
        </a>
        <nav class="cs-nav">
          <a href="https://demo.opentrader.markets/">Try the charts</a>
          <a class="cs-btn" href={`${APP_URL}/download.html`}>Get the app</a>
        </nav>
      </header>
      <main class="cs-main">
        <Show when={page().kind === "panel"} fallback={<ContactPage onBack={() => go("/")} />}>
          <CommunityPanel web route={route()} onRoute={onRoute} />
        </Show>
      </main>
      <footer class="cs-foot">
        <a href={`${APP_URL}/community-rules.html`}>Rules</a>
        <a href={`${APP_URL}/terms.html`}>Terms</a>
        <a href={`${APP_URL}/privacy.html`}>Privacy</a>
        <a href="/contact" onClick={(e) => { e.preventDefault(); go("/contact"); }}>Contact and reports</a>
        <span>Posts are members' opinions, not financial advice.</span>
      </footer>
    </div>
  );
}

void hydrateKv().finally(() => render(() => <Site />, document.getElementById("root")!));
