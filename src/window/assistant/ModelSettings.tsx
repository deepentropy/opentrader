/*
 * Manage models: the models the AI assistant can use. A model = an OpenAI-compatible server's address, its API key
 * (kept in the system's credential store; none for a server on this computer) and the model id it takes, with the
 * name and the description the picker shows. "Check" asks the server for its models (and fills the list to pick from).
 */
import { For, Show, createSignal, onMount } from "solid-js";
import type { AssistantModel } from "../../bindings";
import { SERVER_PRESETS, config, listServerModels, removeModel, saveModel } from "../../data/assistant/models";
import { cancelLocal, gb, installLocal, localBlocker, localError, localInfo, localProgress, refreshLocal, removeLocal } from "../../data/assistant/local";

type Draft = { id: string | null; preset: string; label: string; description: string; baseUrl: string; model: string; key: string; keyTouched: boolean; compact: boolean };

const presetOf = (url: string) => SERVER_PRESETS.find((p) => p.baseUrl && p.baseUrl === url.replace(/\/+$/, ""))?.id ?? "custom";
const blank = (): Draft => ({ id: null, preset: "llama", label: "", description: "", baseUrl: SERVER_PRESETS[0].baseUrl, model: "", key: "", keyTouched: false, compact: false });
const fromModel = (m: AssistantModel): Draft => ({ id: m.id, preset: presetOf(m.baseUrl), label: m.label, description: m.description, baseUrl: m.baseUrl, model: m.model, key: "", keyTouched: false, compact: m.compact });

export function ModelSettings(props: { onDone: () => void; canClose: boolean }) {
  // The list first: "Run on this computer" leads, a server is added from there.
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [ids, setIds] = createSignal<string[]>([]);
  const [status, setStatus] = createSignal<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const isLocal = () => !!SERVER_PRESETS.find((p) => p.id === draft()?.preset)?.local;

  const check = async () => {
    const d = draft();
    if (!d) return;
    setBusy(true);
    setStatus({ text: "Asking the server…" });
    const r = await listServerModels(d.baseUrl, d.keyTouched ? d.key : null, d.id);
    setBusy(false);
    if (typeof r === "string") {
      setStatus({ text: r, error: true });
      return;
    }
    setIds(r);
    setStatus({ text: r.length ? `The server answers: ${r.length} model${r.length > 1 ? "s" : ""}.` : "The server answers, but lists no model: type its id." });
    if (!d.model && r.length) patch({ model: r[0] });
  };
  const save = async () => {
    const d = draft();
    if (!d) return;
    setBusy(true);
    const err = await saveModel({
      id: d.id,
      label: d.label,
      description: d.description,
      baseUrl: d.baseUrl,
      model: d.model,
      apiKey: d.keyTouched ? d.key : null,
      compact: d.compact,
    });
    setBusy(false);
    if (err && !config().models.some((m) => m.model === d.model.trim())) {
      setStatus({ text: err, error: true });
      return;
    }
    setStatus(err ? { text: err, error: true } : null);
    setDraft(null);
    setIds([]);
    if (!err) props.onDone();
  };

  return (
    <div class="asst-column asst-models">
      <div class="asst-section-head">
        <Show when={props.canClose}>
          <button type="button" class="scr-light-btn scr-light-btn--ghost" onClick={props.onDone}>‹ Back</button>
        </Show>
        <span class="asst-section-title">Models</span>
      </div>
      <p class="asst-muted">
        OpenTrader's assistant runs on this computer. For advanced use, another model can be added: any server that speaks the OpenAI chat API, with its API key if it needs one (kept in the system's credential store).
      </p>
      <Show when={!draft()}>
        <LocalModelCard />
        <div class="asst-model-rows">
          <For each={config().models}>
            {(m) => (
              <div class="asst-model-row">
                <div class="asst-model-row-text">
                  <span class="asst-model-name">{m.label}</span>
                  <span class="asst-muted">{m.baseUrl === "local" ? "On this computer" : `${m.model} · ${m.baseUrl}${m.hasKey ? " · key saved" : ""}`}</span>
                </div>
                <Show when={m.baseUrl !== "local"}>
                  <button type="button" class="asst-btn" onClick={() => { setDraft(fromModel(m)); setStatus(null); }}>Edit</button>
                  <button type="button" class="asst-btn" onClick={() => void removeModel(m.id)}>Remove</button>
                </Show>
              </div>
            )}
          </For>
        </div>
        <button type="button" class="asst-btn is-primary" onClick={() => { setDraft(blank()); setStatus(null); }}>Add another model</button>
      </Show>
      <Show when={draft()}>
        {(d) => (
          <form
            class="asst-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label class="asst-label">
              Server
              <select
                class="asst-field"
                value={d().preset}
                onChange={(e) => {
                  const p = SERVER_PRESETS.find((x) => x.id === e.currentTarget.value)!;
                  patch({ preset: p.id, baseUrl: p.baseUrl || d().baseUrl });
                  setIds([]);
                }}
              >
                <For each={SERVER_PRESETS}>{(p) => <option value={p.id}>{p.label}</option>}</For>
              </select>
            </label>
            <label class="asst-label">
              Address
              <input class="asst-field" placeholder="https://…/v1" value={d().baseUrl} onInput={(e) => patch({ baseUrl: e.currentTarget.value, preset: presetOf(e.currentTarget.value) })} />
            </label>
            <label class="asst-label">
              API key{isLocal() ? " (usually none)" : ""}
              <input
                class="asst-field"
                type="password"
                autocomplete="off"
                placeholder={d().id && config().models.find((m) => m.id === d().id)?.hasKey ? "Saved (type to replace, clear to remove)" : ""}
                value={d().key}
                onInput={(e) => patch({ key: e.currentTarget.value, keyTouched: true })}
              />
            </label>
            <label class="asst-label">
              Model id
              <div class="asst-inline">
                <input class="asst-field" list="asst-model-ids" placeholder="the server's model id" value={d().model} onInput={(e) => patch({ model: e.currentTarget.value })} />
                <button type="button" class="asst-btn" disabled={busy() || !d().baseUrl.trim()} onClick={() => void check()}>Check</button>
              </div>
              <datalist id="asst-model-ids"><For each={ids()}>{(id) => <option value={id} />}</For></datalist>
            </label>
            <label class="asst-label">
              Name in the picker
              <input class="asst-field" placeholder={d().model || "e.g. Fast model"} value={d().label} onInput={(e) => patch({ label: e.currentTarget.value })} />
            </label>
            <label class="asst-label">
              Description
              <input class="asst-field" placeholder="e.g. Runs on this computer" value={d().description} onInput={(e) => patch({ description: e.currentTarget.value })} />
            </label>
            <label class="asst-check">
              <input type="checkbox" checked={d().compact} onChange={(e) => patch({ compact: e.currentTarget.checked })} />
              <span>
                OpenTrader's small model: send the short tool list it was trained with (much faster on a computer without a
                graphics card). Leave off for any other model.
              </span>
            </label>
            <div class="asst-inline">
              <button type="submit" class="asst-btn is-primary" disabled={busy() || !d().model.trim() || !d().baseUrl.trim()}>Save</button>
              <button type="button" class="asst-btn" onClick={() => { setDraft(null); setStatus(null); }}>Cancel</button>
            </div>
          </form>
        )}
      </Show>
      <Show when={status()}>
        {(s) => <p class="asst-status" classList={{ "is-error": !!s().error }}>{s().text}</p>}
      </Show>
    </div>
  );
}

