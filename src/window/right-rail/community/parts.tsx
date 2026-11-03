/*
 * Pieces shared by the Community panel's views: votes, ages, the rendered
 * text, the report and reason forms, the sign-in box.
 */
import { For, Show, createSignal } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "../../../components/Icon";
import { renderMarkdown } from "../../../data/community/markdown";
import { api, CommunityError, type ReportReason } from "../../../data/community/api";
import { me, signIn, cancelSignIn, signingIn, PROVIDER_LABELS } from "../../../data/community/session";

export const RULES_URL = "https://opentrader.markets/community-rules.html";
export const TERMS_URL = "https://opentrader.markets/terms.html";
export const CONTACT_URL = "https://community.opentrader.markets/contact";

export function errorText(e: unknown): string {
  if (e instanceof CommunityError || e instanceof Error) return e.message;
  return String(e);
}

const pad = (n: number) => String(n).padStart(2, "0");
export function fullDate(sec: number): string {
  const d = new Date(sec * 1000);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "5m", "3h", "2d"; the date past a month. */
export function age(sec: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor(nowMs / 1000) - sec);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return fullDate(sec).slice(0, 10);
}

export function Age(props: { at: number }) {
  return <span title={fullDate(props.at)}>{age(props.at)}</span>;
}

export function Author(props: { name: string | null }) {
  return <span class={"cm-author" + (props.name ? "" : " is-deleted")}>{props.name ?? "[deleted]"}</span>;
}

/** Opens the text's links in the browser instead of the app's window. */
function onLinkClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a[data-external]") as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  void openUrl(a.href).catch((err) => console.warn("[community] link not opened", err));
}

export function MarkdownBody(props: { text: string; class?: string }) {
  return <div class={"cm-markdown " + (props.class ?? "")} innerHTML={renderMarkdown(props.text)} onClick={onLinkClick} />;
}

export function ExternalLink(props: { href: string; children: any }) {
  return (
    <a class="cm-link" href={props.href} onClick={(e) => { e.preventDefault(); void openUrl(props.href); }}>
      {props.children}
    </a>
  );
}

/** Up / score / down. `onNeedSignIn` when signed out. */
export function Vote(props: {
  type: "post" | "comment";
  id: string;
  score: number;
  myVote: number;
  disabled?: boolean;
  vertical?: boolean;
  onChange: (score: number, myVote: number) => void;
  onNeedSignIn: () => void;
  onError: (msg: string) => void;
}) {
  const cast = async (e: MouseEvent, value: number) => {
    e.stopPropagation();
    if (props.disabled) return;
    if (!me()) return props.onNeedSignIn();
    const next = props.myVote === value ? 0 : value;
    const before = { score: props.score, my: props.myVote };
    // Shown at once, put back if the server refuses.
    props.onChange(props.score + next - props.myVote, next);
    try {
      const r = await api.vote(props.type, props.id, next);
      props.onChange(r.score, r.my_vote);
    } catch (err) {
      props.onChange(before.score, before.my);
      props.onError(errorText(err));
    }
  };
  return (
    <div class={"cm-vote" + (props.vertical ? " is-vertical" : "")} onClick={(e) => e.stopPropagation()}>
      <button type="button" class={"cm-vote-btn is-up" + (props.myVote > 0 ? " is-on" : "")} aria-label="Upvote" aria-pressed={props.myVote > 0} onClick={(e) => cast(e, 1)}>
        <Icon name="community-up" size={18} />
      </button>
      <span class={"cm-score" + (props.myVote > 0 ? " is-up" : props.myVote < 0 ? " is-down" : "")}>{props.score}</span>
      <button type="button" class={"cm-vote-btn is-down" + (props.myVote < 0 ? " is-on" : "")} aria-label="Downvote" aria-pressed={props.myVote < 0} onClick={(e) => cast(e, -1)}>
        <Icon name="community-down" size={18} />
      </button>
    </div>
  );
}

export function ErrorBanner(props: { text: string | null; onClose?: () => void }) {
  return (
    <Show when={props.text}>
      <div class="cm-error" role="alert">
        <span>{props.text}</span>
        <Show when={props.onClose}>
          <button type="button" class="cm-error-close" aria-label="Close" onClick={() => props.onClose?.()}>×</button>
        </Show>
      </div>
    </Show>
  );
}

