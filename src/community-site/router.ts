/*
 * The website's addresses and moves between them (history API).
 *
 *   /                      all communities      /following          followed ones
 *   /t/AAPL, /c/options    a community          /t/AAPL/about       its moderators and log
 *   /p/<id>                a post               /submit?to=<id>     new post
 *   /notifications, /account, /mod (moderation queue), /propose, /contact, /signin?next=
 */
import { createSignal } from "solid-js";

export type Route =
  | { page: "feed"; source: string }
  | { page: "post"; id: string }
  | { page: "about"; community: string }
  | { page: "submit"; community: string | null }
  | { page: "notifications" }
  | { page: "account" }
  | { page: "queue" }
  | { page: "propose" }
  | { page: "contact" }
  | { page: "signin"; next: string };

/** A community id (`t:AAPL`, `c:options`) as its address segment. */
export function communityPath(id: string): string {
  if (id.startsWith("t:")) return `/t/${encodeURIComponent(id.slice(2))}`;
  if (id.startsWith("c:")) return `/c/${encodeURIComponent(id.slice(2))}`;
  return id === "following" ? "/following" : "/";
}

export function parseRoute(path: string, search: string): Route {
  const q = new URLSearchParams(search);
  const parts = path.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  const [a, b, c] = parts;
  if ((a === "t" || a === "c") && b) {
    const id = a === "t" ? `t:${b.toUpperCase()}` : `c:${b.toLowerCase()}`;
    return c === "about" ? { page: "about", community: id } : { page: "feed", source: id };
  }
  switch (a) {
    case "p":
      return b ? { page: "post", id: b } : { page: "feed", source: "all" };
    case "following":
      return { page: "feed", source: "following" };
    case "submit":
      return { page: "submit", community: q.get("to") };
    case "notifications":
    case "account":
    case "propose":
    case "contact":
      return { page: a };
    case "mod":
      return { page: "queue" };
    case "signin":
      return { page: "signin", next: q.get("next") || "/" };
    default:
      return { page: "feed", source: "all" };
  }
}

const [route, setRoute] = createSignal<Route>(parseRoute(location.pathname, location.search));
export { route };

window.addEventListener("popstate", () => {
  setRoute(parseRoute(location.pathname, location.search));
  window.scrollTo(0, 0);
});

export function navigate(path: string): void {
  if (path !== location.pathname + location.search) history.pushState(null, "", path);
  setRoute(parseRoute(location.pathname, location.search));
  window.scrollTo(0, 0);
}

/** Click handler of an in-site link: moves without a page load (modifier clicks open a tab as usual). */
export function go(path: string) {
  return (e: MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(path);
  };
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date (dd/mm/yyyy). */
export function ago(sec: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor(nowMs / 1000) - sec);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86_400) {
    const d = Math.floor(s / 86_400);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  const dt = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `on ${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear()}`;
}
