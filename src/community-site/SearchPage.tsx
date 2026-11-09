/*
 * Search: the query box (words, `$NVDA`, `type:post-mortem`,
 * `outcome:stopped`, `by:name`), the facets with their counts (type, the
 * ideas' outcome, when posted, a minimum of "useful" ratings), and the
 * results by usefulness, answered questions first, the words marked.
 */
import { For, Show, createEffect, createResource, createSignal, on } from "solid-js";
import { api, type PostType, type SearchFilters, type SearchView } from "../data/community/api";
import { errorText } from "../community-shared/parts";
import { plain } from "./Home";
import { go, navigate, route } from "./router";
import { SEARCH_ICON, TYPE_LABEL, TYPES, TickerTag, TypeTag, UserLink, age, date, postState } from "./ui";

const OUTCOMES: { id: string; label: string }[] = [
  { id: "target", label: "Target hit" },
  { id: "stopped", label: "Stopped" },
  { id: "expired", label: "Expired" },
  { id: "open", label: "Open" },
];
const POSTED: { id: SearchFilters["posted"]; label: string }[] = [
  { id: "week", label: "Past week" },
  { id: "90d", label: "Past 90 days" },
  { id: "any", label: "Any time" },
];

/** The text in parts, the query's words marked. */
export function marks(text: string, terms: string[]): { t: string; on: boolean }[] {
  const words = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean);
  if (!words.length) return [{ t: text, on: false }];
  // A split on a captured pattern alternates: text, match, text, match…
  return text.split(new RegExp(`(${words.join("|")})`, "gi")).map((t, i) => ({ t, on: i % 2 === 1 })).filter((x) => x.t);
}

const terms = (q: string) => q.split(/\s+/).filter((w) => w && !/^[$@]/.test(w) && !/^(type|outcome|by|ticker):/i.test(w));

export function SearchPage(props: { q: string }) {
  const [q, setQ] = createSignal(props.q);
  const [f, setF] = createSignal<SearchFilters>({ types: [], outcomes: [], posted: "any", minUseful: 0 });
  const [extra, setExtra] = createSignal<SearchView["results"]>([]);
  const [next, setNext] = createSignal<number | null>(null);
  createEffect(on(() => props.q, (v) => setQ(v), { defer: true }));
  const [data] = createResource(() => [props.q, f()] as const, async ([query, filters]) => {
    const r = await api.search(query, filters);
    setExtra([]);
    setNext(r.next_offset);
    return r;
  });
  createEffect(() => { document.title = `${props.q ? `${props.q} · ` : ""}Search · OpenTrader Community`; });
  const submit = (e: Event) => {
    e.preventDefault();
    navigate(`/search?q=${encodeURIComponent(q().trim())}`, { replace: route().page === "search" });
  };
  const toggle = (k: "types" | "outcomes", id: string) =>
    setF((x) => ({ ...x, [k]: x[k].includes(id as never) ? x[k].filter((v) => v !== id) : [...x[k], id] }) as SearchFilters);
  const more = async () => {
    const r = await api.search(props.q, f(), next()!);
    setExtra((l) => [...l, ...r.results]);
    setNext(r.next_offset);
  };
  const view = () => data.latest;
  const results = () => [...(view()?.results ?? []), ...extra()];
  const Facet = (fp: { on: boolean; label: string; n: number | undefined; onClick: () => void }) => (
    <button type="button" class="cs-facet" aria-pressed={fp.on} onClick={() => fp.onClick()}>
      <span class={"cs-box" + (fp.on ? " is-picked" : "")} />
      <span>{fp.label}</span>
      <span class="cs-fog">{fp.n ?? 0}</span>
    </button>
  );
  return (
    <>
      <div class="cs-searchhead">
        <form class="cs-bigsearch" role="search" onSubmit={submit}>
          <span class="cs-bigsearch-icon">{SEARCH_ICON(24, 2.2)}</span>
          <input value={q()} placeholder="Search posts, tickers, people" aria-label="Search" onInput={(e) => setQ(e.currentTarget.value)} ref={(el) => setTimeout(() => !props.q && el.focus())} />
        </form>
        <div class="cs-note">Try <code>$NVDA type:post-mortem</code> or <code>outcome:stopped</code> · <code>by:name</code> for one trader's posts</div>
      </div>
      <div class="cs-grid is-search">
        <aside class="cs-left is-search">
          <div>
            <div class="cs-label is-ruled">Type</div>
            <For each={TYPES}>{(t) => <Facet on={f().types.includes(t)} label={TYPE_LABEL[t]} n={view()?.facets.type[t as PostType]} onClick={() => toggle("types", t)} />}</For>
          </div>
          <div>
            <div class="cs-label is-ruled">Outcome (ideas)</div>
            <For each={OUTCOMES}>{(o) => <Facet on={f().outcomes.includes(o.id)} label={o.label} n={view()?.facets.outcome[o.id as "open"]} onClick={() => toggle("outcomes", o.id)} />}</For>
          </div>
          <div>
            <div class="cs-label is-ruled">Posted</div>
            <For each={POSTED}>{(p) => <Facet on={f().posted === p.id} label={p.label} n={view()?.facets.posted[p.id]} onClick={() => setF((x) => ({ ...x, posted: p.id }))} />}</For>
          </div>
          <div class="cs-field">
            <label for="cs-min-useful">Minimum "useful" ratings</label>
            <input id="cs-min-useful" class="cs-input" inputMode="numeric" value={f().minUseful || ""} placeholder="0"
              onChange={(e) => setF((x) => ({ ...x, minUseful: Math.max(0, Number(e.currentTarget.value) || 0) }))} />
          </div>
        </aside>
        <main id="cs-main" class="cs-center is-wide">
          <div class="cs-head is-strong is-sub">
            <h4>{view()?.total ?? 0} post{view()?.total === 1 ? "" : "s"}</h4>
            <span class="cs-fog cs-small">Sorted by usefulness · answered questions first</span>
          </div>
          <Show when={data.error}><p class="cs-error">{errorText(data.error)}</p></Show>
          <For each={results()} fallback={<Show when={!data.loading}><p class="cs-note">Nothing found. Fewer words, or another facet?</p></Show>}>
            {(r) => {
              const st = () => postState(r);
              return (
                <div class="cs-result">
                  <div class="cs-result-main">
                    <div class="cs-meta">
                      <TypeTag type={r.type} />
                      <TickerTag id={r.community.id} />
                      <span><UserLink name={r.author} /> · {Date.now() / 1000 - r.created_at < 30 * 86_400 ? age(r.created_at) : date(r.created_at)}</span>
                    </div>
                    <a class="cs-result-t" href={`/p/${r.id}`} onClick={go(`/p/${r.id}`)}>{r.title}</a>
                    <p class="cs-item-ex">
                      <For each={marks(plain(r.snippet), terms(props.q))}>{(m) => (m.on ? <mark>{m.t}</mark> : <>{m.t}</>)}</For>
                    </p>
                  </div>
                  <div class="cs-result-side">
                    <span><strong>{r.useful_count}</strong> useful</span>
                    <span class="cs-fog">{r.comment_count} {r.comment_count === 1 ? "reply" : "replies"}</span>
                    <Show when={st()}><span class="cs-strong" style={{ color: st()!.color }}>{st()!.text}</span></Show>
                  </div>
                </div>
              );
            }}
          </For>
          <Show when={next() !== null}><button type="button" class="cs-more" onClick={more}>More results</button></Show>
        </main>
      </div>
    </>
  );
}
