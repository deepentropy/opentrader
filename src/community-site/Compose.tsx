/*
 * New post: what kind it is, the ticker (or General) and title; an idea's
 * levels (locked once posted), its reward:risk and trigger; the text; a
 * chart snapshot sent from the OpenTrader app. Right: what's still missing,
 * the post as the feed shows it, Post / Save draft. The draft is kept on
 * this device as it is written.
 */
import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js";
import { GENERAL, api, tickerCommunityId, type Direction, type PostType } from "../data/community/api";
import { me } from "../data/community/session";
import { withPostingCheck } from "../data/community/posting-check";
import * as kv from "../data/kv";
import { ErrorBanner, PostingCheckPrompt, errorText } from "../community-shared/parts";
import { ComposeBar } from "./TopBar";
import { SNAPSHOT_HOWTO, SnapshotPicker } from "./SnapshotPicker";
import { go, navigate } from "./router";
import { DirTag, Pills, TYPE_LABEL, TYPES, TypeTag, day, price, signInPath } from "./ui";

const DRAFT_KEY = "ot:community:draft";

const TYPE_HINT: Record<Exclude<PostType, "suggestion">, string> = {
  idea: "A trade with levels. Tracked to outcome.",
  analysis: "Data or a market read. No levels required.",
  question: "Ask the community. Can be marked answered.",
  postmortem: "Review a trade you took, win or loss.",
};

type Draft = {
  type: PostType;
  ticker: string;
  title: string;
  body: string;
  direction: Direction;
  entry: string;
  stop: string;
  target: string;
  expires: string;
  rule: "close" | "touch";
  linked: string;
  snapshot: string | null;
  savedAt: number | null;
};

const inWeeks = (n: number) => new Date(Date.now() + n * 7 * 86_400_000).toISOString().slice(0, 10);

function emptyDraft(to: string | null, type: string | null): Draft {
  const ticker = to === GENERAL ? "General" : to?.startsWith("t:") ? to.slice(2) : "";
  return {
    type: (TYPES as string[]).includes(type ?? "") ? (type as PostType) : "idea",
    ticker, title: "", body: "", direction: "long", entry: "", stop: "", target: "", expires: inWeeks(6), rule: "close", linked: "", snapshot: null, savedAt: null,
  };
}

function readDraft(): Draft | null {
  try {
    const d = JSON.parse(kv.getItem(DRAFT_KEY) ?? "null");
    return d && typeof d === "object" && d.type ? d : null;
  } catch {
    return null;
  }
}

const num = (s: string) => (s.trim() ? Number(s) : NaN);

