/*
 * Pieces shared by the Community panel's views: ages, the post's type and
 * an idea's levels and state, the rendered text, the report and reason
 * forms, the sign-in box.
 */
import { For, Show, createSignal } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "../../../components/Icon";
import { renderMarkdown } from "../../../data/community/markdown";
import { chartBridge } from "../../../data/community/chart-share";
import { cancelCheck, checkError, openCheck, pending as checkPending, waiting as checkWaiting } from "../../../data/community/posting-check";
import { api, CommunityError, type Idea, type Post, type ReportReason } from "../../../data/community/api";
import { TYPE_LABEL, ideaState, postState, price, recordLine, day } from "../../../data/community/format";
import { signIn, cancelSignIn, signingIn, PROVIDER_LABELS } from "../../../data/community/session";

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
  const mention = (e.target as HTMLElement).closest("a[data-ticker]") as HTMLAnchorElement | null;
  if (mention) {
    e.preventDefault();
    const ticker = mention.dataset.ticker!;
    const bridge = chartBridge();
    // The app: the chart shows it (the panel follows when it follows the chart). The website: its community.
    if (bridge) void bridge.showSymbol(ticker).catch((err) => console.warn("[community] symbol not shown", err));
    else {
      history.pushState(null, "", `/t/${encodeURIComponent(ticker)}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    return;
  }
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

/** The post's type ("Idea", "Analysis"…) and an idea's direction. */
export function TypeBadges(props: { post: Post }) {
  return (
    <>
      <span class={`cm-type is-${props.post.type}`}>{TYPE_LABEL[props.post.type]}</span>
      <Show when={props.post.idea}><span class="cm-type is-dir">{props.post.idea!.direction === "long" ? "Long" : "Short"}</span></Show>
    </>
  );
}

/** A post's status: an idea's state, an answered question, a post-mortem's idea. */
export function PostState(props: { post: Post }) {
  const st = () => postState(props.post);
  return <Show when={st()}><span class="cm-state" style={{ color: st()!.color }}>{st()!.text}</span></Show>;
}

/** An idea's levels in a line: "E 148.20 · S 141.00 · T 165.00 · R:R 2.3 · until 15/12/2026". */
export function IdeaLevels(props: { idea: Idea }) {
  const i = () => props.idea;
  const st = () => ideaState(i());
  return (
    <div class="cm-idea">
      <div class="cm-idea-levels">
        E {price(i().entry)} · S {price(i().stop)} · T {price(i().target)} · R:R {i().reward_risk.toFixed(1)} · until {day(i().expires)}
      </div>
      <div class="cm-idea-state">
        <span style={{ color: st().color }}>{st().text}</span>
        <Show when={i().last_price != null && (i().status === "open" || i().status === "pending")}><span class="cm-muted"> · last {price(i().last_price)}</span></Show>
        <span class="cm-muted"> · levels locked at posting</span>
      </div>
    </div>
  );
}

/** "34 ideas · 62% hit" after an author's name. */
export function AuthorRecord(props: { post: Post }) {
  return <Show when={!props.post.author_bot && props.post.author_record}><span class="cm-muted">{recordLine(props.post.author_record)}</span></Show>;
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
                  <Show when={p !== "dev"}><Icon name={`signin-${p}`} size={18} class="cm-provider-logo" /></Show>
                  <span>Continue with {PROVIDER_LABELS[p] ?? p}</span>
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

/** The bot check before a first post (#219): shown while a post waits for it. */
export function PostingCheckPrompt() {
  return (
    <Show when={checkPending()}>
      <div class="cm-check" role="alert">
        <div class="cm-form-title">One quick check before your first post</div>
        <p class="cm-muted">Confirm in your browser that you're not a robot. Your post is sent as soon as it's done.</p>
        <Show when={checkWaiting()} fallback={<button type="button" class="cm-btn is-primary is-small" onClick={() => void openCheck()}>Open the check</button>}>
          <p class="cm-muted">Waiting for the check in your browser…</p>
        </Show>
        <ErrorBanner text={checkError()} />
        <div class="cm-form-actions">
          <button type="button" class="cm-btn is-small" onClick={cancelCheck}>Cancel</button>
        </div>
      </div>
    </Show>
  );
}

const BAN_DAYS = [
  { days: 1, label: "1 day" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 0, label: "Permanently" },
];

/** A moderator bans a member from the community (#209). */
export function BanForm(props: { name: string; communityTitle: string; onSubmit: (days: number, reason: string) => Promise<void>; onCancel: () => void }) {
  const [days, setDays] = createSignal(7);
  const [reason, setReason] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const submit = async () => {
    if (!reason().trim()) return setError("Give a reason: it is shown to the member.");
    setBusy(true);
    try {
      await props.onSubmit(days(), reason().trim());
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <div class="cm-form" onClick={(e) => e.stopPropagation()}>
      <div class="cm-form-title">Ban {props.name} from {props.communityTitle}</div>
      <select class="cm-input" value={String(days())} onChange={(e) => setDays(Number(e.currentTarget.value))}>
        <For each={BAN_DAYS}>{(d) => <option value={String(d.days)}>{d.label}</option>}</For>
      </select>
      <input class="cm-input" placeholder="Reason, shown to the member" maxLength={500} value={reason()} onInput={(e) => setReason(e.currentTarget.value)} />
      <ErrorBanner text={error()} />
      <div class="cm-form-actions">
        <button type="button" class="cm-btn" onClick={() => props.onCancel()}>Cancel</button>
        <button type="button" class="cm-btn is-danger" disabled={busy()} onClick={submit}>Ban</button>
      </div>
    </div>
  );
}

/** "bot" next to the automatic threads' author. */
export function BotBadge(props: { show?: boolean }) {
  return <Show when={props.show}><span class="cm-badge cm-bot-badge" title="Posted automatically">bot</span></Show>;
}
