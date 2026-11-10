/*
 * Contact and reports: the public contact point of the Community (EU Digital
 * Services Act, art. 11-12 and 16). Anyone, signed in or not, can report
 * illegal content, appeal a decision or write to the team; messages reach
 * the administrators' queue (POST /contact).
 */
import { For, Show, createSignal } from "solid-js";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/IconButton";
import { api, type ContactKind } from "../data/community/api";
import { ErrorBanner, errorText } from "../community-shared/parts";

const KINDS: { id: ContactKind; label: string }[] = [
  { id: "illegal", label: "Report illegal content" },
  { id: "appeal", label: "Appeal a moderation decision" },
  { id: "authority", label: "Request from an authority" },
  { id: "other", label: "Other question" },
];

export function ContactPage(props: { onBack: () => void }) {
  const [kind, setKind] = createSignal<ContactKind>("illegal");
  const [email, setEmail] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [body, setBody] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [sent, setSent] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.contact(kind(), email(), url(), body());
      setSent(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="ot-rail-panel cm-panel">
      <div class="cm-subheader">
        <IconButton aria-label="Back" onClick={() => props.onBack()}><Icon name="community-back" size={28} class="ot-flip-rtl" /></IconButton>
        <span class="cm-subheader-title is-static">Contact and reports</span>
      </div>
      <div class="cs-contact">
        <Show
          when={!sent()}
          fallback={
            <>
              <h1>Message sent</h1>
              <p>Thank you. The moderators read every message. If you gave an e-mail address, the answer goes there.</p>
              <button type="button" class="cm-btn" onClick={() => props.onBack()}>Back to the communities</button>
            </>
          }
        >
          <h1>Contact and reports</h1>
          <p>
            To report a post or comment, the quickest way is its <strong>Report</strong> button. Use this form to report illegal content, to
            appeal a moderation decision, or if you write on behalf of an authority. No account is needed.
          </p>
          <label class="cm-label">Subject</label>
          <For each={KINDS}>
            {(k) => (
              <label class="cm-radio">
                <input type="radio" name="contact-kind" checked={kind() === k.id} onChange={() => setKind(k.id)} />
                <span>{k.label}</span>
              </label>
            )}
          </For>
          <label class="cm-label">Link to the post or comment (if any)</label>
          <input class="cm-input" placeholder="https://community.opentrader.markets/p/…" maxLength={500} value={url()} onInput={(e) => setUrl(e.currentTarget.value)} />
          <label class="cm-label">Your e-mail address (to get an answer; optional)</label>
          <input class="cm-input" type="email" maxLength={200} value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
          <label class="cm-label">Message</label>
          <textarea
            class="cm-textarea is-tall"
            maxLength={5000}
            placeholder={kind() === "illegal" ? "Why the content is illegal, and under which law if you know it." : ""}
            value={body()}
            onInput={(e) => setBody(e.currentTarget.value)}
          />
          <div class="cm-muted cm-hint">Your e-mail address is used only to answer this message and is deleted with it.</div>
          <ErrorBanner text={error()} />
          <div class="cm-form-actions">
            <button type="button" class="cm-btn is-primary" disabled={busy() || body().trim().length < 10} onClick={send}>Send</button>
          </div>
        </Show>
      </div>
    </div>
  );
}
