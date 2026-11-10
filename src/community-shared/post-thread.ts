/*
 * One post's thread, shared by the app's Community panel (PostView) and the
 * website's post page (PostPage): the post, its replies and the reader's
 * ratings as stores edited in place, the replies that arrive live, and the
 * actions on them (reply, edit, delete, rate, "useful", the accepted answer,
 * the moderators' decisions). Each view keeps its own layout and texts.
 */
import { createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { COMMUNITY_URL, api, type ChartAttachment, type Comment, type Post, type Ratings, type Reason, type ReplyKind } from "../data/community/api";
import { withPostingCheck } from "../data/community/posting-check";
import { me } from "../data/community/session";
import { errorText } from "./parts";
import { withReply, type ReplySource } from "./replies";

/** The kinds a reader picks for a reply to the post (updates are the author's, support a suggestion's). */
export const KINDS: { id: ReplyKind; label: string }[] = [
  { id: "data", label: "Data" },
  { id: "counterpoint", label: "Counterpoint" },
  { id: "question", label: "Question" },
];
export const KIND_LABEL: Record<ReplyKind, string> = { data: "Data", counterpoint: "Counterpoint", question: "Question", update: "Update", support: "Supporter" };

/** The inline form open under the post or a reply. */
export type OpenForm = { id: string; kind: "reply" | "edit" | "report" | "remove" | "appeal" | "ban" } | null;
export type FormKind = NonNullable<OpenForm>["kind"];

export function createPostThread(opts: {
  id: () => string;
  /** Fetch the post again when the member signs in or out (what they may do on it changes). */
  reloadOnAccount?: boolean;
  onNeedSignIn: () => void;
  /** The post's counts changed or it was deleted: the lists showing it refresh. */
  onChanged?: () => void;
}) {
  const [data, { refetch }] = createResource(
    () => [opts.id(), opts.reloadOnAccount ? me()?.user.name ?? "" : ""] as const,
    ([id]) => api.post(id),
  );
  const [post, setPost] = createStore<{ p: Post | null }>({ p: null });
  const [comments, setComments] = createStore<{ list: Comment[] }>({ list: [] });
  const [ratings, setRatings] = createSignal<Ratings>({ reasons: {}, mine: [] });
  const [isMod, setIsMod] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal<OpenForm>(null);
  const [draft, setDraft] = createSignal("");
  const [kind, setKind] = createSignal<ReplyKind | null>(null);
  const [busy, setBusy] = createSignal(false);
  const changed = () => opts.onChanged?.();

  /** A reply into the thread; the count goes up only when its id is new (the live room and the answer both bring the reader's own). */
  const addReply = (c: Comment, from: ReplySource) => {
    const r = withReply(comments.list, c, from);
    setComments("list", r.list);
    if (r.added) setPost("p", produce((x) => { if (x) x.comment_count += 1; }));
  };

  // The fetched post feeds the stores the view edits in place.
  createMemo(() => {
    const d = data();
    if (!d) return;
    setPost("p", d.post);
    setComments("list", d.comments);
    setRatings(d.ratings);
    setIsMod(d.is_mod);
  });

  // Live replies (#208): the post's room passes on each new one; a lost connection comes back after a pause.
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
      if (m.type === "comment" && m.comment) addReply(m.comment, "live");
    };
    socket.onclose = () => {
      if (!closed) retry = setTimeout(() => connect(postId, Math.min(delay * 2, 60_000)), delay);
    };
  };
  createEffect(on(opts.id, (id) => connect(id)));
  onCleanup(() => {
    closed = true;
    if (retry) clearTimeout(retry);
    socket?.close();
  });

  const needUser = (fn: () => void) => () => (me() ? fn() : opts.onNeedSignIn());
  const toggle = (id: string, k: FormKind) => setOpen((o) => (o?.id === id && o.kind === k ? null : { id, kind: k }));

  /** A reply to the post (parentId null: with the picked kind, or an update by the author) or to a reply. */
  const send = async (parentId: string | null, text: string, attach: ChartAttachment | null = null): Promise<boolean> => {
    const p = post.p;
    if (!p || !text.trim()) return false;
    setBusy(true);
    try {
      const k = parentId ? null : p.own ? "update" : kind();
      const { comment } = await withPostingCheck(() => api.comment(p.id, text, parentId, k, attach));
      addReply(comment, "answer");
      setDraft("");
      setKind(null);
      setOpen(null);
      changed();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
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

  /** Deletes the post or the reader's reply (the view asks first). */
  const remove = async (target: "post" | Comment) => {
    try {
      if (target === "post") {
        await api.deletePost(post.p!.id);
        changed();
        void refetch();
      } else {
        await api.deleteComment(target.id);
        setComments("list", (c) => c.id === target.id, produce((c) => { c.deleted = true; c.body = ""; c.author = null; c.image_url = null; }));
      }
    } catch (e) {
      setError(errorText(e));
    }
  };

  /** A reason why the post is useful (or vague), on or off. */
  const rate = async (reason: Reason) => {
    const p = post.p;
    if (!p) return;
    if (!me()) return opts.onNeedSignIn();
    try {
      const r = await api.rate(p.id, reason, !ratings().mine.includes(reason));
      setRatings({ reasons: r.reasons, mine: r.mine });
      setPost("p", produce((x) => { if (x) { x.useful_count = r.useful_count; x.flag_count = r.flag_count; } }));
      changed();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const useful = async (c: Comment) => {
    if (!me()) return opts.onNeedSignIn();
    try {
      const r = await api.useful(c.id, !c.my_useful);
      setComments("list", (x) => x.id === c.id, produce((x) => { x.useful_count = r.useful_count; x.my_useful = r.my_useful; }));
    } catch (e) {
      setError(errorText(e));
    }
  };

  /** The asker marks (or unmarks) the reply that answers the question. */
  const markAnswer = async (c: Comment) => {
    try {
      const r = await api.markAnswer(post.p!.id, post.p!.answer_id === c.id ? null : c.id);
      setPost("p", "answer_id", r.answer_id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  /** A moderator's remove, restore, lock or unlock; the post is fetched again. */
  const moderate = async (action: string, type: "post" | "comment", id: string, reason = "") => {
    await api.modAction(action, type, id, reason);
    setOpen(null);
    changed();
    await refetch();
  };

  /** A moderator bans the author from this community (#209). */
  const banAuthor = async (name: string, days: number, reason: string) => {
    await api.communityBan(post.p!.community.id, name, true, days, reason);
    setOpen(null);
  };

  return {
    data, refetch,
    post, setPost, comments, setComments, addReply, ratings, isMod,
    error, setError, open, setOpen, draft, setDraft, kind, setKind, busy, setBusy,
    needUser, toggle,
    send, saveEdit, remove, rate, useful, markAnswer, moderate, banAuthor,
  };
}
