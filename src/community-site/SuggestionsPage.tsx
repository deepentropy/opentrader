/*
 * Suggestions: members ask for features in OpenTrader without a GitHub
 * account. The list (open ones by default, most supported first) with its
 * statuses on the left; "I need this too" on each; and the form, which shows
 * the suggestions that look the same as the title is typed, to support one
 * instead of posting it twice. A suggestion opens as a post (PostPage), with
 * its status, its GitHub issue and the administrators' tools.
 */
import { For, Show, createEffect, createResource, createSignal, on, onCleanup } from "solid-js";
import { api, type Post, type SuggestionFilter, type SuggestionsView } from "../data/community/api";
import { withPostingCheck } from "../data/community/posting-check";
import { me, ready } from "../data/community/session";
import { ErrorBanner, PostingCheckPrompt, errorText } from "../window/right-rail/community/parts";
import { plain } from "./Home";
import { go, navigate } from "./router";
import { Pills, STATUS_LABEL, StatusTag, UserLink, age, signInPath } from "./ui";

const FILTERS: { id: SuggestionFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "review", label: STATUS_LABEL.review },
  { id: "planned", label: STATUS_LABEL.planned },
  { id: "progress", label: STATUS_LABEL.progress },
  { id: "shipped", label: STATUS_LABEL.shipped },
  { id: "declined", label: STATUS_LABEL.declined },
  { id: "all", label: "All" },
];

/** Who asked: the member, or the person who opened the GitHub issue. */
export function SuggestedBy(props: { post: Post }) {
  const gh = () => props.post.suggestion?.external_author;
  return (
    <Show when={gh()} fallback={<UserLink name={props.post.author} />}>
      <a class="cs-user" href={`https://github.com/${encodeURIComponent(gh()!)}`} target="_blank" rel="noopener">{gh()}</a>
      <span class="cs-fog">on GitHub</span>
    </Show>
  );
}

/** The supporters' count, and the viewer's "I need this too". */
export function SupportButton(props: { count: number; on: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      class={"cs-support" + (props.on ? " is-on" : "")}
      aria-pressed={props.on}
      disabled={props.disabled}
      title={props.on ? "You support this. Click to withdraw." : "I need this too"}
      onClick={() => props.onToggle()}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
      <strong>{props.count}</strong>
      <span class="cs-support-l">{props.on ? "Supported" : "Support"}</span>
    </button>
  );
}

function SuggestionItem(props: { post: Post; supported: boolean; onToggle: () => void }) {
  const p = () => props.post;
  const s = () => p().suggestion!;
  return (
    <article class="cs-sg-item">
      <SupportButton count={p().useful_count} on={props.supported} disabled={s().status === "shipped"} onToggle={props.onToggle} />
      <div class="cs-item-main">
        <div class="cs-meta">
          <StatusTag status={s().status} />
          <Show when={s().issue_url}><a href={s().issue_url!} target="_blank" rel="noopener">#{s().issue_number}</a></Show>
          <span>·</span>
          <SuggestedBy post={p()} />
          <span>·</span>
          <span>{age(p().created_at)}</span>
        </div>
        <h4 class="cs-item-title"><a href={`/p/${p().id}`} onClick={go(`/p/${p().id}`)}>{p().title}</a></h4>
        <Show when={p().excerpt}><p class="cs-item-ex">{plain(p().excerpt)}</p></Show>
        <div class="cs-item-foot">
          <a class="cs-replies" href={`/p/${p().id}`} onClick={go(`/p/${p().id}`)}>
            {p().comment_count} {p().comment_count === 1 ? "reply" : "replies"}
          </a>
          <Show when={s().note}><span class="cs-fog">{s().note}</span></Show>
        </div>
      </div>
    </article>
  );
}

/** Support on or off from a list; signed out: the sign-in page. */
async function toggleSupport(p: Post, supported: string[], setSupported: (ids: string[]) => void, setCount: (n: number) => void): Promise<void> {
  if (!me()) return navigate(signInPath());
  const on = !supported.includes(p.id);
  const r = await api.support(p.id, on);
  setSupported(on ? [...supported, p.id] : supported.filter((x) => x !== p.id));
  setCount(r.supporters);
}

