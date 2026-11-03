/*
 * A post: its type, ticker and author's record; an idea's locked levels and
 * where it stands; the chart snapshot; the text; "Was this useful? Say why.";
 * the replies (each with its kind and snapshot, the answers under it, the
 * author's marked "Author"), and the reply box. Right: an idea's log, the
 * author's last ideas, more on the ticker. Comments arrive live.
 */
import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { COMMUNITY_URL, api, imageUrl, type Comment, type Idea, type Post, type Ratings, type Reason, type ReplyKind } from "../data/community/api";
import { withPostingCheck } from "../data/community/posting-check";
import { me } from "../data/community/session";
import { showConfirm } from "../components/Dialogs";
import { BanForm, ErrorBanner, MarkdownBody, PostingCheckPrompt, ReasonForm, ReportForm, errorText } from "../window/right-rail/community/parts";
import { SnapshotPicker } from "./SnapshotPicker";
import { go, navigate } from "./router";
import {
  Avatar, DirTag, FOG, Pills, TYPE_LABEL, TickerTag, TypeTag, UserLink, age, communityHref, date, dateTime, day, fmtPct, fmtR, ideaState, outcome, price, rColor, recordLine, recordLong, signInPath, tfLong, tfShort, tickerName,
} from "./ui";

const APP_URL = "https://opentrader.markets/download.html";

const REASONS: { id: Reason; label: string }[] = [
  { id: "thesis", label: "Clear thesis" },
  { id: "data", label: "Good data" },
  { id: "view", label: "Changed my view" },
  { id: "risk", label: "Well-defined risk" },
  { id: "vague", label: "Not useful: vague" },
];

const KINDS: { id: ReplyKind; label: string }[] = [
  { id: "data", label: "Data" },
  { id: "counterpoint", label: "Counterpoint" },
  { id: "question", label: "Question" },
];
const KIND_LABEL: Record<ReplyKind, string> = { data: "Data", counterpoint: "Counterpoint", question: "Question", update: "Update" };

/** "daily close > 148.20", "trade < 52.00": what triggers the entry. */
export function triggerText(i: Idea): string {
  const side = i.ref_price < i.entry ? ">" : "<";
  return `${i.entry_rule === "close" ? "daily close" : "a trade"} ${side} ${price(i.entry)}`;
}

/** The idea's log: posted, triggered, now or how it ended, the last day. */
function ideaLog(p: Post): { d: string; e: string }[] {
  const i = p.idea!;
  const rows = [{ d: dateTime(p.created_at), e: `Posted. Trigger: ${triggerText(i)}` }];
  if (i.triggered_at) rows.push({ d: dateTime(i.triggered_at), e: i.entry_rule === "close" ? `Triggered — close ${price(i.trigger_price)}` : `Triggered at ${price(i.trigger_price)}` });
  if (i.status === "open" || i.status === "pending") {
    if (i.last_price != null) rows.push({ d: "Now", e: `Last ${price(i.last_price)}${i.status === "open" ? ` · ${fmtR(i.result_r)}` : ""}` });
    rows.push({ d: day(i.expires), e: i.status === "open" ? "Expires if neither level is hit" : "Expires if never triggered" });
  } else if (i.resolved_at) {
    const how = { target: `Target hit at ${price(i.exit_price)}`, stopped: `Stopped at ${price(i.exit_price)}`, expired: `Expired at the close, ${price(i.exit_price)}`, untriggered: "Expired, never triggered" }[i.status as "target"];
    rows.push({ d: dateTime(i.resolved_at), e: `${how}${i.result_r != null ? ` · ${fmtR(i.result_r)}` : ""}` });
  }
  return rows;
}

type Open = { id: string; kind: "reply" | "edit" | "report" | "remove" | "appeal" | "ban" } | null;

