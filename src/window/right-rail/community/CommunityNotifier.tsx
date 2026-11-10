import { translate, translateWith } from "../../../i18n/translator";
/*
 * Community notifications outside the panel (#208): restores the session at
 * start, asks for new notifications every minute, and pops each new one up in
 * the bottom-right corner ("<name> replied to your post …"). A click opens it
 * in the Community panel. Mounted with the right rail, so it runs whether the
 * panel is open or not.
 */
import { For, Show, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { initSession } from "../../../data/community/session";
import { startDeepLinks } from "../../../data/community/deep-link";
import { dismissIncoming, incoming, requestOpenPost, startNotifications } from "../../../data/community/notifications";
import type { Notice } from "../../../data/community/api";

/** A pop-up leaves after this. */
const SHOW_MS = 12_000;

export function noticeTitle(n: Notice): string {
  switch (n.kind) {
    case "reply":
      return n.comment_id && n.post_title
        ? translateWith('{0} replied in "{1}"', n.actor ?? translate("Someone"), n.post_title)
        : translateWith("{0} replied to your post", n.actor ?? translate("Someone"));
    case "removed":
      return "Moderation decision";
    case "banned":
      return n.actor ? translateWith("Moderation in {0}", n.actor) : "Account";
    case "proposal":
      return n.actor ? translateWith("Community proposal: {0}", n.actor) : "Community proposal";
    case "idea":
      return n.actor ? translateWith("New idea from {0}", n.actor) : "New idea from a trader you follow";
    case "status":
      return "Suggestion update";
  }
}

export function CommunityNotifier(props: { openPanel: () => void }) {
  onMount(() => void initSession().then(startNotifications));
  // "Open in OpenTrader" links from the website (#233).
  let stopLinks: (() => void) | null = null;
  onMount(() => void startDeepLinks(props.openPanel).then((stop) => (stopLinks = stop), (e) => console.warn("[community] links not taken", e)));
  onCleanup(() => stopLinks?.());
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  onCleanup(() => timers.forEach((t) => clearTimeout(t)));
  const schedule = (n: Notice) => {
    if (!timers.has(n.id)) timers.set(n.id, setTimeout(() => dismissIncoming(n.id), SHOW_MS));
  };
  const open = (n: Notice) => {
    dismissIncoming(n.id);
    props.openPanel();
    if (n.post_id) requestOpenPost(n.post_id);
  };
  return (
    <Show when={incoming().length}>
      <Portal>
        <div class="cm-toasts" aria-live="polite">
          <For each={incoming()}>
            {(n) => {
              schedule(n);
              return (
                <div class="cm-toast" role="button" tabIndex={0} onClick={() => open(n)} onKeyDown={(e) => e.key === "Enter" && open(n)}>
                  <div class="cm-toast-title">{noticeTitle(n)}</div>
                  <Show when={n.text}><div class="cm-toast-text">{n.text}</div></Show>
                  <button type="button" class="cm-toast-close" aria-label="Close" onClick={(e) => { e.stopPropagation(); dismissIncoming(n.id); }}>×</button>
                </div>
              );
            }}
          </For>
        </div>
      </Portal>
    </Show>
  );
}
