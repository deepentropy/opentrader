/*
 * Editor settings of the OakScript editor (#324): the reference's "Text editor" options that apply to this editor,
 * saved for every script.
 */
import { createSignal } from "solid-js";
import type { editor } from "monaco-editor";
import * as kv from "../../data/kv";

export type EditorSettings = {
  /** Completion suggestions while typing. */
  suggestions: boolean;
  minimap: boolean;
  /** A guide line at LINE_GUIDE_COLUMN. */
  lineGuide: boolean;
  wordWrap: boolean;
};

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { suggestions: true, minimap: false, lineGuide: false, wordWrap: false };

/** Column of the line length guide. */
export const LINE_GUIDE_COLUMN = 120;

const KEY = "ot:oakscript:editorSettings";

function load(): EditorSettings {
  try {
    const saved = JSON.parse(kv.getItem(KEY) ?? "null") as Partial<EditorSettings> | null;
    return { ...DEFAULT_EDITOR_SETTINGS, ...(saved && typeof saved === "object" ? saved : {}) };
  } catch {
    return { ...DEFAULT_EDITOR_SETTINGS };
  }
}

const [editorSettings, setSettings] = createSignal<EditorSettings>(load());
export { editorSettings };

export function saveEditorSettings(s: EditorSettings): void {
  setSettings(s);
  kv.setItem(KEY, JSON.stringify(s));
}

/** The editor options of settings `s`. */
export function editorOptions(s: EditorSettings): editor.IEditorOptions {
  return {
    quickSuggestions: s.suggestions,
    suggestOnTriggerCharacters: s.suggestions,
    minimap: { enabled: s.minimap },
    rulers: s.lineGuide ? [LINE_GUIDE_COLUMN] : [],
    wordWrap: s.wordWrap ? "on" : "off",
  };
}
