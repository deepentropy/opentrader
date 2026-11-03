/*
 * A trader's profile: no followers and no rank, what they posted and how it
 * played out. The record (resolved ideas, hit rate, average and cumulative
 * R, median hold), the cumulative R curve, the outcomes, every idea in a
 * table (losers too), their other posts and replies. Right: why readers
 * found their posts useful, the record by direction, their tickers.
 */
import { For, Show, createEffect, createResource, createSignal } from "solid-js";
import { api, type Post, type PostType, type Profile, type ProfileReply, type Reason } from "../data/community/api";
import { me } from "../data/community/session";
import { errorText } from "../window/right-rail/community/parts";
import { go, navigate } from "./router";
import { Avatar, DOWN, FOG, TickerTag, TypeTag, UP, age, date, fmtR, outcome, price, rColor, signInPath, tickerName } from "./ui";

const REASON_LABEL: Record<Reason, string> = { thesis: "Clear thesis", risk: "Well-defined risk", data: "Good data", view: "Changed my view", vague: "Vague" };

/** The cumulative R after each settled idea, a dot per idea (green won, red lost). */
function Curve(props: { points: Profile["curve"] }) {
  const W = 900, H = 220, PAD = 50;
  const pts = () => [0, ...props.points.map((p) => p.r)];
  const max = () => Math.max(1, ...pts()) * 1.08;
  const min = () => Math.min(0, ...pts()) - 1;
  const X = (i: number) => (pts().length > 1 ? (i / (pts().length - 1)) * (W - PAD) : 0);
  const Y = (v: number) => ((max() - v) / (max() - min())) * (H - 8) + 4;
  const line = () => pts().map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  const step = () => {
    const span = max() - min();
    return span > 40 ? 10 : span > 16 ? 5 : span > 6 ? 2 : 1;
  };
  const grid = () => {
    const out: number[] = [];
    for (let v = Math.ceil(min() / step()) * step(); v <= max(); v += step()) out.push(v);
    return out;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Cumulative result in R" class="cs-curve">
      <For each={grid()}>
        {(v) => (
          <>
            <line x1="0" x2={W - PAD} y1={Y(v)} y2={Y(v)} stroke={v === 0 ? "#3a3d46" : "#1e2026"} stroke-width="1" />
            <text x={W - PAD + 8} y={Y(v) + 4} fill={FOG} font-size="11">{(v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v)}R</text>
          </>
        )}
      </For>
      <path d={`${line()}L${X(pts().length - 1)},${Y(0)}L0,${Y(0)}Z`} fill="rgba(41,98,255,0.12)" />
      <path d={line()} fill="none" stroke="#2962ff" stroke-width="2" />
      <For each={props.points}>{(p, i) => <circle cx={X(i() + 1)} cy={Y(p.r)} r="2.5" fill={p.result > 0 ? UP : DOWN} />}</For>
    </svg>
  );
}

type Tab = PostType | "replies";