export function Compose(props: { to: string | null; type: string | null }) {
  const saved = readDraft();
  // A draft for another ticker gives way to the page's ticker.
  const start = saved && (!props.to || tickerCommunityId(saved.ticker) === props.to || (props.to === GENERAL && saved.ticker === "General")) ? saved : emptyDraft(props.to, props.type);
  const [d, setD] = createSignal<Draft>(start);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [howto, setHowto] = createSignal(false);

  // Kept as it is written (a second after the last key).
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    const at = Date.now();
    kv.setItem(DRAFT_KEY, JSON.stringify({ ...d(), savedAt: at }));
    setD((x) => ({ ...x, savedAt: at }));
  };
  createEffect(on(() => { const { savedAt: _s, ...rest } = d(); return JSON.stringify(rest); }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 1000);
  }, { defer: true }));
  onCleanup(() => { if (timer) clearTimeout(timer); });
  const discard = () => {
    if (timer) clearTimeout(timer);
    kv.removeItem(DRAFT_KEY);
    if (history.length > 1) history.back();
    else navigate("/");
  };

  const community = () => {
    const t = d().ticker.trim().replace(/^\$/, "");
    if (!t || t.toLowerCase() === "general") return d().type === "idea" ? null : GENERAL;
    return tickerCommunityId(t);
  };
  const tickerLabel = () => (community() === GENERAL ? "General" : community()?.slice(2) ?? "");
  const lv = createMemo(() => {
    const x = d();
    const entry = num(x.entry), stop = num(x.stop), target = num(x.target);
    const ok = [entry, stop, target].every((v) => Number.isFinite(v) && v > 0) && (x.direction === "long" ? stop < entry && entry < target : target < entry && entry < stop);
    return { entry, stop, target, ok, rr: ok ? Math.abs(target - entry) / Math.abs(entry - stop) : null, risk: ok ? Math.abs(entry - stop) : null };
  });
  const isIdea = () => d().type === "idea";
  const words = (re: RegExp) => re.test(d().body);
  const checks = createMemo(() => {
    const list: { l: string; ok: boolean; optional?: boolean }[] = [{ l: "Type selected", ok: true }];
    if (isIdea()) {
      list.push(
        { l: "Entry, stop and target set", ok: lv().ok },
        { l: "Chart attached", ok: !!d().snapshot },
        { l: "Thesis explains the trigger", ok: d().body.trim().length >= 40 && words(/trigger|close|break|entry|above|below/i) },
        { l: "Risk section — say how you size", ok: words(/risk|siz(e|ing)|position|% of/i) },
      );
    } else {
      list.push(
        { l: "Ticker, or General", ok: !!community() },
        { l: "Title states the subject", ok: d().title.trim().length >= 10 },
        { l: d().type === "question" ? "Say what you tried or read" : "Text explains the why", ok: d().body.trim().length >= 40 },
        { l: "Chart attached", ok: !!d().snapshot, optional: true },
      );
    }
    return list;
  });
  const ready = () => !!community() && d().title.trim().length >= 3 && (!isIdea() || (lv().ok && !!d().expires));

  const [myIdeas] = createResource(
    () => (d().type === "postmortem" && me() ? me()!.user.name : null),
    (name) => api.userPosts(name, "idea", 0, 50).then((r) => r.posts).catch(() => []),
  );

  const post = async () => {
    const to = community();
    if (!to) return setError(isIdea() ? "An idea is on a ticker, like NVDA." : "Type a ticker, like NVDA, or General.");
    setBusy(true);
    setError(null);
    try {
      const x = d();
      const r = await withPostingCheck(() =>
        api.createPost(to, {
          type: x.type,
          title: x.title,
          body: x.body,
          idea: isIdea() ? { direction: x.direction, entry: lv().entry, stop: lv().stop, target: lv().target, expires: x.expires, entry_rule: x.rule } : undefined,
          linked_id: x.type === "postmortem" ? x.linked || null : null,
          attach: x.snapshot ? { snapshotId: x.snapshot } : null,
        }),
      );
      if (timer) clearTimeout(timer);
      kv.removeItem(DRAFT_KEY);
      navigate(`/p/${r.post.id}`, { replace: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const n = (k: number) => (isIdea() ? k : k - 1);
  const Field = (fp: { label: string; children: any; class?: string }) => (
    <div class={"cs-field " + (fp.class ?? "")}>
      <label>{fp.label}</label>
      {fp.children}
    </div>
  );

  return (
    <>
      <ComposeBar savedAt={d().savedAt} onDiscard={discard} />
      <Show
        when={me()}
        fallback={
          <div class="cs-page-msg">
            <p>Sign in to write a post.</p>
            <a class="cs-btn is-primary" href={signInPath()} onClick={go(signInPath())}>Sign in</a>
          </div>
        }
      >
        <div class="cs-grid is-compose">
          <main id="cs-main" class="cs-center is-compose">
            <h2>New post</h2>
            <div>
              <div class="cs-step">1 · What kind of post is this?</div>
              <div class="cs-types" role="radiogroup" aria-label="Kind of post">
                <For each={TYPES}>
                  {(t) => (
                    <button type="button" role="radio" aria-checked={d().type === t} class={d().type === t ? "is-on" : ""} onClick={() => set("type", t)}>
                      <div class="cs-types-l">{TYPE_LABEL[t]}</div>
                      <div class="cs-types-d">{TYPE_HINT[t]}</div>
                    </button>
                  )}
                </For>
              </div>
            </div>
            <div class="cs-two">
              <Field label="Ticker">
                <input class="cs-input is-strong" value={d().ticker} placeholder={isIdea() ? "NVDA" : "NVDA or General"} maxLength={16} onInput={(e) => set("ticker", e.currentTarget.value.toUpperCase().replace(/^GENERAL$/, "General"))} />
              </Field>
              <Field label="Title — state the setup, not the hype">
                <input class="cs-input" value={d().title} maxLength={300} onInput={(e) => set("title", e.currentTarget.value)} />
              </Field>
            </div>

            <Show when={isIdea()}>
              <div>
                <div class="cs-step">2 · Levels — required for ideas, locked after posting</div>
                <div class="cs-levels-form">
                  <Field label="Direction">
                    <Pills items={[{ id: "long", label: "Long" }, { id: "short", label: "Short" }]} value={d().direction} onChange={(v) => set("direction", v as Direction)} label="Direction" />
                  </Field>
                  <Field label="Entry"><input class="cs-input" inputMode="decimal" value={d().entry} onInput={(e) => set("entry", e.currentTarget.value)} /></Field>
                  <Field label="Stop"><input class="cs-input" inputMode="decimal" value={d().stop} onInput={(e) => set("stop", e.currentTarget.value)} /></Field>
                  <Field label="Target"><input class="cs-input" inputMode="decimal" value={d().target} onInput={(e) => set("target", e.currentTarget.value)} /></Field>
                  <Field label="Expires"><input class="cs-input" type="date" value={d().expires} onInput={(e) => set("expires", e.currentTarget.value)} /></Field>
                </div>
                <div class="cs-rr">
                  Reward : risk <strong>{lv().rr == null ? "—" : lv().rr!.toFixed(1)}</strong> · Risk per share {lv().risk == null ? "—" : price(lv().risk)} · Trigger:{" "}
                  <strong>{d().rule === "close" ? "daily close" : "a trade through the entry"}</strong>{" "}
                  <button type="button" class="cs-link-btn" onClick={() => set("rule", d().rule === "close" ? "touch" : "close")}>change</button>
                  <Show when={!lv().ok && (d().entry || d().stop || d().target)}>
                    <div class="cs-warn">{d().direction === "long" ? "A long idea has its stop below the entry and its target above." : "A short idea has its stop above the entry and its target below."}</div>
                  </Show>
                </div>
              </div>
            </Show>

            <Show when={d().type === "postmortem"}>
              <Field label="The idea it reviews (optional)">
                <select class="cs-input" value={d().linked} onChange={(e) => set("linked", e.currentTarget.value)}>
                  <option value="">None</option>
                  <For each={myIdeas() ?? []}>{(i) => <option value={i.id}>{i.community.title.replace(/^\$/, "")} · {i.title}</option>}</For>
                </select>
              </Field>
            </Show>

            <Field label={isIdea() ? `${n(3)} · Thesis, trigger and risk` : `${n(3)} · ${d().type === "question" ? "Your question in detail" : "Text"}`}>
              <textarea class="cs-textarea is-tall" maxLength={20000} value={d().body} onInput={(e) => set("body", e.currentTarget.value)} />
            </Field>
            <p class="cs-note">Formatting: **bold**, *italic*, [link](https://…), lists with -, quotes with &gt;. $NVDA becomes a link to its page.</p>

            <div>
              <div class="cs-step-row">
                <span class="cs-step">{n(4)} · Chart — from your OpenTrader workspace</span>
                <button type="button" class="cs-link-btn" onClick={() => setHowto((h) => !h)}>Take a new snapshot in OpenTrader</button>
              </div>
              <Show when={howto()}><p class="cs-note">{SNAPSHOT_HOWTO} It shows here.</p></Show>
              <SnapshotPicker selected={d().snapshot} onSelect={(id) => set("snapshot", id)} />
            </div>
          </main>

          <aside class="cs-right is-compose">
            <div>
              <h5>Before you post</h5>
              <For each={checks()}>
                {(c) => (
                  <div class="cs-check">
                    <span class={"cs-box" + (c.ok ? " is-ok" : c.optional ? " is-optional" : " is-missing")} />
                    <span class={c.ok || c.optional ? "" : "cs-missing"}>{c.l}{c.optional && !c.ok ? " (optional)" : ""}</span>
                  </div>
                )}
              </For>
            </div>
            <div>
              <div class="cs-label">Feed preview</div>
              <div class="cs-preview">
                <div class="cs-meta">
                  <TypeTag type={d().type} />
                  <Show when={isIdea()}><DirTag dir={d().direction} /></Show>
                  <strong class="cs-strong">{tickerLabel() || "—"}</strong>
                  <span class="cs-fog">· you</span>
                </div>
                <div class="cs-preview-t">{d().title || "Your title"}</div>
                <Show when={isIdea()}>
                  <div class="cs-fog cs-small">
                    E {price(lv().entry || null)} · S {price(lv().stop || null)} · T {price(lv().target || null)} · R:R {lv().rr == null ? "—" : lv().rr!.toFixed(1)}
                    <Show when={d().expires}> · until {day(d().expires)}</Show>
                  </div>
                </Show>
              </div>
            </div>
            <Show when={isIdea()}>
              <p class="cs-quiet">
                This idea will be tracked against {tickerLabel() || "its ticker's"} price and added to your public record whatever the outcome. You can add updates, but not move levels.
              </p>
            </Show>
            <PostingCheckPrompt />
            <ErrorBanner text={error()} />
            <div class="cs-col">
              <button type="button" class="cs-btn is-primary is-big" disabled={busy() || !ready()} onClick={post}>
                {isIdea() ? "Post idea" : `Post ${TYPE_LABEL[d().type].toLowerCase()}`}
              </button>
              <button type="button" class="cs-btn is-full" onClick={save}>Save draft</button>
            </div>
            <p class="cs-quiet">Posts are members' opinions, not financial advice. Promotion and coordinated buying are removed.</p>
          </aside>
        </div>
      </Show>
    </>
  );
}
