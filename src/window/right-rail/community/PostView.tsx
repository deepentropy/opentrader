/*
 * One post and its threaded replies: its type, an idea's levels and state,
 * why readers found it useful, replies with their kind (the author's marked),
 * a question's accepted answer, edits, deletion, reports, and the
 * moderators' remove / restore / lock.
 */
import { For, Show, createMemo, createSignal } from "solid-js";
import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/IconButton";
import { showConfirm } from "../../../components/Dialogs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, imageUrl, type Comment, type Reason, type SharedChart } from "../../../data/community/api";
import { chartBridge } from "../../../data/community/chart-share";
import { shortIntervalLabel } from "../../chart/interval-favorites";
import { Age, Author, AuthorRecord, BanForm, BotBadge, ErrorBanner, ExternalLink, IdeaLevels, MarkdownBody, PostState, ReasonForm, ReportForm, TypeBadges, errorText } from "../../../community-shared/parts";
import { KINDS, KIND_LABEL, createPostThread, type FormKind } from "../../../community-shared/post-thread";
import { translateWith } from "../../../i18n/translator";

const REASONS: { id: Reason; label: string }[] = [
  { id: "thesis", label: "Clear thesis" },
  { id: "data", label: "Good data" },
  { id: "view", label: "Changed my view" },
  { id: "risk", label: "Well-defined risk" },
  { id: "vague", label: "Vague" },
];

/** Deeper replies are drawn at this depth (the panel is narrow). */
const MAX_INDENT = 6;

type Props = {
  postId: string;
  /** Put its shared chart on the active chart once loaded (an "Open in OpenTrader" link). */
  openChart?: boolean;
  onBack: () => void;
  onOpenCommunity: (id: string) => void;
  onNeedSignIn: () => void;
  /** The post was deleted or rated: the list refreshes. */
  onChanged: () => void;
};

/** The author asks the moderators to look again at a removal. */
function AppealForm(props: { type: "post" | "comment"; id: string; onDone: () => void }) {
  const [sent, setSent] = createSignal(false);
  return (
    <Show when={!sent()} fallback={<div class="cm-muted cm-hint">Appeal sent. A moderator will review the removal.</div>}>
      <ReasonForm
        title="Appeal this removal"
        action="Send appeal"
        placeholder="Why the removal should be reconsidered"
        required="Explain why the removal should be reconsidered."
        onCancel={props.onDone}
        onSubmit={async (text) => {
          await api.appeal(props.type, props.id, text);
          setSent(true);
        }}
      />
    </Show>
  );
}

/** The chart shared in a post: its picture (opens full size in the browser) and "Open on my chart". */
function SharedChartBlock(props: { imagePath: string | null; chart: SharedChart | null; auto?: boolean }) {
  const [done, setDone] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal<string | null>(null);
  const open = async () => {
    const b = chartBridge();
    if (!b || !props.chart) return;
    setFailed(null);
    try {
      const n = await b.open(props.chart);
      const [symbol, interval] = [props.chart.symbol, shortIntervalLabel(props.chart.interval)];
      setDone(n ? translateWith(n === 1 ? "Opened {0}, {1} with {2} drawing." : "Opened {0}, {1} with {2} drawings.", symbol, interval, n) : translateWith("Opened {0}, {1}.", symbol, interval));
    } catch (e) {
      setFailed(errorText(e));
    }
  };
  // Opened from an "Open in OpenTrader" link: the chart is what was asked for.
  if (props.auto) queueMicrotask(() => void open());
  const drawings = () => props.chart?.drawings.length ?? 0;
  return (
    <div class="cm-shared-chart">
      <Show when={props.imagePath}>
        <img
          class="cm-chart-img"
          src={imageUrl(props.imagePath!)}
          alt="Shared chart"
          loading="lazy"
          title="Open the picture full size"
          onClick={() => void openUrl(imageUrl(props.imagePath!))}
        />
      </Show>
      <Show when={props.chart}>
        <div class="cm-actions">
          <span class="cm-muted">
            {props.chart!.symbol} · {shortIntervalLabel(props.chart!.interval)} · {translateWith(drawings() === 1 ? "{0} drawing" : "{0} drawings", drawings())}
          </span>
          <Show
            when={chartBridge()}
            fallback={<ExternalLink href="https://opentrader.markets/download.html">Open it in the OpenTrader app</ExternalLink>}
          >
            <button type="button" class="cm-btn is-small is-primary" onClick={open}>Open on my chart</button>
          </Show>
        </div>
        <Show when={done()}><div class="cm-muted cm-hint">{done()}</div></Show>
        <ErrorBanner text={failed()} />
      </Show>
    </div>
  );
}