/** "Run on this computer": OpenTrader's small model, downloaded when asked for (nothing in the installer). */
export function LocalModelCard() {
  onMount(() => void refreshLocal());
  const busy = () => !!localInfo()?.installing || !!localProgress();
  const pct = () => {
    const p = localProgress();
    return p && p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : 0;
  };
  return (
    <Show when={localInfo()}>
      {(i) => (
        <div class="asst-local">
          <div class="asst-model-row-text">
            <span class="asst-model-name">Run on this computer</span>
            <span class="asst-muted">
              OpenTrader's own small model, trained to work the app: offline, private, free. It runs on the graphics card when there is one, else on the processor.
            </span>
          </div>
          <Show
            when={!i().installed}
            fallback={
              <div class="asst-inline">
                <span class="asst-muted">Installed ({gb(i().diskBytes)}){i().running ? " · running" : ""}</span>
                <button type="button" class="asst-btn" onClick={() => void removeLocal()}>Remove</button>
              </div>
            }
          >
            <Show
              when={!busy()}
              fallback={
                <div class="asst-progress-block">
                  <div class="asst-progress"><div style={{ width: `${pct()}%` }} /></div>
                  <div class="asst-inline">
                    <span class="asst-muted">
                      {localProgress()?.file ?? "Starting…"} · {pct()}%
                    </span>
                    <button type="button" class="asst-btn" onClick={cancelLocal}>Stop</button>
                  </div>
                </div>
              }
            >
              <Show when={localBlocker(i())} fallback={
                <button type="button" class="asst-btn is-primary" onClick={() => void installLocal()}>
                  Download ({gb(i().downloadBytes)})
                </button>
              }>
                {(why) => <span class="asst-muted">{why()}</span>}
              </Show>
            </Show>
          </Show>
          <Show when={localError()}>{(e) => <p class="asst-status is-error">{e()}</p>}</Show>
        </div>
      )}
    </Show>
  );
}