function IdeasTable(props: { name: string; total: number }) {
  const [rows, setRows] = createSignal<Post[]>([]);
  const [next, setNext] = createSignal<number | null>(null);
  const load = async (offset: number, limit: number) => {
    const r = await api.userPosts(props.name, "idea", offset, limit);
    setRows((l) => (offset ? [...l, ...r.posts] : r.posts));
    setNext(r.next_offset);
  };
  createEffect(() => void load(0, 8).catch(() => {}));
  return (
    <>
      <table class="cs-table">
        <thead><tr><th>Ticker</th><th>Dir</th><th>Entry</th><th>Stop</th><th>Target</th><th>Posted</th><th>Outcome</th><th class="cs-right-al">Result</th></tr></thead>
        <tbody>
          <For each={rows()}>
            {(p) => (
              <tr class="is-link" onClick={() => navigate(`/p/${p.id}`)}>
                <td><TickerTag id={p.community.id} /></td>
                <td class="cs-strong">{p.idea?.direction === "short" ? "Short" : "Long"}</td>
                <td>{price(p.idea?.entry)}</td>
                <td>{price(p.idea?.stop)}</td>
                <td>{price(p.idea?.target)}</td>
                <td class="cs-fog">{date(p.created_at)}</td>
                <td class="cs-fog">{p.idea ? outcome(p.idea) : ""}</td>
                <td class="cs-right-al cs-strong" style={{ color: p.idea?.status === "open" ? "var(--cs-chalk)" : rColor(p.idea?.result_r) }}>{p.idea?.result_r == null ? "—" : fmtR(p.idea.result_r)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={next() !== null}>
        <button type="button" class="cs-link-btn is-block" onClick={() => load(rows().length, 50)}>Show all {props.total} ideas</button>
      </Show>
    </>
  );
}

function PostsList(props: { name: string; type: PostType }) {
  const [rows] = createResource(() => [props.name, props.type] as const, ([n, t]) => api.userPosts(n, t, 0, 50).then((r) => r.posts));
  return (
    <For each={rows() ?? []} fallback={<p class="cs-note">{rows.loading ? "Loading…" : "None yet."}</p>}>
      {(p) => (
        <a class="cs-disc" href={`/p/${p.id}`} onClick={go(`/p/${p.id}`)}>
          <span><TypeTag type={p.type} /></span>
          <span class="cs-strong">{p.title}</span>
          <span class="cs-fog">{tickerName(p.community.id)} · {age(p.created_at)}</span>
          <span class="cs-right-al"><strong>{p.useful_count}</strong> useful</span>
        </a>
      )}
    </For>
  );
}

function RepliesList(props: { name: string }) {
  const [rows] = createResource(() => props.name, (n) => api.userReplies(n).then((r) => r.replies));
  return (
    <For each={rows() ?? []} fallback={<p class="cs-note">{rows.loading ? "Loading…" : "None yet."}</p>}>
      {(r: ProfileReply) => (
        <a class="cs-ruled-row cs-q" href={`/p/${r.post_id}`} onClick={go(`/p/${r.post_id}`)}>
          <div class="cs-q-m">On “{r.post_title}” · {tickerName(r.community_id)} · {age(r.created_at)} · {r.useful_count} useful</div>
          <div class="cs-reply-text">{r.body}</div>
        </a>
      )}
    </For>
  );
}

export function ProfilePage(props: { name: string }) {
  const [data, { mutate }] = createResource(() => [props.name, me()?.user.name ?? ""] as const, ([n]) => api.profile(n));
  const [tab, setTab] = createSignal<Tab>("idea");
  const [error, setError] = createSignal<string | null>(null);
  createEffect(() => { document.title = `${props.name} · OpenTrader Community`; });
  const watch = async () => {
    const d = data();
    if (!d) return;
    if (!me()) return navigate(signInPath());
    try {
      const r = await api.watch(d.user.name, !d.watching);
      mutate({ ...d, watching: r.watching });
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Show when={!data.error} fallback={<div class="cs-page-msg">{errorText(data.error)}</div>}>
      <Show when={data()} fallback={<p class="cs-loading">Loading…</p>}>
        {(() => {
          const d = () => data()!;
          const r = () => d().record;
          const counts = () => d().counts;
          const settled = () => d().outcomes.target + d().outcomes.stopped + d().outcomes.expired;
          const tabs = (): { id: Tab; label: string }[] => [
            { id: "idea", label: `Ideas ${counts().idea ?? 0}` },
            { id: "analysis", label: `Analysis ${counts().analysis ?? 0}` },
            { id: "postmortem", label: `Post-mortems ${counts().postmortem ?? 0}` },
            ...((counts().question ?? 0) > 0 ? [{ id: "question" as Tab, label: `Questions ${counts().question}` }] : []),
            { id: "replies", label: `Replies ${counts().replies ?? 0}` },
          ];
          const maxReason = () => Math.max(1, ...d().reasons.map((x) => x.n));
          return (
            <>
              <div class="cs-profhead">
                <Avatar name={d().user.name} size={72} />
                <div>
                  <h1>{d().user.name}</h1>
                  <div class="cs-fog">{[d().user.bio, `member since ${date(d().user.created_at)}`].filter(Boolean).join(" · ")}</div>
                </div>
                <div class="cs-row">
                  <Show
                    when={!d().own}
                    fallback={<a class="cs-btn" href="/account" onClick={go("/account")}>Edit profile</a>}
                  >
                    <Show when={!d().user.bot}>
                      <button type="button" class={"cs-btn" + (d().watching ? " is-picked" : "")} aria-pressed={d().watching} onClick={watch}>
                        {d().watching ? "Notifying you of new ideas" : "Notify me of new ideas"}
                      </button>
                    </Show>
                  </Show>
                </div>
              </div>
              <Show when={error()}><p class="cs-error">{error()}</p></Show>
              <div class="cs-grid is-post">
                <main id="cs-main" class="cs-center is-wide cs-stack">
                  <div class="cs-cards">
                    <div><div class="cs-card-l">Resolved ideas</div><div class="cs-card-v">{r().resolved}</div><div class="cs-card-n">{r().open} open</div></div>
                    <div><div class="cs-card-l">Hit target</div><div class="cs-card-v">{r().hit_pct == null ? "—" : `${r().hit_pct}%`}</div><div class="cs-card-n">{r().hits} of {r().resolved}</div></div>
                    <div><div class="cs-card-l">Avg result</div><div class="cs-card-v" style={{ color: rColor(r().avg_r) }}>{r().avg_r == null ? "—" : fmtR(r().avg_r)}</div><div class="cs-card-n">per idea</div></div>
                    <div><div class="cs-card-l">Cumulative</div><div class="cs-card-v" style={{ color: rColor(r().total_r) }}>{r().resolved ? fmtR(r().total_r) : "—"}</div><div class="cs-card-n">{d().first_resolved_at ? `since ${date(d().first_resolved_at!)}` : "no idea settled yet"}</div></div>
                    <div><div class="cs-card-l">Median hold</div><div class="cs-card-v">{d().median_hold_days == null ? "—" : `${d().median_hold_days} day${d().median_hold_days === 1 ? "" : "s"}`}</div><div class="cs-card-n">triggered to resolved</div></div>
                  </div>
                  <div>
                    <div class="cs-head is-sub is-plain">
                      <h4>Cumulative result, in R</h4>
                      <span class="cs-fog cs-small">{r().resolved} resolved idea{r().resolved === 1 ? "" : "s"}{d().first_resolved_at ? ` since ${date(d().first_resolved_at!)}` : ""} · open ideas excluded</span>
                    </div>
                    <Show when={d().curve.length} fallback={<p class="cs-note">The curve starts with the first settled idea.</p>}>
                      <div class="cs-curvebox"><Curve points={d().curve} /></div>
                      <div class="cs-outbar">
                        <Show when={d().outcomes.target}><div style={{ flex: d().outcomes.target, background: UP }} /></Show>
                        <Show when={d().outcomes.stopped}><div style={{ flex: d().outcomes.stopped, background: DOWN }} /></Show>
                        <Show when={d().outcomes.expired}><div style={{ flex: d().outcomes.expired, background: "#3a3d46" }} /></Show>
                      </div>
                      <div class="cs-outlegend">
                        <span><strong>{d().outcomes.target}</strong> target hit</span>
                        <span><strong>{d().outcomes.stopped}</strong> stopped</span>
                        <span><strong>{d().outcomes.expired}</strong> expired</span>
                        <Show when={settled() !== r().resolved}><span>{r().resolved} resolved</span></Show>
                      </div>
                    </Show>
                  </div>
                  <div>
                    <div class="cs-tabs">
                      <For each={tabs()}>
                        {(t) => <button type="button" class={tab() === t.id ? "is-on" : ""} aria-pressed={tab() === t.id} onClick={() => setTab(t.id)}>{t.label}</button>}
                      </For>
                      <span class="cs-fog cs-small cs-push">All ideas are listed, including losers</span>
                    </div>
                    <Show when={tab() === "idea"}><IdeasTable name={d().user.name} total={counts().idea ?? 0} /></Show>
                    <Show when={tab() !== "idea" && tab() !== "replies"}><PostsList name={d().user.name} type={tab() as PostType} /></Show>
                    <Show when={tab() === "replies"}><RepliesList name={d().user.name} /></Show>
                  </div>
                </main>
                <aside class="cs-right is-post">
                  <section>
                    <h5>What readers found useful</h5>
                    <div class="cs-note">Reasons given on {d().user.name}'s posts</div>
                    <For each={d().reasons}>
                      {(v) => (
                        <div class="cs-reason">
                          <div class="cs-reason-top"><span>{REASON_LABEL[v.reason]}</span><span class="cs-fog">{v.n}</span></div>
                          <div class="cs-reason-bar"><div style={{ width: `${Math.round((v.n / maxReason()) * 100)}%` }} /></div>
                        </div>
                      )}
                    </For>
                  </section>
                  <section>
                    <h5>By direction</h5>
                    <For each={d().by_direction} fallback={<div class="cs-ruled-row cs-fog">No idea yet.</div>}>
                      {(x) => (
                        <div class="cs-dir">
                          <span class="cs-strong">{x.direction === "long" ? "Long" : "Short"}</span>
                          <span class="cs-fog">{x.resolved} idea{x.resolved === 1 ? "" : "s"} · {x.hit_pct == null ? "—" : `${x.hit_pct}%`} hit</span>
                          <span class="cs-strong" style={{ color: rColor(x.avg_r) }}>{x.avg_r == null ? "—" : fmtR(x.avg_r)}</span>
                        </div>
                      )}
                    </For>
                  </section>
                  <section>
                    <h5>Posts most often about</h5>
                    <div class="cs-tkcloud">
                      <For each={d().tickers} fallback={<span class="cs-fog">No ticker yet.</span>}>
                        {(t) => <span class="cs-fog"><TickerTag id={`t:${t.ticker}`} /> {t.n}</span>}
                      </For>
                    </div>
                  </section>
                  <section class="cs-quiet">Profiles have no followers and no rank. They show what a trader has posted and how it played out.</section>
                </aside>
              </div>
            </>
          );
        })()}
      </Show>
    </Show>
  );
}