const REASONS: { id: ReportReason; label: string }[] = [
  { id: "spam", label: "Spam or advertising" },
  { id: "manipulation", label: "Market manipulation (pump and dump)" },
  { id: "harassment", label: "Harassment or hate" },
  { id: "illegal", label: "Illegal content" },
  { id: "other", label: "Other" },
];

export function ReportForm(props: { type: "post" | "comment"; id: string; onDone: (sent: boolean) => void }) {
  const [reason, setReason] = createSignal<ReportReason | null>(null);
  const [details, setDetails] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const send = async () => {
    const r = reason();
    if (!r) return setError("Pick a reason.");
    setBusy(true);
    try {
      await api.report(props.type, props.id, r, details());
      props.onDone(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="cm-form" onClick={(e) => e.stopPropagation()}>
      <div class="cm-form-title">Report this {props.type}</div>
      <For each={REASONS}>
        {(r) => (
          <label class="cm-radio">
            <input type="radio" name={`report-${props.id}`} checked={reason() === r.id} onChange={() => setReason(r.id)} />
            <span>{r.label}</span>
          </label>
        )}
      </For>
      <textarea class="cm-textarea is-small" placeholder="Details for the moderators (optional)" maxLength={1000} value={details()} onInput={(e) => setDetails(e.currentTarget.value)} />
      <ErrorBanner text={error()} />
      <div class="cm-form-actions">
        <button type="button" class="cm-btn" onClick={() => props.onDone(false)}>Cancel</button>
        <button type="button" class="cm-btn is-primary" disabled={busy()} onClick={send}>Send report</button>
      </div>
    </div>
  );
}

/** A moderator's reason (shown to the author). */
export function ReasonForm(props: {
  title: string;
  action: string;
  danger?: boolean;
  /** Field hint (default: a moderator's reason). */
  placeholder?: string;
  /** Required error text (default: a moderator's reason). */
  required?: string;
  onSubmit: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const submit = async () => {
    if (!reason().trim()) return setError(props.required ?? "Give a reason: it is shown to the author.");
    setBusy(true);
    try {
      await props.onSubmit(reason().trim());
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <div class="cm-form" onClick={(e) => e.stopPropagation()}>
      <div class="cm-form-title">{props.title}</div>
      <input class="cm-input" placeholder={props.placeholder ?? "Reason, shown to the author"} maxLength={500} value={reason()} onInput={(e) => setReason(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      <ErrorBanner text={error()} />
      <div class="cm-form-actions">
        <button type="button" class="cm-btn" onClick={() => props.onCancel()}>Cancel</button>
        <button type="button" class={"cm-btn " + (props.danger ? "is-danger" : "is-primary")} disabled={busy()} onClick={submit}>{props.action}</button>
      </div>
    </div>
  );
}

export function SignInBox(props: { providers: string[] | null; error: string | null; onSignedIn: () => void; onError: (msg: string | null) => void }) {
  const go = async (p: string) => {
    props.onError(null);
    try {
      await signIn(p);
      props.onSignedIn();
    } catch (e) {
      const msg = errorText(e);
      if (msg !== "cancelled") props.onError(msg);
    }
  };
  return (
    <div class="cm-signin">
      <div class="cm-signin-title">Sign in to Community</div>
      <p class="cm-muted">Use an account you already have. Community keeps only a user name, never your e-mail address or a password.</p>
      <p class="cm-muted">
        By signing in you accept the <ExternalLink href={TERMS_URL}>terms of use</ExternalLink> and the{" "}
        <ExternalLink href={RULES_URL}>community rules</ExternalLink>.
      </p>
      <Show
        when={!signingIn()}
        fallback={
          <div class="cm-signin-wait">
            <p>Finish signing in in your browser…</p>
            <button type="button" class="cm-btn" onClick={cancelSignIn}>Cancel</button>
          </div>
        }
      >
        <Show when={props.providers} fallback={<p class="cm-muted">Loading…</p>}>
          <Show when={props.providers!.length} fallback={<p class="cm-muted">Sign-in is not available right now.</p>}>
            <For each={props.providers!}>
              {(p) => (
                <button type="button" class="cm-btn is-provider" onClick={() => go(p)}>
                  Continue with {PROVIDER_LABELS[p] ?? p}
                </button>
              )}
            </For>
          </Show>
        </Show>
      </Show>
      <ErrorBanner text={props.error} />
    </div>
  );
}
