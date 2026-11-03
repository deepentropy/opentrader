/*
 * One post and its threaded comments: votes, replies, edits, deletion,
 * reports, and the moderators' remove / restore / lock.
 */
import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/IconButton";
import { showConfirm } from "../../../components/Dialogs";
import { api, type Comment, type Post } from "../../../data/community/api";
import { me } from "../../../data/community/session";
import { Age, Author, ErrorBanner, ExternalLink, MarkdownBody, ReasonForm, ReportForm, Vote, errorText } from "./parts";

/** Deeper replies are drawn at this depth (the panel is narrow). */
const MAX_INDENT = 6;

type Props = {
  postId: string;
  onBack: () => void;
  onOpenCommunity: (id: string) => void;
  onNeedSignIn: () => void;
  /** The post was deleted or its score changed: the list refreshes. */
  onChanged: () => void;
};

/** Inline form under a post or comment: reply, edit, report, remove. */
type Open = { id: string; kind: "reply" | "edit" | "report" | "remove" | "appeal" } | null;

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

export function PostView(props: Props) {
  const [data, { refetch }] = createResource(() => props.postId, (id) => api.post(id));
  const [post, setPost] = createStore<{ p: Post | null }>({ p: null });
  const [comments, setComments] = createStore<{ list: Comment[] }>({ list: [] });
  const [isMod, setIsMod] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal<Open>(null);
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  // The fetched post feeds the stores the view edits in place.
  createMemo(() => {
    const d = data();
    if (!d) return;
    setPost("p", d.post);
    setComments("list", d.comments);
    setIsMod(d.is_mod);
  });

  const children = createMemo(() => {
    const map = new Map<string | null, Comment[]>();
    for (const c of comments.list) {
      const k = c.parent_id ?? null;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    }
    for (const list of map.values()) list.sort((a, b) => b.score - a.score || a.created_at - b.created_at);
    return map;
  });

  const needUser = (fn: () => void) => () => (me() ? fn() : props.onNeedSignIn());
  const toggle = (id: string, kind: NonNullable<Open>["kind"]) => {
    setDraft("");
    setOpen((o) => (o?.id === id && o.kind === kind ? null : { id, kind }));
  };

  const sendComment = async (parentId: string | null) => {
    const p = post.p;
    if (!p || !draft().trim()) return;
    setBusy(true);
    try {
      const { comment } = await api.comment(p.id, draft(), parentId);
      setComments("list", (l) => [...l, comment]);
      setPost("p", "comment_count", (n) => n + 1);
      setDraft("");
      setOpen(null);
      props.onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (target: "post" | Comment) => {
    setBusy(true);
    try {
      if (target === "post") {
        const r = await api.editPost(post.p!.id, draft());
        setPost("p", r.post);
      } else {
        const r = await api.editComment(target.id, draft());
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
      title: target === "post" ? "Delete post" : "Delete comment",
      text: target === "post" ? "Delete this post? Its comments stay." : "Delete this comment? Its replies stay.",
      mainText: "Delete",
      cancelText: "Cancel",
      intent: "danger",
      onConfirm: async () => {
        try {
          if (target === "post") {
            await api.deletePost(post.p!.id);
            props.onChanged();
            void refetch();
          } else {
            await api.deleteComment(target.id);
            setComments("list", (c) => c.id === target.id, produce((c) => { c.deleted = true; c.body = ""; c.author = null; }));
          }
        } catch (e) {
          setError(errorText(e));
        }
      },
    });

  const moderate = async (action: string, type: "post" | "comment", id: string, reason = "") => {
    await api.modAction(action, type, id, reason);
    setOpen(null);
    props.onChanged();
    await refetch();
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
    const is = (kind: NonNullable<Open>["kind"]) => open()?.id === c().id && open()?.kind === kind;
    return (
      <div class={"cm-comment" + (cp.depth > 0 && cp.depth <= MAX_INDENT ? " is-nested" : "")}>
        <div class="cm-comment-head">
          <button type="button" class="cm-collapse" aria-label={isCollapsed() ? "Expand" : "Collapse"} onClick={flip}>{isCollapsed() ? "+" : "−"}</button>
          <Author name={c().author} />
          <span class="cm-dot">·</span>
          <Age at={c().created_at} />
          <Show when={c().edited_at}><span class="cm-muted"> (edited)</span></Show>
          <Show when={isCollapsed()}><span class="cm-muted"> · {kids().length ? `${kids().length} repl${kids().length > 1 ? "ies" : "y"}` : ""}</span></Show>
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
          <div class="cm-actions">
            <Vote
              type="comment" id={c().id} score={c().score} myVote={c().my_vote} disabled={c().deleted || c().removed}
              onChange={(score, my) => setComments("list", (x) => x.id === c().id, produce((x) => { x.score = score; x.my_vote = my; }))}
              onNeedSignIn={props.onNeedSignIn} onError={setError}
            />
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
            </Show>
          </div>
          <Show when={is("reply")}><Editor placeholder="Write a reply" action="Reply" onSubmit={() => sendComment(c().id)} /></Show>
          <Show when={is("edit")}><Editor placeholder="Comment" action="Save" onSubmit={() => saveEdit(c())} /></Show>
          <Show when={is("report")}><ReportForm type="comment" id={c().id} onDone={(sent) => { setOpen(null); if (sent) setError(null); }} /></Show>
          <Show when={is("remove")}>
            <ReasonForm title="Remove this comment" action="Remove" danger onCancel={() => setOpen(null)} onSubmit={(r) => moderate("remove", "comment", c().id, r)} />
          </Show>
          <For each={kids()}>{(k) => <CommentNode c={k} depth={cp.depth + 1} />}</For>
        </Show>
      </div>
    );
  };

  const isPost = (kind: NonNullable<Open>["kind"]) => open()?.id === "post" && open()?.kind === kind;

  return (
    <div class="cm-post-view">
      <div class="cm-subheader">
        <IconButton aria-label="Back" onClick={() => props.onBack()}><Icon name="community-back" size={28} /></IconButton>
        <Show when={post.p}>
          <button type="button" class="cm-subheader-title" onClick={() => props.onOpenCommunity(post.p!.community.id)}>{post.p!.community.title}</button>
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
                  <h2 class="cm-post-heading">{p().title}</h2>
                  <div class="cm-meta">
                    <Author name={p().author} />
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
                  <Show when={p().body}><MarkdownBody text={p().body} class="cm-post-body" /></Show>
                  <Show when={p().source_url}>
                    <div class="cm-muted cm-origin">Imported test content · <ExternalLink href={p().source_url!}>source</ExternalLink></div>
                  </Show>
                  <div class="cm-actions">
                    <Vote
                      type="post" id={p().id} score={p().score} myVote={p().my_vote} disabled={p().deleted || p().removed}
                      onChange={(score, my) => { setPost("p", produce((x) => { x!.score = score; x!.my_vote = my; })); props.onChanged(); }}
                      onNeedSignIn={props.onNeedSignIn} onError={setError}
                    />
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
                    </Show>
                  </div>
                  <Show when={isPost("edit")}><Editor placeholder="Text" action="Save" onSubmit={() => saveEdit("post")} /></Show>
                  <Show when={isPost("report")}><ReportForm type="post" id={p().id} onDone={() => setOpen(null)} /></Show>
                  <Show when={isPost("remove")}>
                    <ReasonForm title="Remove this post" action="Remove" danger onCancel={() => setOpen(null)} onSubmit={(r) => moderate("remove", "post", p().id, r)} />
                  </Show>
                  <Show when={!p().deleted && !p().removed}>
                    <Show when={!p().locked} fallback={<div class="cm-muted cm-locked">Locked: no new comments.</div>}>
                      <Show
                        when={isPost("reply")}
                        fallback={
                          <button type="button" class="cm-reply-prompt" onClick={needUser(() => toggle("post", "reply"))}>Add a comment</button>
                        }
                      >
                        <Editor placeholder="Add a comment" action="Comment" onSubmit={() => sendComment(null)} />
                      </Show>
                    </Show>
                  </Show>
                </article>
              );
            })()}
            <div class="cm-comments">
              <For each={children().get(null) ?? []} fallback={<div class="ot-empty-state">No comments yet.</div>}>
                {(c) => <CommentNode c={c} depth={0} />}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
