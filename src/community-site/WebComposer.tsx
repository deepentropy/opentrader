/*
 * New post on the website: community, title, text. A chart is attached from
 * the app (the website has no chart to picture).
 */
import { For, Show, createResource, createSignal } from "solid-js";
import { api, tickerCommunityId, type Community } from "../data/community/api";
import { me } from "../data/community/session";
import { withPostingCheck } from "../data/community/posting-check";
import { ErrorBanner, ExternalLink, PostingCheckPrompt, RULES_URL, errorText } from "../window/right-rail/community/parts";
import { go, navigate } from "./router";

export function WebComposer(props: { community: string | null; themes: Community[] }) {
  const [target, setTarget] = createSignal(props.community ?? props.themes[0]?.id ?? "c:general");
  const [ticker, setTicker] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [current] = createResource(
    () => (props.community?.startsWith("t:") ? props.community : null),
    (id) => api.community(id).then((r) => r.community).catch(() => null),
  );
  const choices = () => {
    const list: { id: string; title: string }[] = [];
    const add = (id: string, t: string) => !list.some((x) => x.id === id) && list.push({ id, title: t });
    if (current()) add(current()!.id, current()!.title);
    for (const f of me()?.follows ?? []) add(f.id, f.title);
    for (const t of props.themes) add(t.id, t.title);
    add("ticker", "Another ticker…");
    return list;
  };
  const destination = () => (target() === "ticker" ? tickerCommunityId(ticker().replace(/^\$/, "")) : target());
  const send = async () => {
    const to = destination();
    if (!to) return setError("Type a ticker, like AAPL.");
    setBusy(true);
    setError(null);
    try {
      const r = await withPostingCheck(() => api.createPost(to, title(), body()));
      navigate(`/p/${r.post.id}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="cs-page">
      <h1 class="cs-feed-h1">New post</h1>
      <Show
        when={me()}
        fallback={
          <div class="cs-empty">
            <p>Sign in to write a post.</p>
            <a class="cs-btn is-primary" href={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`} onClick={go(`/signin?next=${encodeURIComponent(location.pathname + location.search)}`)}>Sign in</a>
          </div>
        }
      >
        <PostingCheckPrompt />
        <div class="cs-form">
          <label for="cs-to">Community</label>
          <select id="cs-to" value={target()} onChange={(e) => setTarget(e.currentTarget.value)}>
            <For each={choices()}>{(c) => <option value={c.id}>{c.title}</option>}</For>
          </select>
          <Show when={target() === "ticker"}>
            <input aria-label="Ticker" placeholder="Ticker, like AAPL" maxLength={16} value={ticker()} onInput={(e) => setTicker(e.currentTarget.value.toUpperCase())} />
          </Show>
          <label for="cs-title">Title</label>
          <input id="cs-title" maxLength={300} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
          <label for="cs-body">Text</label>
          <textarea id="cs-body" rows={10} maxLength={20000} value={body()} onInput={(e) => setBody(e.currentTarget.value)} />
          <p class="cs-hint">Formatting: **bold**, *italic*, [link](https://…), lists with -, quotes with &gt;. $AAPL becomes a link to its community.</p>
          <p class="cs-hint">To share a chart with its drawings, post from the OpenTrader app: "Attach my chart" in its Community panel.</p>
          <ErrorBanner text={error()} />
          <div class="cs-form-actions">
            <button type="button" class="cs-btn" onClick={() => history.back()}>Cancel</button>
            <button type="button" class="cs-btn is-primary" disabled={busy() || title().trim().length < 3} onClick={send}>Post</button>
          </div>
          <p class="cs-hint">Posts are members' opinions, not financial advice. Promotion and coordinated buying are removed: read the <ExternalLink href={RULES_URL}>community rules</ExternalLink>.</p>
        </div>
      </Show>
    </section>
  );
}
