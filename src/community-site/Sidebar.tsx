/*
 * Right of the feed: the community's card (moderators, About and log), the
 * rules in short, and the charting app (where shared charts open).
 */
import { For, Show, createResource } from "solid-js";
import { api } from "../data/community/api";
import { communityPath, go } from "./router";

const APP_URL = "https://opentrader.markets";

export function Sidebar(props: { community: string | null; popular: { id: string; title: string; post_count: number }[] }) {
  const single = () => !!props.community && (props.community.startsWith("t:") || props.community.startsWith("c:"));
  const [mods] = createResource(
    () => (single() ? props.community : null),
    (id) => api.moderators(id).then((r) => r.moderators).catch(() => [] as string[]),
  );
  const about = () => `${communityPath(props.community!)}/about`;
  return (
    <aside class="cs-side" aria-label="About">
      <Show
        when={single()}
        fallback={
          <section class="cs-side-card">
            <h2>Popular tickers</h2>
            <Show
              when={props.popular.length}
              fallback={<p>Every symbol has its own community. Go to any ticker with the search box, or follow the ones you trade.</p>}
            >
              <ul class="cs-popular">
                <For each={props.popular.slice(0, 8)}>
                  {(t) => (
                    <li>
                      <a class="cs-tag is-small" href={communityPath(t.id)} onClick={go(communityPath(t.id))}>{t.title}</a>
                      <span>{t.post_count} post{t.post_count === 1 ? "" : "s"}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        }
      >
        <section class="cs-side-card">
          <h2>Moderators</h2>
          <Show when={(mods() ?? []).length} fallback={<p>The administrators moderate this community.</p>}>
            <ul class="cs-plain-list">
              <For each={mods()}>{(m) => <li>{m}</li>}</For>
            </ul>
          </Show>
          <a href={about()} onClick={go(about())}>About and moderation log</a>
        </section>
      </Show>
      <section class="cs-side-card">
        <h2>The rules in short</h2>
        <ol class="cs-rules">
          <li>No pump and dump or coordinated buying.</li>
          <li>Say when you hold what you recommend.</li>
          <li>No promotion, referral links or paid signals.</li>
          <li>Respect people. Opinions, not advice.</li>
        </ol>
        <a href={`${APP_URL}/community-rules.html`}>Read the community rules</a>
      </section>
      <section class="cs-side-card is-app">
        <h2>Charts open in the app</h2>
        <p>Posts with a chart open in OpenTrader with their symbol, timeframe and drawings, in one click. The app is free and open source.</p>
        <a class="cs-btn is-primary" href={`${APP_URL}/download.html`}>Get OpenTrader</a>
      </section>
    </aside>
  );
}
