/*
 * Community panel views opened from its menu and its community header:
 *   - NotificationsView (#208): replies and decisions, newest first;
 *   - AboutView (#209): a community's description, moderators, public
 *     moderation log; its moderators see the banned members (unban),
 *     administrators appoint or remove moderators;
 *   - ProposeView (#209): a member proposes a theme community.
 */
import { For, Show, createResource, createSignal, onMount } from "solid-js";
import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/IconButton";
import { api, type Community, type LogEntry, type Notice } from "../../../data/community/api";
import { markAllRead, refreshNotifications } from "../../../data/community/notifications";
import { me } from "../../../data/community/session";
import { noticeTitle } from "./CommunityNotifier";
import { Age, ErrorBanner, errorText, fullDate } from "./parts";

function Frame(props: { title: string; onBack: () => void; children: any }) {
  return (
    <div class="cm-post-view">
      <div class="cm-subheader">
        <IconButton aria-label="Back" onClick={() => props.onBack()}><Icon name="community-back" size={28} /></IconButton>
        <span class="cm-subheader-title is-static">{props.title}</span>
      </div>
      <div class="cm-scroll">{props.children}</div>
    </div>
  );
}

export function NotificationsView(props: { onBack: () => void; onOpenPost: (id: string) => void }) {
  const [list] = createResource(() => api.notifications().then((r) => r.notifications));
  // Seen: the count goes, the lines keep their "new" mark until the next visit.
  onMount(() => void markAllRead().then(refreshNotifications));
  return (
    <Frame title="Notifications" onBack={props.onBack}>
      <Show when={!list.error} fallback={<div class="ot-empty-state">{errorText(list.error)}</div>}>
        <Show when={list()} fallback={<div class="ot-empty-state">Loading…</div>}>
          <For each={list()!} fallback={<div class="ot-empty-state">No notifications yet.</div>}>
            {(n: Notice) => (
              <div
                class={"cm-notice" + (n.read_at ? "" : " is-new") + (n.post_id ? " is-link" : "")}
                role={n.post_id ? "button" : undefined}
                onClick={() => n.post_id && props.onOpenPost(n.post_id)}
              >
                <div class="cm-meta">
                  <strong class="cm-author">{noticeTitle(n)}</strong>
                  <span class="cm-dot">·</span>
                  <Age at={n.created_at} />
                </div>
                <Show when={n.text}><div class="cm-notice-text">{n.text}</div></Show>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </Frame>
  );
}

const ACTION_LABELS: Record<string, string> = {
  remove: "Removed",
  restore: "Restored",
  lock: "Locked",
  unlock: "Unlocked",
  ban: "Member banned",
  unban: "Ban lifted",
};

export function AboutView(props: { community: Community; onBack: () => void; onOpenPost: (id: string) => void }) {
  const id = () => props.community.id;
  const [mods, { refetch: refetchMods }] = createResource(id, (c) => api.moderators(c).then((r) => r.moderators));
  const [log] = createResource(id, (c) => api.communityLog(c).then((r) => r.actions));
  const [bans, { refetch: refetchBans }] = createResource(
    () => (props.community.is_mod ? id() : null),
    (c) => api.bans(c).then((r) => r.bans),
  );
  const isAdmin = () => me()?.moderates === "all";
  const [modName, setModName] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const act = async (fn: () => Promise<unknown>, then: () => unknown) => {
    setError(null);
    try {
      await fn();
      then();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Frame title={`About ${props.community.title}`} onBack={props.onBack}>
      <div class="cm-about">
        <Show when={props.community.description}><p>{props.community.description}</p></Show>
        <ErrorBanner text={error()} onClose={() => setError(null)} />
        <div class="cm-picker-section">Moderators</div>
        <div class="cm-about-block">
          <For each={mods() ?? []} fallback={<span class="cm-muted">The administrators moderate this community.</span>}>
            {(name) => (
              <div class="cm-about-row">
                <span class="cm-author">{name}</span>
                <Show when={isAdmin()}>
                  <button type="button" class="cm-action" onClick={() => act(() => api.setModerator(id(), name, false), refetchMods)}>Remove</button>
                </Show>
              </div>
            )}
          </For>
          <Show when={isAdmin()}>
            <div class="cm-about-row">
              <input class="cm-input" placeholder="User name" maxLength={20} value={modName()} onInput={(e) => setModName(e.currentTarget.value)} />
              <button
                type="button"
                class="cm-btn is-small is-primary"
                disabled={!modName().trim()}
                onClick={() => act(() => api.setModerator(id(), modName().trim(), true), () => { setModName(""); void refetchMods(); })}
              >
                Appoint
              </button>
            </div>
          </Show>
        </div>
        <Show when={props.community.is_mod}>
          <div class="cm-picker-section">Banned members</div>
          <div class="cm-about-block">
            <For each={bans() ?? []} fallback={<span class="cm-muted">Nobody is banned.</span>}>
              {(b) => (
                <div class="cm-about-row">
                  <span>
                    <span class="cm-author">{b.name}</span>
                    <span class="cm-muted"> · {b.until > 4_000_000_000 ? "permanent" : `until ${fullDate(b.until).slice(0, 10)}`} · {b.reason}</span>
                  </span>
                  <button type="button" class="cm-action" onClick={() => act(() => api.communityBan(id(), b.name, false), refetchBans)}>Unban</button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <div class="cm-picker-section">Moderation log</div>
        <div class="cm-about-block">
          <For each={log() ?? []} fallback={<span class="cm-muted">No moderation decisions yet.</span>}>
            {(a: LogEntry) => (
              <div class="cm-log-row">
                <div class="cm-meta">
                  <strong>{ACTION_LABELS[a.action] ?? a.action}</strong>
                  <span class="cm-dot">·</span>
                  <span>{a.target_type === "user" ? "a member" : a.target_type}</span>
                  <span class="cm-dot">·</span>
                  <Age at={a.created_at} />
                </div>
                <Show when={a.post_title}>
                  <button type="button" class="cm-community-link" onClick={() => a.post_id && props.onOpenPost(a.post_id)}>{a.post_title}</button>
                </Show>
                <Show when={a.reason}><div class="cm-muted">{a.reason}</div></Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </Frame>
  );
}

const slugOf = (title: string) => title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 41);

export function ProposeView(props: { onBack: () => void }) {
  const [title, setTitle] = createSignal("");
  const [slug, setSlug] = createSignal("");
  const [slugEdited, setSlugEdited] = createSignal(false);
  const [description, setDescription] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [sent, setSent] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.propose(slug(), title().trim(), description().trim());
      setSent(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Propose a community" onBack={props.onBack}>
      <div class="cm-composer">
        <Show
          when={!sent()}
          fallback={<p class="cm-muted">Proposal sent. An administrator looks at it; you get a notification with the answer. If it opens, you moderate it.</p>}
        >
          <p class="cm-muted">A theme community for a topic that fits none of the others. If an administrator approves it, you become its moderator.</p>
          <label class="cm-label">Name</label>
          <input
            class="cm-input"
            maxLength={40}
            value={title()}
            onInput={(e) => {
              setTitle(e.currentTarget.value);
              if (!slugEdited()) setSlug(slugOf(e.currentTarget.value));
            }}
          />
          <label class="cm-label">Address</label>
          <input class="cm-input" maxLength={41} value={slug()} onInput={(e) => { setSlugEdited(true); setSlug(e.currentTarget.value.toLowerCase()); }} />
          <div class="cm-muted cm-hint">community.opentrader.markets/c/{slug() || "…"}</div>
          <label class="cm-label">What it is about</label>
          <textarea class="cm-textarea" maxLength={300} value={description()} onInput={(e) => setDescription(e.currentTarget.value)} />
          <ErrorBanner text={error()} />
          <div class="cm-form-actions">
            <button type="button" class="cm-btn" onClick={() => props.onBack()}>Cancel</button>
            <button type="button" class="cm-btn is-primary" disabled={busy() || title().trim().length < 3 || slug().length < 2} onClick={send}>Send proposal</button>
          </div>
        </Show>
      </div>
    </Frame>
  );
}
