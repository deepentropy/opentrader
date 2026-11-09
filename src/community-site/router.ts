/*
 * The website's addresses and moves between them (history API).
 *
 *   /                 home: posts since the last visit   /tickers          the tickers
 *   /t/NVDA           a ticker's page                    /c/general        General
 *   /t/NVDA/about     its moderators and log             /p/<id>           a post
 *   /submit?to=&type= new post                           /search?q=        search
 *   /u/<name>         a trader's profile                 /suggestions      feature suggestions
 *   /suggestions/new  suggest a feature (a suggestion opens at /p/<id>)
 *   /notifications, /account, /mod (moderation queue), /contact, /signin?next=
 *
 * Addresses of the former communities (/c/options, /following) land on
 * General and on the home page.
 */
import { createSignal } from "solid-js";

export type Route =
  | { page: "home" }
  | { page: "ticker"; ticker: string }
  | { page: "general" }
  | { page: "about"; community: string }
  | { page: "post"; id: string }
  | { page: "submit"; to: string | null; type: string | null }
  | { page: "search"; q: string }
  | { page: "user"; name: string }
  | { page: "tickers" }
  | { page: "suggestions" }
  | { page: "suggest" }
  | { page: "notifications" }
  | { page: "account" }
  | { page: "queue" }
  | { page: "contact" }
  | { page: "signin"; next: string };

export function parseRoute(path: string, search: string): Route {
  const q = new URLSearchParams(search);
  const parts = path.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  const [a, b, c] = parts;
  if (a === "t" && b) return c === "about" ? { page: "about", community: `t:${b.toUpperCase()}` } : { page: "ticker", ticker: b.toUpperCase() };
  if (a === "c") return c === "about" ? { page: "about", community: "c:general" } : { page: "general" };
  switch (a) {
    case "p":
      return b ? { page: "post", id: b } : { page: "home" };
    case "u":
      return b ? { page: "user", name: b } : { page: "home" };
    case "submit":
      return { page: "submit", to: q.get("to"), type: q.get("type") };
    case "search":
      return { page: "search", q: q.get("q") ?? "" };
    case "suggestions":
      return b === "new" ? { page: "suggest" } : { page: "suggestions" };
    case "tickers":
    case "notifications":
    case "account":
    case "contact":
      return { page: a };
    case "mod":
      return { page: "queue" };
    case "signin":
      return { page: "signin", next: q.get("next") || "/" };
    default:
      return { page: "home" };
  }
}

const [route, setRoute] = createSignal<Route>(parseRoute(location.pathname, location.search));
export { route };

window.addEventListener("popstate", () => {
  setRoute(parseRoute(location.pathname, location.search));
  window.scrollTo(0, 0);
});

export function navigate(path: string, opts: { replace?: boolean; keepScroll?: boolean } = {}): void {
  if (path !== location.pathname + location.search) {
    if (opts.replace) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
  }
  setRoute(parseRoute(location.pathname, location.search));
  if (!opts.keepScroll) window.scrollTo(0, 0);
}

/** Click handler of an in-site link: moves without a page load (modifier clicks open a tab as usual). */
export function go(path: string) {
  return (e: MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(path);
  };
}
