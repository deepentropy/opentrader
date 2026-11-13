import { translate, translateWith } from "../../i18n/translator";
/*
 * The AI assistant panel (right rail's AI button), laid out as the reference desktop app's (3.5.0, measured over CDP
 * on 04/11/2026, .tmp/ai-panel): an overlay at the window's right (or a split view), its header with "Move overlay to
 * split-view", the title, Collapse panel and Close; a 680 px column with the chat's title menu (Create new chat /
 * Open chat…), the greeting and its suggestions on an empty chat, the messages, then the composer with Send, and the
 * note under it.
 *
 * Unlike the reference, the model is OpenTrader's own and runs on this computer (downloaded once, then offline), so
 * there is no model or effort picker. The chat runs the app's agent tools (src/data/assistant/session.ts).
 */
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "../../components/Icon";
import { AnswerText, symbolsOf } from "./AnswerText";
import { assistantPanel, ASSISTANT_MIN_WIDTH } from "../../data/assistant/panel";
import { activeChat, answerConfirm, chats, deleteChat, newChat, openChat, rateAnswer, renameChat, running, send, stop, type AttachedFile, type ChatMessage, type ToolStep } from "../../data/assistant/session";
import { attach, MAX_ATTACHMENT_BYTES } from "../../data/assistant/attachments";
import { Popup } from "./Popup";
import { AssistantSetup } from "./LocalModel";
import { gb, localError, localInfo, localProgress, refreshLocal, removeLocal, setUpdateLater, updateBytes, updateLater, updateLocal } from "../../data/assistant/local";
import { stepTitle } from "./steps";
import "../../styles/screener.css";
import "../../styles/community.css";
import "../../styles/assistant.css";

/** Suggestions of an empty chat: things the tools can do here, in the interface language (sent as shown). */
const suggestions = (ticker: string) => [
  translate("What can you do?"),
  translateWith("Show {0} on the daily chart with RSI and two moving averages", ticker),
  translate("Make a watchlist of the biggest semiconductor stocks"),
  translate("Find US stocks up more than 5% today on heavy volume"),
  translateWith("Set an alert when {0} crosses its last close +3%", ticker),
  translateWith("What does the Community say about {0}?", ticker),
];

