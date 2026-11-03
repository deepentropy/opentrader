/*
 * Moderation queue: reported posts and comments of the communities the user
 * moderates, oldest first. Remove (with a reason shown to the author),
 * dismiss the reports, or open the post. Authors' appeals against a removal
 * come here too (restore settles them). Administrators also read the
 * messages of the website's contact form and decide the community
 * proposals (#209).
 */
import { For, Show, createResource, createSignal } from "solid-js";
import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/IconButton";
import { api, type ContactMessage, type QueueItem } from "../../../data/community/api";
import { me } from "../../../data/community/session";
import { Age, Author, ErrorBanner, ReasonForm, errorText } from "./parts";

const REASON_LABELS: Record<string, string> = {
  spam: "Spam",
  manipulation: "Market manipulation",
  harassment: "Harassment",
  illegal: "Illegal content",
  other: "Other",
  appeal: "Appeal by the author",
};

const MESSAGE_LABELS: Record<string, string> = {
  illegal: "Illegal content",
  appeal: "Appeal",
  authority: "Authority request",
  other: "Other",
};

export function ModQueue(props: { onBack: () => void; onOpenPost: (id: string) => void }) {
  const [queue, { refetch }] = createResource(() => api.queue());
  const [removing, setRemoving] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const isAdmin = () => me()?.moderates === "all";
  const [inbox, { refetch: refetchInbox }] = createResource(
    () => (isAdmin() ? "admin" : null),
    () => api.messages().then((r) => r.messages).catch(() => [] as ContactMessage[]),
  );
  const handled = async (m: ContactMessage) => {
    try {
      await api.messageDone(m.id);
      await refetchInbox();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const act = async (item: QueueItem, action: string, reason = "") => {
    try {
      await api.modAction(action, item.target_type, item.target_id, reason);
      setRemoving(null);
      await refetch();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div class="cm-post-view">
      <div class="cm-subheader">
        <IconButton aria-label="Back" onClick={() => props.onBack()}><Icon name="community-back" size={28} /></IconButton>
        <span class="cm-subheader-title is-static">Moderation queue</span>
      </div>
      <div class="cm-scroll">
        <ErrorBanner text={error()} onClose={() => setError(null)} />
        <Show when={isAdmin() && (inbox() ?? []).length}>
          <div class="cm-picker-section">Contact messages</div>
          <For each={inbox()}>
            {(m) => (
              <div class="cm-queue-item">
                <div class="cm-meta">
                  <span class="cm-badge">{MESSAGE_LABELS[m.kind] ?? m.kind}</span>
                  <Age at={m.created_at} />
                  <Show when={m.user_name}><span class="cm-dot">·</span><Author name={m.user_name} /></Show>
                </div>
                <div class="cm-queue-body">{m.body}</div>
                <Show when={m.url}><div class="cm-meta">Link: {m.url}</div></Show>
                <Show when={m.email}><div class="cm-meta">Reply to: {m.email}</div></Show>
                <div class="cm-actions">
                  <button type="button" class="cm-action" onClick={() => handled(m)}>Mark handled</button>
                </div>
              </div>
            )}
          </For>
          <div class="cm-picker-section">Reports</div>
        </Show>
        <Show when={!queue.error} fallback={<div class="ot-empty-state">{errorText(queue.error)}</div>}>
          <Show when={queue()} fallback={<div class="ot-empty-state">Loading…</div>}>
            <For each={queue()!.items} fallback={<div class="ot-empty-state">Nothing to review.</div>}>
              {(item) => (
                <div class="cm-queue-item">
                  <div class="cm-meta">
                    <span class="cm-badge">{item.target_type}</span>
                    <span>{item.community_id.replace(/^t:/, "$").replace(/^c:/, "")}</span>
                    <span class="cm-dot">·</span>
                    <span>{item.reports} report{item.reports > 1 ? "s" : ""}</span>
                    <span class="cm-dot">·</span>
                    <Age at={item.first_at} />
                  </div>
                  <Show when={item.content} fallback={<div class="cm-muted">Content no longer exists.</div>}>
                    <Show when={item.content!.title}><div class="cm-post-title">{item.content!.title}</div></Show>
                    <div class="cm-queue-body">{item.content!.body.slice(0, 400) || "(no text)"}</div>
                    <div class="cm-meta">by <Author name={item.content!.author} /><Show when={item.content!.removed}><span class="cm-badge is-danger">Removed</span></Show></div>
                  </Show>
                  <ul class="cm-queue-reasons">
                    <For each={item.reasons}>
                      {(r) => (
                        <li><strong>{REASON_LABELS[r.reason] ?? r.reason}</strong><Show when={r.details}>: {r.details}</Show></li>
                      )}
                    </For>
                  </ul>
                  <Show
                    when={removing() === item.target_id}
                    fallback={
                      <div class="cm-actions">
                        <button type="button" class="cm-action is-mod" onClick={() => setRemoving(item.target_id)}>Remove</button>
                        <button type="button" class="cm-action" onClick={() => act(item, "dismiss")}>Dismiss</button>
                        <button type="button" class="cm-action" onClick={() => props.onOpenPost(item.target_type === "post" ? item.target_id : item.content?.post_id ?? "")}>Open</button>
                      </div>
                    }
                  >
                    <ReasonForm title={`Remove this ${item.target_type}`} action="Remove" danger onCancel={() => setRemoving(null)} onSubmit={(r) => act(item, "remove", r)} />
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
}
