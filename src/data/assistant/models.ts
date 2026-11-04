/*
 * The AI assistant's models: the ones the user added (src-tauri/src/assistant.rs keeps them, their keys in the
 * system's credential store), the one selected and the effort. Presets fill the address of common servers; any
 * server that speaks the OpenAI chat-completions API works.
 */
import { createSignal } from "solid-js";
import { commands, type AssistantConfig, type AssistantModelInput } from "../../bindings";

export type Effort = "low" | "medium" | "high";
export const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

/** Address presets of the model settings ("Custom" keeps what is typed). `local`: runs on this computer, no key. */
export const SERVER_PRESETS: { id: string; label: string; baseUrl: string; local?: boolean }[] = [
  { id: "llama", label: "Local: llama.cpp server", baseUrl: "http://127.0.0.1:8080/v1", local: true },
  { id: "ollama", label: "Local: Ollama", baseUrl: "http://127.0.0.1:11434/v1", local: true },
  { id: "lmstudio", label: "Local: LM Studio", baseUrl: "http://127.0.0.1:1234/v1", local: true },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "custom", label: "Custom (OpenAI-compatible)", baseUrl: "" },
];

const EMPTY: AssistantConfig = { models: [], selected: null, effort: null };
const [config, setConfig] = createSignal<AssistantConfig>(EMPTY);
const [loaded, setLoaded] = createSignal(false);
export { config, loaded };

let loading: Promise<void> | null = null;
/** Reads the models once (the panel calls it when it opens). */
export function loadModels(): Promise<void> {
  if (!loading) {
    loading = commands
      .assistantConfig()
      .then((c) => void setConfig(c))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }
  return loading;
}

/** Reads the models again (the model on this computer was added or removed). */
export async function reloadModels(): Promise<void> {
  setConfig(await commands.assistantConfig());
  setLoaded(true);
}

export const selectedModel = () => {
  const c = config();
  return c.models.find((m) => m.id === c.selected) ?? c.models[0] ?? null;
};

/** Saves a model; the error text when the server side refused it (the config is read again either way). */
export async function saveModel(input: AssistantModelInput): Promise<string | null> {
  const r = await commands.assistantSaveModel(input);
  if (r.status === "ok") {
    setConfig(r.data);
    return null;
  }
  setConfig(await commands.assistantConfig());
  return r.error;
}

export async function removeModel(id: string): Promise<void> {
  const r = await commands.assistantRemoveModel(id);
  if (r.status === "ok") setConfig(r.data);
}

export async function selectModel(id: string | null, effort: Effort | null): Promise<void> {
  const r = await commands.assistantSelect(id, effort);
  if (r.status === "ok") setConfig(r.data);
}

/** The server's model ids, or the error text. */
export async function listServerModels(baseUrl: string, key: string | null, id: string | null): Promise<string[] | string> {
  const r = await commands.assistantListModels(baseUrl, key, id);
  return r.status === "ok" ? r.data : r.error;
}