export function SuggestionsPage() {
  const params = new URLSearchParams(location.search);
  const [filter, setFilter] = createSignal<SuggestionFilter>((params.get("status") as SuggestionFilter | null) ?? "open");
  const [sort, setSort] = createSignal<"top" | "new">(params.get("sort") === "new" ? "new" : "top");
  const [q, setQ] = createSignal(params.get("q") ?? "");
  const [query, setQuery] = createSignal(q());
  const [error, setError] = createSignal<string | null>(null);
  const [view, setView] = createSignal<SuggestionsView | null>(null);
  const [more, setMore] = createSignal(false);
  const [issue, setIssue] = createSignal("");
  const admin = () => me()?.user.role === "admin";

  const [data] = createResource(
    () => (ready() ? [filter(), sort(), query(), me()?.user.name ?? ""] as const : null),
    ([f, s, text]) => api.suggestions(f, s, text),
  );
  createEffect(on(() => data.latest, (d) => d && setView(d)));
  // The address keeps the filter, the order and the search.
  createEffect(() => {
    const qs = new URLSearchParams();
    if (filter() !== "open") qs.set("status", filter());
    if (sort() !== "top") qs.set("sort", sort());
    if (query()) qs.set("q", query());
    const path = `/suggestions${qs.toString() ? `?${qs}` : ""}`;
    if (path !== location.pathname + location.search) history.replaceState(null, "", path);
  });
  let typing: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(typing));
  const onSearch = (v: string) => {
    setQ(v);
    clearTimeout(typing);
    typing = setTimeout(() => setQuery(v.trim()), 300);
  };

  const toggle = (p: Post) =>
    toggleSupport(p, view()!.supported, (ids) => setView((v) => v && { ...v, supported: ids }), (n) =>
      setView((v) => v && { ...v, suggestions: v.suggestions.map((x) => (x.id === p.id ? { ...x, useful_count: n } : x)) }),
    ).catch((e) => setError(errorText(e)));

  const loadMore = async () => {
    const v = view();
    if (!v?.next_offset) return;
    setMore(true);
    try {
      const next = await api.suggestions(filter(), sort(), query(), v.next_offset);
      setView({ ...next, suggestions: [...v.suggestions, ...next.suggestions], supported: [...v.supported, ...next.supported] });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setMore(false);
    }
  };

  const importIssue = async (e: Event) => {
    e.preventDefault();
    const n = Number(issue().replace(/^#/, ""));
    if (!n) return;
    setError(null);
    try {
      const { post } = await api.importIssue(n);
      setIssue("");
      navigate(`/p/${post.id}`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div class="cs-grid is-search">
      <aside class="cs-left is-search">
        <section>
          <div class="cs-label is-ruled">Status</div>
          <For each={FILTERS}>
            {(f) => (
              <button type="button" class={"cs-filter" + (filter() === f.id ? " is-on" : "")} aria-pressed={filter() === f.id} onClick={() => setFilter(f.id)}>
                <span>{f.label}</span>
                <span>{view()?.counts[f.id] ?? 0}</span>
              </button>
            )}
          </For>
        </section>
        <section>
          <div class="cs-label is-ruled">How it works</div>
          <p class="cs-note">
            Suggest a feature or an improvement, or support one that is already here: the most supported are looked at first. Accepted suggestions get a
            GitHub issue, and you hear when their status changes. No GitHub account needed.
          </p>
        </section>
        <Show when={admin()}>
          <section>
            <div class="cs-label is-ruled">Bring in a GitHub issue</div>
            <form class="cs-row" onSubmit={importIssue}>
              <input class="cs-input cs-sg-issue" inputmode="numeric" placeholder="#266" aria-label="GitHub issue number" value={issue()} onInput={(e) => setIssue(e.currentTarget.value)} />
              <button type="submit" class="cs-btn" disabled={!issue().trim()}>Import</button>
            </form>
          </section>
        </Show>
      </aside>

      <main id="cs-main" class="cs-center is-wide">
        <div class="cs-head is-strong">
          <div>
            <div class="cs-label">Make OpenTrader better</div>
            <h2>Suggestions</h2>
          </div>
          <a class="cs-btn is-primary" href="/suggestions/new" onClick={go("/suggestions/new")}>Suggest a feature</a>
        </div>
        <div class="cs-sg-tools">
          <input class="cs-input" type="search" placeholder="Search suggestions" aria-label="Search suggestions" value={q()} onInput={(e) => onSearch(e.currentTarget.value)} />
          <Pills items={[{ id: "top", label: "Most supported" }, { id: "new", label: "Newest" }]} value={sort()} onChange={setSort} label="Sort" />
        </div>
        <ErrorBanner text={error() ?? (data.error ? errorText(data.error) : null)} onClose={() => setError(null)} />
        <Show when={view()} fallback={<p class="cs-loading">Loading…</p>}>
          <For
            each={view()!.suggestions}
            fallback={<p class="cs-note cs-sg-empty">{query() ? "No suggestion matches. Suggest it!" : "Nothing here yet."}</p>}
          >
            {(p) => <SuggestionItem post={p} supported={view()!.supported.includes(p.id)} onToggle={() => void toggle(p)} />}
          </For>
          <Show when={view()!.next_offset}>
            <button type="button" class="cs-more" disabled={more()} onClick={() => void loadMore()}>{more() ? "Loading…" : "More suggestions"}</button>
          </Show>
        </Show>
      </main>
    </div>
  );
}

/** The form: a title, the details, and the look-alikes to support instead. */
export function SuggestCompose() {
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [words, setWords] = createSignal("");
  const [supported, setSupported] = createSignal<string[]>([]);
  let typing: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(typing));
  const onTitle = (v: string) => {
    setTitle(v);
    clearTimeout(typing);
    // The title's longer words, each a separate match: "import csv data" finds "CSV import".
    typing = setTimeout(() => setWords(v.split(/\s+/).filter((w) => w.length > 3).slice(0, 4).join(" ")), 400);
  };
  const [similar, { mutate }] = createResource(words, async (w) => {
    if (!w) return [] as Post[];
    const words = w.split(" ");
    const lists = await Promise.all(words.map((x) => api.suggestions("all", "top", x).catch(() => null)));
    const seen = new Map<string, { post: Post; hits: number }>();
    lists.forEach((l) => {
      l?.suggestions.forEach((p) => seen.set(p.id, { post: p, hits: (seen.get(p.id)?.hits ?? 0) + 1 }));
      setSupported((s) => [...new Set([...s, ...(l?.supported ?? [])])]);
    });
    return [...seen.values()].filter((x) => x.hits >= Math.min(2, words.length)).sort((a, b) => b.hits - a.hits || b.post.useful_count - a.post.useful_count).slice(0, 5).map((x) => x.post);
  });

  const toggle = (p: Post) =>
    toggleSupport(p, supported(), setSupported, (n) => mutate((l) => l?.map((x) => (x.id === p.id ? { ...x, useful_count: n } : x)))).catch((e) => setError(errorText(e)));

  const submit = async () => {
    if (!me()) return navigate(signInPath());
    setBusy(true);
    setError(null);
    try {
      const { post } = await withPostingCheck(() => api.suggest(title().trim(), body().trim()));
      navigate(`/p/${post.id}`, { replace: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="cs-grid is-compose">
      <main id="cs-main" class="cs-center is-compose">
        <div class="cs-crumbs"><a href="/suggestions" onClick={go("/suggestions")}>Suggestions</a> / New</div>
        <h1 class="cs-post-title">Suggest a feature</h1>
        <div class="cs-field">
          <label for="sg-title">What would you like OpenTrader to do?</label>
          <input id="sg-title" class="cs-input is-strong" maxlength={300} placeholder="e.g. Import bars from a folder of CSV files" value={title()} onInput={(e) => onTitle(e.currentTarget.value)} />
        </div>
        <Show when={(similar() ?? []).length}>
          <div class="cs-sg-similar">
            <div class="cs-label">Already suggested? Support it instead</div>
            <For each={similar()}>
              {(p) => (
                <div class="cs-sg-similar-row">
                  <SupportButton count={p.useful_count} on={supported().includes(p.id)} disabled={p.suggestion?.status === "shipped"} onToggle={() => void toggle(p)} />
                  <a href={`/p/${p.id}`} onClick={go(`/p/${p.id}`)}>{p.title}</a>
                  <Show when={p.suggestion}><StatusTag status={p.suggestion!.status} /></Show>
                </div>
              )}
            </For>
          </div>
        </Show>
        <div class="cs-field">
          <label for="sg-body">Details</label>
          <textarea
            id="sg-body"
            class="cs-textarea is-tall"
            placeholder="What you are trying to do, how you do it today, and what would help. Markdown works."
            value={body()}
            onInput={(e) => setBody(e.currentTarget.value)}
          />
        </div>
        <PostingCheckPrompt />
        <ErrorBanner text={error()} onClose={() => setError(null)} />
        <div class="cs-row">
          <Show when={me()} fallback={<a class="cs-btn is-primary" href={signInPath()} onClick={go(signInPath())}>Sign in to suggest</a>}>
            <button type="button" class="cs-btn is-primary" disabled={busy() || title().trim().length < 3} onClick={() => void submit()}>Post suggestion</button>
          </Show>
          <a class="cs-btn" href="/suggestions" onClick={go("/suggestions")}>Cancel</a>
        </div>
      </main>
      <aside class="cs-right is-compose">
        <section>
          <h5>A good suggestion</h5>
          <p class="cs-note">One feature per suggestion. Say what you want to achieve, not only the button you imagine: there may be a better way to get there.</p>
          <p class="cs-note">Sign in with Google, Discord or GitHub. You hear when its status changes: planned, in progress, shipped.</p>
        </section>
      </aside>
    </div>
  );
}