export function PostView(props: Props) {
  const t = createPostThread({ id: () => props.postId, onNeedSignIn: () => props.onNeedSignIn(), onChanged: () => props.onChanged() });
  const { data, post, comments, ratings, isMod, error, setError, open, setOpen, draft, setDraft, kind, setKind, busy, needUser, rate, useful, markAnswer, moderate } = t;
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());

  const children = createMemo(() => {
    const map = new Map<string | null, Comment[]>();
    for (const c of comments.list) {
      const k = c.parent_id ?? null;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    }
    for (const list of map.values()) list.sort((a, b) => b.useful_count - a.useful_count || a.created_at - b.created_at);
    return map;
  });

  // One text box at a time: opening a form starts it empty.
  const toggle = (id: string, kind: FormKind) => {
    setDraft("");
    t.toggle(id, kind);
  };
  const sendComment = (parentId: string | null) => void t.send(parentId, draft());
  const saveEdit = (target: "post" | Comment) => t.saveEdit(target, draft());

  const remove = (target: "post" | Comment) =>
    showConfirm({
      title: target === "post" ? "Delete post" : "Delete comment",
      text: target === "post" ? "Delete this post? Its comments stay." : "Delete this comment? Its replies stay.",
      mainText: "Delete",
      cancelText: "Cancel",
      intent: "danger",
      onConfirm: () => t.remove(target),
    });

  const banAuthor = async (name: string, days: number, reason: string) => {
    await t.banAuthor(name, days, reason);
    setError(null);
  };

  const Editor = (p: { placeholder: string; action: string; onSubmit: () => void }) => (
    <div class="cm-form" onClick={(e) => e.stopPropagation()}>
      <textarea class="cm-textarea" placeholder={p.placeholder} value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} ref={(el) => setTimeout(() => el.focus())} />
      <div class="cm-form-actions">
        <button type="button" class="cm-btn" onClick={() => setOpen(null)}>Cancel</button>
        <button type="button" class="cm-btn is-primary" disabled={busy() || !draft().trim()} onClick={() => p.onSubmit()}>{p.action}</button>
      </div>
    </div>
  );

  const CommentNode = (cp: { c: Comment; depth: number }) => {
    const c = () => cp.c;
    const kids = () => children().get(c().id) ?? [];
    const isCollapsed = () => collapsed().has(c().id);
    const flip = () => setCollapsed((s) => { const n = new Set(s); if (n.has(c().id)) n.delete(c().id); else n.add(c().id); return n; });
    const is = (kind: FormKind) => open()?.id === c().id && open()?.kind === kind;
    return (
      <div class={"cm-comment" + (cp.depth > 0 && cp.depth <= MAX_INDENT ? " is-nested" : "")}>
        <div class="cm-comment-head">
          <button type="button" class="cm-collapse" aria-label={isCollapsed() ? "Expand" : "Collapse"} onClick={flip}>{isCollapsed() ? "+" : "−"}</button>
          <Author name={c().author} />
          <Show when={c().by_op}><span class="cm-type is-idea">Author</span></Show>
          <Show when={c().kind}><span class="cm-type">{KIND_LABEL[c().kind!]}</span></Show>
          <Show when={post.p?.answer_id === c().id}><span class="cm-type is-answer">Answer</span></Show>
          <span class="cm-dot">·</span>
          <Age at={c().created_at} />
          <Show when={c().edited_at}><span class="cm-muted"> (edited)</span></Show>
          <Show when={isCollapsed()}><span class="cm-muted"> · {kids().length ? translateWith(kids().length === 1 ? "{0} reply" : "{0} replies", kids().length) : ""}</span></Show>
        </div>
        <Show when={!isCollapsed()}>
          <Show when={c().removed}>
            <div class="cm-removed">
              Removed by moderators{c().removed_reason ? `: ${c().removed_reason}` : ""}
              <Show when={c().own}> <button type="button" class="cm-action is-inline" onClick={() => toggle(c().id, "appeal")}>Appeal</button></Show>
            </div>
            <Show when={is("appeal")}>
              <AppealForm type="comment" id={c().id} onDone={() => setOpen(null)} />
            </Show>
          </Show>
          <Show when={c().deleted} fallback={<Show when={c().body}><MarkdownBody text={c().body} /></Show>}>
            <div class="cm-muted cm-gone">[deleted]</div>
          </Show>
          <Show when={c().image_url}>
            <img class="cm-chart-img" src={imageUrl(c().image_url!)} alt="Snapshot attached to the reply" loading="lazy" onClick={() => void openUrl(imageUrl(c().image_url!))} />
          </Show>
          <div class="cm-actions">
            <button type="button" class={"cm-action" + (c().my_useful ? " is-on" : "")} aria-pressed={c().my_useful} disabled={c().own || c().deleted || c().removed} onClick={() => useful(c())}>
              {c().useful_count} useful
            </button>
            <Show when={post.p?.own && post.p?.type === "question" && !c().own && !c().deleted && cp.depth === 0}>
              <button type="button" class="cm-action" onClick={() => markAnswer(c())}>{post.p?.answer_id === c().id ? "Unmark answer" : "Mark as the answer"}</button>
            </Show>
            <Show when={!post.p?.locked && !c().deleted}>
              <button type="button" class="cm-action" onClick={needUser(() => toggle(c().id, "reply"))}>Reply</button>
            </Show>
            <Show when={c().own && !c().deleted && !c().removed}>
              <button type="button" class="cm-action" onClick={() => { toggle(c().id, "edit"); setDraft(c().body); }}>Edit</button>
              <button type="button" class="cm-action" onClick={() => remove(c())}>Delete</button>
            </Show>
            <Show when={!c().own && !c().deleted}>
              <button type="button" class="cm-action" onClick={needUser(() => toggle(c().id, "report"))}>Report</button>
            </Show>
            <Show when={isMod() && !c().deleted}>
              <Show when={c().removed} fallback={<button type="button" class="cm-action is-mod" onClick={() => toggle(c().id, "remove")}>Remove</button>}>
                <button type="button" class="cm-action is-mod" onClick={() => moderate("restore", "comment", c().id).catch((e) => setError(errorText(e)))}>Restore</button>
              </Show>
              <Show when={c().author && !c().own}>
                <button type="button" class="cm-action is-mod" onClick={() => toggle(c().id, "ban")}>Ban</button>
              </Show>
            </Show>
          </div>
          <Show when={is("reply")}><Editor placeholder="Write a reply" action="Reply" onSubmit={() => sendComment(c().id)} /></Show>
          <Show when={is("edit")}><Editor placeholder="Comment" action="Save" onSubmit={() => saveEdit(c())} /></Show>
          <Show when={is("report")}><ReportForm type="comment" id={c().id} onDone={(sent) => { setOpen(null); if (sent) setError(null); }} /></Show>
          <Show when={is("remove")}>
            <ReasonForm title="Remove this comment" action="Remove" danger onCancel={() => setOpen(null)} onSubmit={(r) => moderate("remove", "comment", c().id, r)} />
          </Show>
          <Show when={is("ban") && post.p}>
            <BanForm name={c().author!} communityTitle={post.p!.community.title} onCancel={() => setOpen(null)} onSubmit={(days, r) => banAuthor(c().author!, days, r)} />
          </Show>
          <For each={kids()}>{(k) => <CommentNode c={k} depth={cp.depth + 1} />}</For>
        </Show>
      </div>
    );
  };

  const isPost = (kind: FormKind) => open()?.id === "post" && open()?.kind === kind;

  return (
    <div class="cm-post-view">
      <div class="cm-subheader">
        <IconButton aria-label="Back" onClick={() => props.onBack()}><Icon name="community-back" size={28} /></IconButton>
        <Show when={post.p}>
          <button type="button" class="cm-subheader-title" onClick={() => props.onOpenCommunity(post.p!.community.id)}>{post.p!.community.title.replace(/^\$/, "")}</button>
        </Show>
      </div>
      <div class="cm-scroll">
        <ErrorBanner text={error()} onClose={() => setError(null)} />
        <Show when={!data.error} fallback={<div class="ot-empty-state">{errorText(data.error)}</div>}>
          <Show when={post.p} fallback={<div class="ot-empty-state">Loading…</div>}>
            {(() => {
              const p = () => post.p!;
              return (
                <article class="cm-post">
                  <div class="cm-meta"><TypeBadges post={p()} /></div>
                  <h2 class="cm-post-heading">{p().title}</h2>
                  <div class="cm-meta">
                    <Author name={p().author} />
                    <BotBadge show={p().author_bot} />
                    <AuthorRecord post={p()} />
                    <span class="cm-dot">·</span>
                    <Age at={p().created_at} />
                    <Show when={p().edited_at}><span> (edited)</span></Show>
                    <Show when={p().locked}><span class="cm-badge">Locked</span></Show>
                  </div>
                  <Show when={p().removed}>
                    <div class="cm-removed">
                      Removed by moderators{p().removed_reason ? `: ${p().removed_reason}` : ""}
                      <Show when={p().own}> <button type="button" class="cm-action is-inline" onClick={() => toggle("post", "appeal")}>Appeal</button></Show>
                    </div>
                    <Show when={isPost("appeal")}>
                      <AppealForm type="post" id={p().id} onDone={() => setOpen(null)} />
                    </Show>
                  </Show>
                  <Show when={p().deleted}><div class="cm-muted cm-gone">This post was deleted by its author.</div></Show>
                  <Show when={p().idea}><IdeaLevels idea={p().idea!} /></Show>
                  <Show when={!p().idea}><div class="cm-meta"><PostState post={p()} /></div></Show>
                  <Show when={p().body}><MarkdownBody text={p().body} class="cm-post-body" /></Show>
                  <Show when={p().image_url || p().chart}>
                    <SharedChartBlock imagePath={p().image_url} chart={p().chart} auto={props.openChart} />
                  </Show>
                  <Show when={p().source_url}>
                    <div class="cm-muted cm-origin">Imported test content · <ExternalLink href={p().source_url!}>source</ExternalLink></div>
                  </Show>
                  <Show when={!p().deleted && !p().removed}>
                    <div class="cm-rate">
                      <div class="cm-muted">
                        {p().own ? "What readers found useful" : "Useful? Say why"} · {p().useful_count} found it useful{p().flag_count ? ` · ${p().flag_count} flagged` : ""}
                      </div>
                      <div class="cm-rate-btns">
                        <For each={REASONS}>
                          {(r) => (
                            <button type="button" class={"cm-chip" + (ratings().mine.includes(r.id) ? " is-on" : "")} aria-pressed={ratings().mine.includes(r.id)} disabled={p().own} onClick={() => rate(r.id)}>
                              {r.label} <span>{ratings().reasons[r.id] ?? 0}</span>
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                  <div class="cm-actions">
                    <span class="cm-comment-count"><Icon name="community-comment" size={18} />{p().comment_count}</span>
                    <Show when={p().own && !p().deleted && !p().removed}>
                      <button type="button" class="cm-action" onClick={() => { toggle("post", "edit"); setDraft(p().body); }}>Edit</button>
                      <button type="button" class="cm-action" onClick={() => remove("post")}>Delete</button>
                    </Show>
                    <Show when={!p().own && !p().deleted}>
                      <button type="button" class="cm-action" onClick={needUser(() => toggle("post", "report"))}>Report</button>
                    </Show>
                    <Show when={isMod()}>
                      <Show when={p().removed} fallback={<button type="button" class="cm-action is-mod" onClick={() => toggle("post", "remove")}>Remove</button>}>
                        <button type="button" class="cm-action is-mod" onClick={() => moderate("restore", "post", p().id).catch((e) => setError(errorText(e)))}>Restore</button>
                      </Show>
                      <button type="button" class="cm-action is-mod" onClick={() => moderate(p().locked ? "unlock" : "lock", "post", p().id).catch((e) => setError(errorText(e)))}>
                        {p().locked ? "Unlock" : "Lock"}
                      </button>
                      <Show when={p().author && !p().own}>
                        <button type="button" class="cm-action is-mod" onClick={() => toggle("post", "ban")}>Ban</button>
                      </Show>
                    </Show>
                  </div>
                  <Show when={isPost("edit")}><Editor placeholder="Text" action="Save" onSubmit={() => saveEdit("post")} /></Show>
                  <Show when={isPost("report")}><ReportForm type="post" id={p().id} onDone={() => setOpen(null)} /></Show>
                  <Show when={isPost("remove")}>
                    <ReasonForm title="Remove this post" action="Remove" danger onCancel={() => setOpen(null)} onSubmit={(r) => moderate("remove", "post", p().id, r)} />
                  </Show>
                  <Show when={isPost("ban")}>
                    <BanForm name={p().author!} communityTitle={p().community.title} onCancel={() => setOpen(null)} onSubmit={(days, r) => banAuthor(p().author!, days, r)} />
                  </Show>
                  <Show when={!p().deleted && !p().removed}>
                    <Show when={!p().locked} fallback={<div class="cm-muted cm-locked">Locked: no new comments.</div>}>
                      <Show
                        when={isPost("reply")}
                        fallback={
                          <button type="button" class="cm-reply-prompt" onClick={needUser(() => toggle("post", "reply"))}>{p().own ? "Add an update" : "Add a reply"}</button>
                        }
                      >
                        <Show when={!p().own}>
                          <div class="cm-rate-btns">
                            <For each={KINDS}>
                              {(k) => (
                                <button type="button" class={"cm-chip" + (kind() === k.id ? " is-on" : "")} aria-pressed={kind() === k.id} onClick={() => setKind(kind() === k.id ? null : k.id)}>{k.label}</button>
                              )}
                            </For>
                          </div>
                        </Show>
                        <Editor placeholder={p().own ? "Add an update: what changed. The levels stay." : "Add a counterpoint, data, or a question"} action="Reply" onSubmit={() => sendComment(null)} />
                      </Show>
                    </Show>
                  </Show>
                </article>
              );
            })()}
            <div class="cm-comments">
              <For each={children().get(null) ?? []} fallback={<div class="ot-empty-state">No replies yet.</div>}>
                {(c) => <CommentNode c={c} depth={0} />}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