export function PostPage(props: { id: string }) {
  const [data, { refetch }] = createResource(() => [props.id, me()?.user.name ?? ""] as const, ([id]) => api.post(id));
  const [post, setPost] = createStore<{ p: Post | null }>({ p: null });
  const [comments, setComments] = createStore<{ list: Comment[] }>({ list: [] });
  const [ratings, setRatings] = createSignal<Ratings>({ reasons: {}, mine: [] });
  const [isMod, setIsMod] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal<Open>(null);
  const [draft, setDraft] = createSignal("");
  const [kind, setKind] = createSignal<ReplyKind | null>(null);
  const [snap, setSnap] = createSignal<string | null>(null);
  const [picking, setPicking] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [sort, setSort] = createSignal<"useful" | "oldest">("useful");
  // "Open in OpenTrader" (#233): the browser hands opentrader:// to the app; a page that keeps the focus means none answered.
  const [noApp, setNoApp] = createSignal(false);
  const openInApp = () => {
    setNoApp(false);
    let left = false;
    const away = () => (left = true);
    window.addEventListener("blur", away, { once: true });
    setTimeout(() => {
      window.removeEventListener("blur", away);
      if (!left && !document.hidden) setNoApp(true);
    }, 1800);
  };

  createMemo(() => {
    const d = data();
    if (!d) return;
    setPost("p", d.post);
    setComments("list", d.comments);
    setRatings(d.ratings);
    setIsMod(d.is_mod);
    document.title = `${d.post.title} · ${tickerName(d.post.community.id)} · OpenTrader Community`;
  });

  // Live replies: the post's room passes on each new one; a lost connection comes back after a pause.
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const connect = (postId: string, delay = 2000) => {
    socket?.close();
    try {
      const base = COMMUNITY_URL ? COMMUNITY_URL.replace(/^http/, "ws") : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
      socket = new WebSocket(`${base}/posts/${encodeURIComponent(postId)}/live`);
    } catch {
      return;
    }
    socket.onmessage = (e) => {
      let m: { type?: string; comment?: Comment };
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const c = m.comment;
      if (m.type !== "comment" || !c || comments.list.some((x) => x.id === c.id)) return;
      setComments("list", (l) => [...l, c]);
      setPost("p", produce((x) => { if (x) x.comment_count += 1; }));
    };
    socket.onclose = () => {
      if (!closed) retry = setTimeout(() => connect(postId, Math.min(delay * 2, 60_000)), delay);
    };
  };
  createEffect(on(() => props.id, (id) => connect(id)));
  onCleanup(() => {
    closed = true;
    if (retry) clearTimeout(retry);
    socket?.close();
  });

  const [authorIdeas] = createResource(
    () => (post.p?.author && !post.p.author_bot ? [post.p.author, post.p.id] as const : null),
    ([name, id]) => api.userPosts(name, "idea", 0, 6).then((r) => r.posts.filter((x) => x.id !== id).slice(0, 5)).catch(() => [] as Post[]),
  );
  const [related] = createResource(
    () => (post.p ? [post.p.community.id, post.p.id] as const : null),
    ([c, id]) => api.posts(c, "new", 0).then((r) => r.posts.filter((x) => x.id !== id).slice(0, 3)).catch(() => [] as Post[]),
  );

  // Replies: the top ones sorted, each with all its answers under it (oldest first).
  const tops = createMemo(() => {
    const top = comments.list.filter((c) => !c.parent_id);
    return sort() === "useful" ? [...top].sort((a, b) => b.useful_count - a.useful_count || a.created_at - b.created_at) : top;
  });
  const under = createMemo(() => {
    const byId = new Map(comments.list.map((c) => [c.id, c]));
    const rootOf = (c: Comment): string => {
      let x = c;
      while (x.parent_id && byId.has(x.parent_id)) x = byId.get(x.parent_id)!;
      return x.id;
    };
    const map = new Map<string, Comment[]>();
    for (const c of comments.list) {
      if (!c.parent_id) continue;
      const r = rootOf(c);
      map.set(r, [...(map.get(r) ?? []), c]);
    }
    return map;
  });

  const needUser = (fn: () => void) => () => (me() ? fn() : navigate(signInPath()));
  const toggle = (id: string, k: NonNullable<Open>["kind"]) => {
    setOpen((o) => (o?.id === id && o.kind === k ? null : { id, kind: k }));
  };

  const rate = async (reason: Reason) => {
    const p = post.p;
    if (!p) return;
    if (!me()) return navigate(signInPath());
    setError(null);
    try {
      const r = await api.rate(p.id, reason, !ratings().mine.includes(reason));
      setRatings({ reasons: r.reasons, mine: r.mine });
      setPost("p", produce((x) => { if (x) { x.useful_count = r.useful_count; x.flag_count = r.flag_count; } }));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const useful = async (c: Comment) => {
    if (!me()) return navigate(signInPath());
    try {
      const r = await api.useful(c.id, !c.my_useful);
      setComments("list", (x) => x.id === c.id, produce((x) => { x.useful_count = r.useful_count; x.my_useful = r.my_useful; }));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const send = async (parentId: string | null, text: string) => {
    const p = post.p;
    if (!p || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const attach = parentId ? null : snap() ? { snapshotId: snap()! } : null;
      const k = parentId ? null : p.own ? "update" : kind();
      const { comment } = await withPostingCheck(() => api.comment(p.id, text, parentId, k, attach));
      setComments("list", (l) => (l.some((x) => x.id === comment.id) ? l : [...l, comment]));
      setPost("p", "comment_count", (n) => n + 1);
      setDraft("");
      setKind(null);
      setSnap(null);
      setPicking(false);
      setOpen(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (target: "post" | Comment, text: string) => {
    setBusy(true);
    try {
      if (target === "post") setPost("p", (await api.editPost(post.p!.id, text)).post);
      else {
        const r = await api.editComment(target.id, text);
        setComments("list", (c) => c.id === target.id, produce((c) => { c.body = r.comment.body; c.edited_at = r.comment.edited_at; }));
      }
      setOpen(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = (target: "post" | Comment) =>
    showConfirm({
      title: target === "post" ? "Delete post" : "Delete reply",
      text: target === "post" ? "Delete this post? Its replies stay." : "Delete this reply? Its answers stay.",
      mainText: "Delete",
      cancelText: "Cancel",
      intent: "danger",
      onConfirm: async () => {
        try {
          if (target === "post") {
            await api.deletePost(post.p!.id);
            void refetch();
          } else {
            await api.deleteComment(target.id);
            setComments("list", (c) => c.id === target.id, produce((c) => { c.deleted = true; c.body = ""; c.author = null; c.image_url = null; }));
          }
        } catch (e) {
          setError(errorText(e));
        }
      },
    });

  const moderate = async (action: string, type: "post" | "comment", id: string, reason = "") => {
    await api.modAction(action, type, id, reason);
    setOpen(null);
    await refetch();
  };
  const banAuthor = async (name: string, days: number, reason: string) => {
    await api.communityBan(post.p!.community.id, name, true, days, reason);
    setOpen(null);
  };
  const markAnswer = async (c: Comment) => {
    try {
      const r = await api.markAnswer(post.p!.id, post.p!.answer_id === c.id ? null : c.id);
      setPost("p", "answer_id", r.answer_id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const Editor = (ep: { initial?: string; placeholder: string; action: string; onSubmit: (text: string) => void }) => {
    const [text, setText] = createSignal(ep.initial ?? "");
    return (
      <div class="cs-inline-form" onClick={(e) => e.stopPropagation()}>
        <textarea class="cs-textarea" placeholder={ep.placeholder} value={text()} onInput={(e) => setText(e.currentTarget.value)} ref={(el) => setTimeout(() => el.focus())} />
        <div class="cs-row">
          <button type="button" class="cs-btn is-primary" disabled={busy() || !text().trim()} onClick={() => ep.onSubmit(text())}>{ep.action}</button>
          <button type="button" class="cs-btn" onClick={() => setOpen(null)}>Cancel</button>
        </div>
      </div>
    );
  };

  /** Edit, delete, report, and the moderators' actions on a post or a reply. */
  const Actions = (ap: { type: "post" | "comment"; id: string; own: boolean; deleted: boolean; removed: boolean; author: string | null; body: string; target: "post" | Comment }) => (
    <>
      <Show when={ap.own && !ap.deleted && !ap.removed}>
        <button type="button" class="cs-act" onClick={() => toggle(ap.id, "edit")}>Edit</button>
        <button type="button" class="cs-act" onClick={() => remove(ap.target)}>Delete</button>
      </Show>
      <Show when={!ap.own && !ap.deleted}>
        <button type="button" class="cs-act" onClick={needUser(() => toggle(ap.id, "report"))}>Report</button>
      </Show>
      <Show when={isMod() && !ap.deleted}>
        <Show when={ap.removed} fallback={<button type="button" class="cs-act is-mod" onClick={() => toggle(ap.id, "remove")}>Remove</button>}>
          <button type="button" class="cs-act is-mod" onClick={() => moderate("restore", ap.type, ap.id).catch((e) => setError(errorText(e)))}>Restore</button>
        </Show>
        <Show when={ap.type === "post"}>
          <button type="button" class="cs-act is-mod" onClick={() => moderate(post.p!.locked ? "unlock" : "lock", "post", ap.id).catch((e) => setError(errorText(e)))}>{post.p!.locked ? "Unlock" : "Lock"}</button>
        </Show>
        <Show when={ap.author && !ap.own}><button type="button" class="cs-act is-mod" onClick={() => toggle(ap.id, "ban")}>Ban</button></Show>
      </Show>
    </>
  );

  const Forms = (fp: { type: "post" | "comment"; id: string; body: string; author: string | null; target: "post" | Comment }) => {
    const is = (k: NonNullable<Open>["kind"]) => open()?.id === fp.id && open()?.kind === k;
    return (
      <>
        <Show when={is("edit")}><Editor initial={fp.body} placeholder="Text" action="Save" onSubmit={(t) => saveEdit(fp.target, t)} /></Show>
        <Show when={is("report")}><ReportForm type={fp.type} id={fp.id} onDone={() => setOpen(null)} /></Show>
        <Show when={is("remove")}>
          <ReasonForm title={`Remove this ${fp.type === "post" ? "post" : "reply"}`} action="Remove" danger onCancel={() => setOpen(null)} onSubmit={(r) => moderate("remove", fp.type, fp.id, r)} />
        </Show>
        <Show when={is("appeal")}>
          <ReasonForm title="Appeal this removal" action="Send appeal" placeholder="Why the removal should be reconsidered" required="Explain why the removal should be reconsidered."
            onCancel={() => setOpen(null)} onSubmit={async (t) => { await api.appeal(fp.type, fp.id, t); setOpen(null); }} />
        </Show>
        <Show when={is("ban") && fp.author}>
          <BanForm name={fp.author!} communityTitle={tickerName(post.p!.community.id)} onCancel={() => setOpen(null)} onSubmit={(d, r) => banAuthor(fp.author!, d, r)} />
        </Show>
        <Show when={is("reply")}><Editor placeholder="Answer this reply" action="Reply" onSubmit={(t) => send(fp.id, t)} /></Show>
      </>
    );
  };

  const Removed = (rp: { type: "post" | "comment"; id: string; reason: string | null; own: boolean }) => (
    <div class="cs-removed">
      Removed by moderators{rp.reason ? `: ${rp.reason}` : ""}
      <Show when={rp.own}> <button type="button" class="cs-act" onClick={() => toggle(rp.id, "appeal")}>Appeal</button></Show>
    </div>
  );

  const ReplyBody = (rp: { c: Comment }) => {
    const c = () => rp.c;
    return (
      <>
        <Show when={c().removed}><Removed type="comment" id={c().id} reason={c().removed_reason} own={c().own} /></Show>
        <Show when={c().deleted} fallback={<Show when={c().body}><MarkdownBody text={c().body} class="cs-reply-text" /></Show>}>
          <p class="cs-fog">[deleted]</p>
        </Show>
        <Show when={c().image_url}>
          <div class="cs-reply-snap">
            <div class="cs-reply-snap-head"><strong>{c().chart ? c().chart!.symbol.split(":").pop() : tickerName(post.p!.community.id)}</strong>{c().chart ? ` · ${tfShort(c().chart!.interval)}` : ""} · OpenTrader snapshot</div>
            <a href={imageUrl(c().image_url!)} target="_blank" rel="noopener"><img src={imageUrl(c().image_url!)} alt="Snapshot attached to the reply" loading="lazy" /></a>
          </div>
        </Show>
      </>
    );
  };

  const Reply = (rp: { c: Comment }) => {
    const c = () => rp.c;
    const answers = () => under().get(c().id) ?? [];
    const accepted = () => post.p?.answer_id === c().id;
    return (
      <div class={"cs-reply" + (accepted() ? " is-answer" : "")}>
        <Avatar name={c().author} />
        <div class="cs-reply-main">
          <div class="cs-reply-head">
            <UserLink name={c().author} />
            <span class="cs-fog">{recordLine(c().author_record)} · {age(c().created_at)}{c().edited_at ? " · edited" : ""}</span>
            <Show when={c().kind}><span class="cs-type is-plain">{KIND_LABEL[c().kind!]}</span></Show>
            <Show when={c().by_op}><span class="cs-type is-idea">Author</span></Show>
            <Show when={accepted()}><span class="cs-type is-answer">Accepted answer</span></Show>
          </div>
          <ReplyBody c={c()} />
          <div class="cs-reply-acts">
            <button type="button" class={"cs-act" + (c().my_useful ? " is-on" : "")} aria-pressed={c().my_useful} disabled={c().own || c().deleted} onClick={() => useful(c())}>
              <strong>{c().useful_count}</strong> useful
            </button>
            <Show when={!post.p?.locked && !c().deleted}>
              <button type="button" class="cs-act is-link" onClick={needUser(() => toggle(c().id, "reply"))}>Reply</button>
            </Show>
            <Show when={post.p?.own && post.p?.type === "question" && !c().own && !c().deleted}>
              <button type="button" class="cs-act" onClick={() => markAnswer(c())}>{accepted() ? "Unmark answer" : "Mark as the answer"}</button>
            </Show>
            <Actions type="comment" id={c().id} own={c().own} deleted={c().deleted} removed={c().removed} author={c().author} body={c().body} target={c()} />
          </div>
          <Forms type="comment" id={c().id} body={c().body} author={c().author} target={c()} />
          <For each={answers()}>
            {(a) => (
              <div class={"cs-answer" + (a.by_op ? " is-op" : "")}>
                <div class="cs-reply-head">
                  <UserLink name={a.author} />
                  <Show when={a.by_op} fallback={<span class="cs-fog">{age(a.created_at)}</span>}><span class="cs-type is-idea">Author</span></Show>
                </div>
                <ReplyBody c={a} />
                <div class="cs-reply-acts">
                  <button type="button" class={"cs-act" + (a.my_useful ? " is-on" : "")} aria-pressed={a.my_useful} disabled={a.own || a.deleted} onClick={() => useful(a)}><strong>{a.useful_count}</strong> useful</button>
                  <Show when={!post.p?.locked && !a.deleted}><button type="button" class="cs-act is-link" onClick={needUser(() => toggle(a.id, "reply"))}>Reply</button></Show>
                  <Actions type="comment" id={a.id} own={a.own} deleted={a.deleted} removed={a.removed} author={a.author} body={a.body} target={a} />
                </div>
                <Forms type="comment" id={a.id} body={a.body} author={a.author} target={a} />
              </div>
            )}
          </For>
        </div>
      </div>
    );
  };

  const isPost = (k: NonNullable<Open>["kind"]) => open()?.id === post.p?.id && open()?.kind === k;
  const p = () => post.p!;
  const ticker = () => tickerName(p().community.id);
  const fromEntry = (i: Idea) => (i.last_price == null ? null : ((i.direction === "long" ? i.last_price - i.entry : i.entry - i.last_price) / i.entry) * 100);

  return (
    <Show when={!data.error} fallback={<div class="cs-page-msg">{errorText(data.error)}</div>}>
      <Show when={post.p} fallback={<p class="cs-loading">Loading…</p>}>
        <div class="cs-grid is-post">
          <main id="cs-main" class="cs-center is-wide">
            <div class="cs-crumbs">
              <a href="/" onClick={go("/")}>Home</a> / <a href={communityHref(p().community.id)} onClick={go(communityHref(p().community.id))}>{ticker()}</a> / {TYPE_LABEL[p().type]}
            </div>
            <div class="cs-tags">
              <TypeTag type={p().type} />
              <Show when={p().idea}><DirTag dir={p().idea!.direction} /></Show>
              <TickerTag id={p().community.id} size="mid" />
            </div>
            <h1 class="cs-post-title">{p().title}</h1>
            <div class="cs-byline">
              <Avatar name={p().author} />
              <UserLink name={p().author} />
              <Show when={p().author_bot} fallback={<span class="cs-fog">{recordLong(p().author_record)} · posted {age(p().created_at)} ago{p().edited_at ? " · edited" : ""}</span>}>
                <span class="cs-bot">bot</span><span class="cs-fog">posted {age(p().created_at)} ago</span>
              </Show>
              <Show when={p().locked}><span class="cs-type is-plain">Locked</span></Show>
            </div>

            <Show when={p().idea}>
              {(() => {
                const i = () => p().idea!;
                const st = () => ideaState(i());
                const move = () => fromEntry(i());
                return (
                  <>
                    <div class="cs-levels">
                      <div><div class="cs-label">Direction</div><div class="cs-level">{i().direction === "long" ? "Long" : "Short"}</div></div>
                      <div><div class="cs-label">Entry</div><div class="cs-level">{price(i().entry)}</div></div>
                      <div><div class="cs-label">Stop</div><div class="cs-level">{price(i().stop)}</div></div>
                      <div><div class="cs-label">Target</div><div class="cs-level">{price(i().target)}</div></div>
                      <div><div class="cs-label">Reward:risk</div><div class="cs-level">{i().reward_risk.toFixed(1)}</div></div>
                      <div><div class="cs-label">Expires</div><div class="cs-level">{day(i().expires)}</div></div>
                    </div>
                    <div class="cs-status">
                      <span class="cs-status-main">
                        <span class="cs-status-mark" style={{ background: i().status === "open" || i().status === "pending" ? "var(--cs-signal)" : st().color }} />
                        {i().status === "open" ? `Open · triggered ${date(i().triggered_at!)}` : i().status === "pending" ? "Not triggered yet" : `${outcome(i())}`}
                      </span>
                      <Show when={i().status === "open" || i().status === "pending"}>
                        <Show when={i().last_price != null}><span>Last {price(i().last_price)}</span></Show>
                        <Show when={i().status === "open" && move() != null}><span>{fmtPct(move())} from entry</span></Show>
                        <Show when={i().status === "open"}><span class="cs-strong" style={{ color: rColor(i().result_r) }}>{fmtR(i().result_r)}</span></Show>
                      </Show>
                      <Show when={i().result_r != null && i().status !== "open"}><span class="cs-strong" style={{ color: st().color }}>{fmtR(i().result_r)}</span></Show>
                      <span class="cs-status-note">Levels locked at posting. Resolves on stop, target, or {day(i().expires)}.</span>
                    </div>
                  </>
                );
              })()}
            </Show>
            <Show when={p().type === "postmortem" && p().linked}>
              <div class="cs-status">
                <span>Linked idea: <a href={`/p/${p().linked!.id}`} onClick={go(`/p/${p().linked!.id}`)}>{p().linked!.title ?? "an idea"}</a></span>
                <Show when={p().linked!.result_r != null}><span class="cs-strong" style={{ color: rColor(p().linked!.result_r) }}>{fmtR(p().linked!.result_r)}</span></Show>
              </div>
            </Show>

            <Show when={p().removed}><Removed type="post" id={p().id} reason={p().removed_reason} own={p().own} /></Show>
            <Show when={p().deleted}><p class="cs-fog">This post was deleted by its author.</p></Show>

            <Show when={p().image_url}>
              <figure class="cs-figure">
                <div class="cs-figure-head">
                  <span>
                    <strong>{ticker()}</strong>
                    <Show when={p().chart}> · {tfLong(p().chart!.interval)}</Show> · Snapshot {dateTime(p().created_at)}
                  </span>
                  <a href={`opentrader://post/${p().id}`} onClick={openInApp} title="Opens the post and its chart in the OpenTrader app">
                    Open in OpenTrader
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10" /><path d="M7 17 17 7" /></svg>
                  </a>
                </div>
                <Show when={noApp()}>
                  <div class="cs-figure-hint">Nothing opened? The chart opens in the OpenTrader app, free: <a href={APP_URL}>get OpenTrader</a>, then open this link again.</div>
                </Show>
                <a class="cs-figure-img" href={imageUrl(p().image_url!)} target="_blank" rel="noopener"><img src={imageUrl(p().image_url!)} alt={`Chart shared with "${p().title}"`} /></a>
              </figure>
            </Show>

            <Show when={p().body}><MarkdownBody text={p().body} class="cs-post-body" /></Show>
            <Show when={p().source_url}><p class="cs-note">Imported test content · <a href={p().source_url!}>source</a></p></Show>
            <div class="cs-post-acts">
              <Actions type="post" id={p().id} own={p().own} deleted={p().deleted} removed={p().removed} author={p().author} body={p().body} target="post" />
            </div>
            <Show when={isPost("edit")}><Editor initial={p().body} placeholder="Text" action="Save" onSubmit={(t) => saveEdit("post", t)} /></Show>
            <Show when={isPost("report")}><ReportForm type="post" id={p().id} onDone={() => setOpen(null)} /></Show>
            <Show when={isPost("remove")}><ReasonForm title="Remove this post" action="Remove" danger onCancel={() => setOpen(null)} onSubmit={(r) => moderate("remove", "post", p().id, r)} /></Show>
            <Show when={isPost("appeal")}>
              <ReasonForm title="Appeal this removal" action="Send appeal" placeholder="Why the removal should be reconsidered" required="Explain why the removal should be reconsidered."
                onCancel={() => setOpen(null)} onSubmit={async (t) => { await api.appeal("post", p().id, t); setOpen(null); }} />
            </Show>
            <Show when={isPost("ban") && p().author}>
              <BanForm name={p().author!} communityTitle={ticker()} onCancel={() => setOpen(null)} onSubmit={(d, r) => banAuthor(p().author!, d, r)} />
            </Show>

            <Show when={!p().deleted && !p().removed}>
              <div class="cs-rate">
                <div class="cs-rate-head">
                  <h5>{p().own ? "What readers found useful" : "Was this useful? Say why."}</h5>
                  <span class="cs-fog">{p().useful_count} reader{p().useful_count === 1 ? "" : "s"} found it useful · {p().flag_count} flagged</span>
                </div>
                <div class="cs-rate-btns">
                  <For each={REASONS}>
                    {(r) => {
                      const mine = () => ratings().mine.includes(r.id);
                      return (
                        <button type="button" class={"cs-btn" + (mine() ? " is-picked" : "")} aria-pressed={mine()} disabled={p().own} onClick={() => rate(r.id)}>
                          {r.label}<span class="cs-rate-n">{ratings().reasons[r.id] ?? 0}</span>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </div>
            </Show>
            <ErrorBanner text={error()} onClose={() => setError(null)} />

            <div class="cs-head is-strong is-replies">
              <h3>{p().comment_count} {p().comment_count === 1 ? "reply" : "replies"}</h3>
              <Pills items={[{ id: "useful", label: "Most useful" }, { id: "oldest", label: "Oldest" }]} value={sort()} onChange={setSort} label="Sort replies" />
            </div>
            <For each={tops()} fallback={<p class="cs-note">No replies yet.</p>}>{(c) => <Reply c={c} />}</For>

            <Show when={!p().deleted && !p().removed}>
              <Show when={!p().locked} fallback={<p class="cs-note">Locked: no new replies.</p>}>
                <PostingCheckPrompt />
                <div class="cs-reply-box">
                  <textarea
                    class="cs-textarea"
                    placeholder={p().own ? "Add an update: what changed, what you do now. The levels stay." : "Add a counterpoint, data, or a question. Attach a snapshot if you reference price."}
                    value={draft()}
                    onInput={(e) => setDraft(e.currentTarget.value)}
                  />
                  <Show when={!p().own}>
                    <div class="cs-row is-kinds">
                      <span class="cs-fog">Kind</span>
                      <For each={KINDS}>
                        {(k) => (
                          <button type="button" class={"cs-chip" + (kind() === k.id ? " is-on" : "")} aria-pressed={kind() === k.id} onClick={() => setKind(kind() === k.id ? null : k.id)}>{k.label}</button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={picking()}><SnapshotPicker selected={snap()} onSelect={setSnap} columns={3} /></Show>
                  <div class="cs-row">
                    <button type="button" class="cs-btn is-primary" disabled={busy() || !draft().trim()} onClick={needUser(() => void send(null, draft()))}>Reply</button>
                    <button type="button" class="cs-btn" onClick={needUser(() => setPicking((x) => !x))}>{snap() ? "Snapshot attached" : "Attach OpenTrader snapshot"}</button>
                  </div>
                </div>
              </Show>
            </Show>
          </main>

          <aside class="cs-right is-post">
            <Show when={p().idea}>
              <section>
                <h5>Idea log</h5>
                <For each={ideaLog(p())}>{(e) => <div class="cs-log"><span class="cs-fog">{e.d}</span><span>{e.e}</span></div>}</For>
              </section>
            </Show>
            <Show when={p().author && !p().author_bot}>
              <section>
                <h5>{p().author}'s last {Math.max(1, (authorIdeas() ?? []).length)} idea{(authorIdeas() ?? []).length === 1 ? "" : "s"}</h5>
                <div class="cs-note">Every idea counts, including the bad ones.</div>
                <For each={authorIdeas() ?? []} fallback={<div class="cs-ruled-row cs-fog">No other idea yet.</div>}>
                  {(a) => (
                    <a class="cs-ideas-row" href={`/p/${a.id}`} onClick={go(`/p/${a.id}`)}>
                      <strong>{tickerName(a.community.id)}</strong>
                      <span class="cs-fog">{a.idea ? outcome(a.idea).split(" · ")[0] : ""}</span>
                      <strong style={{ color: a.idea && a.idea.status !== "pending" ? rColor(a.idea.result_r) : FOG }}>{a.idea?.result_r != null ? fmtR(a.idea.result_r) : "—"}</strong>
                    </a>
                  )}
                </For>
              </section>
            </Show>
            <section>
              <h5>Also on {ticker()}</h5>
              <For each={related() ?? []} fallback={<div class="cs-ruled-row cs-fog">Nothing else yet.</div>}>
                {(x) => (
                  <a class="cs-ruled-row cs-q" href={`/p/${x.id}`} onClick={go(`/p/${x.id}`)}>
                    <div class="cs-label">{TYPE_LABEL[x.type]} · {x.type === "question" && x.answer_id ? "answered" : age(x.created_at)}</div>
                    <div class="cs-q-t">{x.title}</div>
                  </a>
                )}
              </For>
            </section>
          </aside>
        </div>
      </Show>
    </Show>
  );
}
