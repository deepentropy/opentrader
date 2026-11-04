/*
 * Manage models: the models the AI assistant can use. A model = an OpenAI-compatible server's address, its API key
 * (kept in the system's credential store; none for a server on this computer) and the model id it takes, with the
 * name and the description the picker shows. "Check" asks the server for its models (and fills the list to pick from).
 */
import { For, Show, createSignal } from "solid-js";
import type { AssistantModel } from "../../bindings";
import { SERVER_PRESETS, config, listServerModels, removeModel, saveModel } from "../../data/assistant/models";

type Draft = { id: string | null; preset: string; label: string; description: string; baseUrl: string; model: string; key: string; keyTouched: boolean };

const presetOf = (url: string) => SERVER_PRESETS.find((p) => p.baseUrl && p.baseUrl === url.replace(/\/+$/, ""))?.id ?? "custom";
const blank = (): Draft => ({ id: null, preset: "llama", label: "", description: "", baseUrl: SERVER_PRESETS[0].baseUrl, model: "", key: "", keyTouched: false });
const fromModel = (m: AssistantModel): Draft => ({ id: m.id, preset: presetOf(m.baseUrl), label: m.label, description: m.description, baseUrl: m.baseUrl, model: m.model, key: "", keyTouched: false });

export function ModelSettings(props: { onDone: () => void; canClose: boolean }) {
  const [draft, setDraft] = createSignal<Draft | null>(config().models.length ? null : blank());
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
        The assistant works with any server that speaks the OpenAI chat API: a cloud provider (with your API key) or a model running on this computer (llama.cpp, Ollama, LM Studio…). Keys are kept in the system's credential store.
      </p>
      <Show when={!draft()}>
        <div class="asst-model-rows">
          <For each={config().models}>
            {(m) => (
              <div class="asst-model-row">
                <div class="asst-model-row-text">
                  <span class="asst-model-name">{m.label}</span>
                  <span class="asst-muted">{m.model} · {m.baseUrl}{m.hasKey ? " · key saved" : ""}</span>
                </div>
                <button type="button" class="asst-btn" onClick={() => { setDraft(fromModel(m)); setStatus(null); }}>Edit</button>
                <button type="button" class="asst-btn" onClick={() => void removeModel(m.id)}>Remove</button>
              </div>
            )}
          </For>
        </div>
        <button type="button" class="asst-btn is-primary" onClick={() => { setDraft(blank()); setStatus(null); }}>Add a model</button>
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
            <div class="asst-inline">
              <button type="submit" class="asst-btn is-primary" disabled={busy() || !d().model.trim() || !d().baseUrl.trim()}>Save</button>
              <Show when={config().models.length}>
                <button type="button" class="asst-btn" onClick={() => { setDraft(null); setStatus(null); }}>Cancel</button>
              </Show>
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