export function AssistantPanel(props: { ticker: string }) {
  onMount(() => void refreshLocal());
  const ready = () => !!localInfo()?.installed;
  const overlay = () => assistantPanel.mode() === "overlay";
  const [view, setView] = createSignal<"chat" | "chats">("chat");


  // Resizer: drag the 4 px strip; the panel grows to the left.
  const beginResize = (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = assistantPanel.width();
    const maxW = () => Math.max(ASSISTANT_MIN_WIDTH, document.documentElement.clientWidth - (overlay() ? 100 : 360));
    const onMove = (ev: MouseEvent) => assistantPanel.setWidth(Math.min(maxW(), startW + (startX - ev.clientX)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      assistantPanel.setWidth(assistantPanel.width(), true);
    };
    document.body.style.cursor = "ew-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  // Escape closes the overlay, unless a menu or a field takes it.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !overlay()) return;
      if (document.querySelector(".asst-popup,[role=dialog]")) return;
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea,select,[contenteditable=true]")) return;
      assistantPanel.setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="scr-split asst-split" classList={{ "is-overlay": overlay() }} style={{ width: `${assistantPanel.width()}px` }}>
      <div class="scr-resizer" role="separator" aria-orientation="vertical" onMouseDown={beginResize} />
      <section class="scr-panel asst-panel" aria-label="AI assistant">
        <header class="scr-panel-header">
          <div class="scr-panel-title-block">
            <button
              type="button"
              class="scr-light-btn scr-light-btn--ghost is-icon-only"
              title={overlay() ? "Move overlay to split-view" : "Move split-view to overlay"}
              aria-label={overlay() ? "Move overlay to split-view" : "Move split-view to overlay"}
              onClick={() => assistantPanel.setMode(overlay() ? "split" : "overlay")}
            >
              <Icon name={overlay() ? "scr-overlay-to-split" : "scr-split-to-overlay"} size={28} />
            </button>
            <span class="scr-panel-title">AI assistant</span>
          </div>
          <div class="scr-panel-buttons">
            <button type="button" class="scr-light-btn scr-light-btn--ghost is-icon-only" title="Collapse panel" aria-label="Collapse panel" onClick={() => assistantPanel.collapse()}>
              <Icon name="st-footer-collapse-panel" size={28} />
            </button>
            <button type="button" class="scr-light-btn scr-light-btn--ghost is-icon-only" data-i18n-sense="action" title="Close" aria-label="Close" onClick={() => assistantPanel.setOpen(false)}>
              <Icon name="scr-panel-close" size={28} />
            </button>
          </div>
        </header>
        <div class="asst-body">
          <Switch>
            <Match when={localInfo() && !ready()}>
              <AssistantSetup />
            </Match>
            <Match when={view() === "chats"}>
              <ChatList onDone={() => setView("chat")} />
            </Match>
            <Match when={view() === "chat"}>
              <ChatView ticker={props.ticker} onOpenChats={() => setView("chats")} />
            </Match>
          </Switch>
        </div>
      </section>
    </div>
  );
}

function ChatView(props: { ticker: string; onOpenChats: () => void }) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  // Files attached to the message being written (a file of trades to import, read by the tools by id).
  const [files, setFiles] = createSignal<AttachedFile[]>([]);
  const [fileError, setFileError] = createSignal("");
  const [dropping, setDropping] = createSignal(false);
  let list!: HTMLDivElement;
  let area!: HTMLTextAreaElement;
  const addFiles = async (picked: File[]) => {
    setFileError("");
    for (const f of picked) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        setFileError(translateWith("{0} is too large: 5 MB at most.", f.name));
        continue;
      }
      const a = attach(f.name, await f.text());
      setFiles((l) => [...l, { id: a.id, name: a.name }]);
    }
    area?.focus();
  };
  const pickFiles = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".csv,.tsv,.txt,text/csv,text/plain";
    input.onchange = () => void addFiles([...(input.files ?? [])]);
    input.click();
  };
  const messages = () => activeChat()?.messages ?? [];
  // The symbols the chat's tools met (bare ticker → full name): the answers link them.
  const known = createMemo(() => {
    const m = new Map<string, string>();
    for (const msg of messages()) {
      if (msg.role !== "assistant") continue;
      for (const t of msg.tools ?? []) {
        symbolsOf(t.arguments, m);
        if (t.result) symbolsOf(t.result, m);
      }
    }
    return m;
  });
  // Keep the newest message in view while the answer streams, unless the user scrolled up.
  let pinned = true;
  createEffect(() => {
    const ms = messages();
    const last = ms[ms.length - 1];
    void (last && (last.role === "assistant" ? last.text + (last.tools?.map((t) => t.status).join() ?? "") : last.text));
    if (pinned) queueMicrotask(() => (list.scrollTop = list.scrollHeight));
  });
  const submit = (text = draft()) => {
    if ((!text.trim() && !files().length) || running() || !localInfo()?.installed) return;
    const attached = files();
    setDraft("");
    setFiles([]);
    setFileError("");
    pinned = true;
    void send(text, attached);
    queueMicrotask(() => area?.focus());
  };
  return (
    <div class="asst-column">
      <div class="asst-chat-head">
        <button type="button" class="asst-chat-title" classList={{ "is-open": menuOpen() }} aria-haspopup="menu" onClick={() => setMenuOpen(!menuOpen())}>
          <span class="asst-chat-title-text">{activeChat()?.title ?? "New chat"}</span>
          <span class="asst-caret" classList={{ "is-open": menuOpen() }}><Icon name="scr-caret" size={18} /></span>
        </button>
        <Show when={menuOpen()}>
          <Popup onClose={() => setMenuOpen(false)} class="asst-chat-menu">
            <button type="button" class="asst-menu-item" role="menuitem" disabled={!activeChat()} onClick={() => { setMenuOpen(false); newChat(); }}>
              Create new chat
            </button>
            <div class="asst-menu-sep" />
            <button type="button" class="asst-menu-item" role="menuitem" disabled={!chats().length} onClick={() => { setMenuOpen(false); props.onOpenChats(); }}>
              Open chat…
            </button>
            <div class="asst-menu-sep" />
            <button type="button" class="asst-menu-item" role="menuitem" disabled={running()} onClick={() => { setMenuOpen(false); void removeLocal(); }}>
              Remove the model from this computer
            </button>
          </Popup>
        </Show>
      </div>
      <UpdateBanner />
      <div
        class="asst-messages"
        ref={list}
        onScroll={() => (pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 40)}
      >
        <Show
          when={messages().length}
          fallback={
            <div class="asst-empty">
              <p class="asst-greeting">Hi, I'm your assistant: ask me to work the app for you.</p>
              <For each={suggestions(props.ticker)}>
                {(s) => (
                  <button type="button" class="asst-suggestion" disabled={!localInfo()?.installed || running()} onClick={() => submit(s)}>
                    <Icon name="ai-sparkle" size={18} />
                    <span>{s}</span>
                  </button>
                )}
              </For>
            </div>
          }
        >
          <For each={messages()}>{(m) => <Message message={m} known={known()} />}</For>
          <Show when={running() && isThinking(messages())}>
            <div class="asst-thinking"><span /><span /><span /></div>
          </Show>
        </Show>
      </div>
      <div
        class="asst-composer"
        classList={{ "is-dropping": dropping() }}
        onDragOver={(e) => {
          if (!e.dataTransfer?.types.includes("Files")) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          if (!e.dataTransfer?.files.length) return;
          e.preventDefault();
          setDropping(false);
          void addFiles([...e.dataTransfer.files]);
        }}
      >
        <Show when={files().length}>
          <div class="asst-files">
            <For each={files()}>
              {(f) => (
                <span class="asst-file">
                  <span class="asst-file-name" data-no-translate>{f.name}</span>
                  <button type="button" class="asst-file-remove" title="Remove file" aria-label="Remove file" onClick={() => setFiles((l) => l.filter((x) => x.id !== f.id))}>
                    <Icon name="tab-close" size={12} />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
        <textarea
          ref={area}
          class="asst-input"
          rows={1}
          placeholder={translateWith("Ask anything about {0}...", props.ticker)}
          value={draft()}
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            e.currentTarget.style.height = "auto";
            e.currentTarget.style.height = `${Math.min(160, e.currentTarget.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div class="asst-composer-row">
          <button type="button" class="asst-attach" title="Attach a file" aria-label="Attach a file" disabled={running()} onClick={pickFiles}>
            <Icon name="ai-attach" size={28} />
          </button>
          <Show
            when={running()}
            fallback={
              <button type="button" class="asst-send" title="Send message" aria-label="Send message" disabled={(!draft().trim() && !files().length) || !localInfo()?.installed} onClick={() => submit()}>
                <Icon name="ai-send" size={28} class="ot-flip-rtl" />
              </button>
            }
          >
            <button type="button" class="asst-send is-stop" data-i18n-sense="action" title="Stop" aria-label="Stop" onClick={stop}>
              <Icon name="ai-stop" size={28} />
            </button>
          </Show>
        </div>
      </div>
      <Show when={fileError()}>
        <p class="asst-file-error">{fileError()}</p>
      </Show>
      <p class="asst-note">AI can make mistakes. Nothing here is financial advice.</p>
    </div>
  );
}

/** A newer version of the model than the one on this computer: Update downloads it (its size), Later hides this until
 *  the app starts again. The chat goes on with the installed one meanwhile. */
function UpdateBanner() {
  const bytes = () => updateBytes(localInfo());
  const pct = () => {
    const p = localProgress();
    return p && p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : 0;
  };
  return (
    <Show when={bytes() > 0 && !updateLater()}>
      <div class="asst-update" role="status">
        <Show
          when={localProgress()}
          fallback={
            <>
              <span class="asst-update-text">A new version of the assistant is available.</span>
              <button type="button" class="asst-btn is-primary" disabled={running()} onClick={() => void updateLocal()}>
                {translateWith("Update ({0})", sizeText(bytes()))}
              </button>
              <button type="button" class="asst-btn" onClick={() => setUpdateLater(true)}>Later</button>
            </>
          }
        >
          <div class="asst-progress"><div style={{ width: `${pct()}%` }} /></div>
          <span class="asst-muted">{translateWith("Updating… {0}%", pct())}</span>
        </Show>
        <Show when={localError()}>{(e) => <span class="asst-status is-error">{e()}</span>}</Show>
      </div>
    </Show>
  );
}

/** A download's size: MB under 1 GB. */
const sizeText = (bytes: number) => (bytes < 1024 ** 3 ? `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB` : gb(bytes));

/** The user's message, and the names of the files attached to it. */
function UserMessage(props: { message: Extract<ChatMessage, { role: "user" }> }) {
  return (
    <div class="asst-user">
      <Show when={props.message.files?.length}>
        <div class="asst-files">
          <For each={props.message.files}>{(f) => <span class="asst-file asst-file-name" data-no-translate>{f.name}</span>}</For>
        </div>
      </Show>
      <Show when={props.message.text}>{props.message.text}</Show>
    </div>
  );
}

/** The model is working with nothing shown yet. */
function isThinking(ms: ChatMessage[]): boolean {
  const last = ms[ms.length - 1];
  return !last || last.role === "user" || (!last.text && !(last.tools?.length));
}

function Message(props: { message: ChatMessage; known: Map<string, string> }) {
  return (
    <Show
      when={props.message.role === "assistant" ? (props.message as Extract<ChatMessage, { role: "assistant" }>) : null}
      fallback={<UserMessage message={props.message as Extract<ChatMessage, { role: "user" }>} />}
    >
      {(m) => (
        <div class="asst-answer">
          <Show when={m().reasoning}>
            <details class="asst-reasoning">
              <summary>Reasoning</summary>
              <div>{m().reasoning}</div>
            </details>
          </Show>
          <Show when={m().text}>
            <AnswerText text={m().text} known={props.known} />
          </Show>
          <For each={m().tools ?? []}>{(t) => <Step step={t} />}</For>
          <Show when={m().error}>
            <div class="asst-error">{m().error}</div>
          </Show>
          <Show when={m().trace}>
            {(trace) => (
              <div class="asst-rate">
                <button
                  type="button"
                  class="asst-rate-btn"
                  classList={{ "is-on": m().rating === "good" }}
                  title="Good answer"
                  aria-label="Good answer"
                  aria-pressed={m().rating === "good"}
                  onClick={() => rateAnswer(trace(), "good")}
                >
                  <Icon name="ai-thumb-up" size={18} />
                </button>
                <button
                  type="button"
                  class="asst-rate-btn"
                  classList={{ "is-on": m().rating === "bad" }}
                  title="Bad answer"
                  aria-label="Bad answer"
                  aria-pressed={m().rating === "bad"}
                  onClick={() => rateAnswer(trace(), "bad")}
                >
                  <Icon name="ai-thumb-down" size={18} />
                </button>
              </div>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

function Step(props: { step: ToolStep }) {
  const title = createMemo(() => stepTitle(props.step));
  return (
    <div class="asst-step" classList={{ [`is-${props.step.status}`]: true }}>
      <details>
        <summary>
          <span class="asst-step-dot" />
          <span class="asst-step-title">{title()}</span>
          <Show when={props.step.status === "error"}><span class="asst-step-flag">failed</span></Show>
          <Show when={props.step.status === "denied"}><span class="asst-step-flag">not done</span></Show>
        </summary>
        <pre class="asst-step-detail">{prettyJson(props.step.arguments)}</pre>
        <Show when={props.step.result}>
          <pre class="asst-step-detail">{prettyJson(props.step.result!)}</pre>
        </Show>
      </details>
      <Show when={props.step.status === "confirm"}>
        <div class="asst-confirm">
          <span>Allow this? It cannot be undone.</span>
          <button type="button" class="asst-btn is-danger" onClick={() => answerConfirm(props.step.id, true)}>Allow</button>
          <button type="button" class="asst-btn" onClick={() => answerConfirm(props.step.id, false)}>Don't allow</button>
        </div>
      </Show>
      <Show when={props.step.image}>
        <img class="asst-shot" src={props.step.image} alt="Screenshot" />
      </Show>
    </div>
  );
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function ChatList(props: { onDone: () => void }) {
  const [query, setQuery] = createSignal("");
  const [editing, setEditing] = createSignal<string | null>(null);
  const shown = () => chats().filter((c) => c.title.toLowerCase().includes(query().trim().toLowerCase()));
  const date = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  };
  return (
    <div class="asst-column asst-chats">
      <div class="asst-section-head">
        <button type="button" class="scr-light-btn scr-light-btn--ghost" onClick={props.onDone}>‹ Back</button>
        <span class="asst-section-title">Open chat</span>
      </div>
      <input class="asst-field" placeholder="Search" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
      <div class="asst-chat-rows">
        <For each={shown()} fallback={<p class="asst-muted">No chat.</p>}>
          {(c) => (
            <div class="asst-chat-row">
              <Show
                when={editing() === c.id}
                fallback={
                  <button type="button" class="asst-chat-open" onClick={() => { openChat(c.id); props.onDone(); }}>
                    <span class="asst-chat-row-title">{c.title}</span>
                    <span class="asst-muted">{date(c.updatedAt)}</span>
                  </button>
                }
              >
                <input
                  class="asst-field"
                  value={c.title}
                  ref={(el) => queueMicrotask(() => el.select())}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      renameChat(c.id, e.currentTarget.value);
                      setEditing(null);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setEditing(null);
                    }
                  }}
                  onBlur={(e) => {
                    renameChat(c.id, e.currentTarget.value);
                    setEditing(null);
                  }}
                />
              </Show>
              <button type="button" class="asst-btn" onClick={() => setEditing(c.id)}>Rename</button>
              <button type="button" class="asst-btn" onClick={() => deleteChat(c.id)}>Delete</button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
