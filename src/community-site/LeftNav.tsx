/*
 * The communities, left of the feed (a drawer on narrow screens): all,
 * followed, the themes, the tickers the member follows.
 */
import { For, Show } from "solid-js";
import type { Community } from "../data/community/api";
import { me } from "../data/community/session";
import { communityPath, go, route } from "./router";

export function LeftNav(props: { themes: Community[]; open: boolean; onClose: () => void }) {
  const current = () => {
    const r = route();
    return r.page === "feed" ? r.source : r.page === "about" ? r.community : "";
  };
  const Item = (p: { id: string; label: string; tag?: boolean }) => (
    <a
      class={"cs-nav-item" + (current() === p.id ? " is-current" : "")}
      aria-current={current() === p.id ? "page" : undefined}
      href={communityPath(p.id)}
      onClick={(e) => { props.onClose(); go(communityPath(p.id))(e); }}
    >
      <Show when={p.tag} fallback={p.label}><span class="cs-tag is-small">{p.label}</span></Show>
    </a>
  );
  const tickers = () => me()?.follows.filter((f) => f.kind === "ticker") ?? [];
  return (
    <>
      <Show when={props.open}><div class="cs-scrim" onClick={() => props.onClose()} /></Show>
      <aside class={"cs-nav" + (props.open ? " is-open" : "")} aria-label="Communities">
        <Item id="all" label="All communities" />
        <Show when={me()}><Item id="following" label="Following" /></Show>
        <h2 class="cs-nav-heading">Themes</h2>
        <For each={props.themes}>{(t) => <Item id={t.id} label={t.title} />}</For>
        <Show when={tickers().length}>
          <h2 class="cs-nav-heading">Your tickers</h2>
          <For each={tickers()}>{(t) => <Item id={t.id} label={t.title} tag />}</For>
        </Show>
        <a class="cs-nav-item is-quiet" href="/propose" onClick={(e) => { props.onClose(); go("/propose")(e); }}>Propose a community</a>
      </aside>
    </>
  );
}
