/*
 * Community panel views opened from its menu and its community header:
 *   - NotificationsView (#208): replies and decisions, newest first;
 *   - AboutView (#209): a community's description, moderators, public
 *     moderation log; its moderators see the banned members (unban),
 *     administrators appoint or remove moderators;
 *   - AccountView: the user name, the profile line, sign-out, account deletion.
 */
import { For, Show, createResource, createSignal, onMount } from "solid-js";
import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/IconButton";
import { api, type Community, type LogEntry, type Notice } from "../../../data/community/api";
import { markAllRead, refreshNotifications } from "../../../data/community/notifications";
import { deleteAccount, me, refreshMe, signOut } from "../../../data/community/session";
import { showConfirm } from "../../../components/Dialogs";
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

export function AccountView(props: { onBack: () => void }) {
  const [name, setName] = createSignal(me()?.user.name ?? "");
  const [bio, setBio] = createSignal(me()?.user.bio ?? "");
  const saveBio = async () => {
    setErr(null);
    setMsg(null);
    try {
      await api.updateMe({ bio: bio() });
      await refreshMe();
      setMsg("Profile line saved.");
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const [msg, setMsg] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const save = async () => {
    setErr(null);
    setMsg(null);
    try {
      await api.rename(name().trim());
      await refreshMe();
      setMsg("Name saved.");
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const remove = () =>
    showConfirm({
      title: "Delete account",
      text: "Delete your Community account? Your posts and replies are emptied, your ratings, snapshots and tickers removed. This can't be undone.",
      mainText: "Delete account",
      cancelText: "Cancel",
      intent: "danger",
      onConfirm: async () => {
        try {
          await deleteAccount();
          props.onBack();
        } catch (e) {
          setErr(errorText(e));
        }
      },
    });
  return (
    <Frame title="Account" onBack={props.onBack}>
      <div class="cm-composer">
        <Show when={me()} fallback={<div class="ot-empty-state">Signed out.</div>}>
          <Show when={me()!.user.banned_until && me()!.user.banned_until! > Date.now() / 1000}>
            <div class="cm-removed">Your account is banned. Reason: {me()!.user.ban_reason || "not given"}</div>
          </Show>
          <label class="cm-label">User name</label>
          <input class="cm-input" maxLength={20} value={name()} onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
          <div class="cm-muted cm-hint">3 to 20 letters, digits, - or _.</div>
          <label class="cm-label">Profile line</label>
          <input class="cm-input" maxLength={160} placeholder="US stocks · swing trades, 2–8 weeks · breakouts" value={bio()} onInput={(e) => setBio(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && saveBio()} />
          <div class="cm-muted cm-hint">Shown on your profile, under your name: what you trade and how.</div>
          <div class="cm-form-actions">
            <button type="button" class="cm-btn" disabled={bio().trim() === (me()!.user.bio ?? "")} onClick={saveBio}>Save profile line</button>
          </div>
          <ErrorBanner text={err()} />
          <Show when={msg()}><div class="cm-muted">{msg()}</div></Show>
          <div class="cm-form-actions">
            <button type="button" class="cm-btn is-primary" disabled={name().trim() === me()!.user.name} onClick={save}>Save name</button>
          </div>
          <div class="cm-muted cm-hint">Member since <Age at={me()!.user.created_at} />.</div>
          <div class="cm-form-actions is-spread">
            <button type="button" class="cm-btn" onClick={() => { void signOut(); props.onBack(); }}>Sign out</button>
            <button type="button" class="cm-btn is-danger" onClick={remove}>Delete account</button>
          </div>
        </Show>
      </div>
    </Frame>
  );
}
