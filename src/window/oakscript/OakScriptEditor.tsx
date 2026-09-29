/*
 * OakScriptEditor — the Monaco host inside the OakScript drawer. Default
 * export so OakScriptPanel can load it with Solid `lazy()` — monaco and the
 * oakscriptjs typings live in this chunk and load on first open only.
 *
 * Persistence: edits autosave to the kv script store on a short debounce
 * (and flush on Ctrl+S / script switch / unmount), so there is no dirty state
 * to lose when the drawer or app closes. Saves are keyed to the script id the
 * model belongs to, so a debounced save can never land in another script
 * after a switch. One monaco model per script id (cached by URI) keeps each
 * script's undo stack alive across switches and drawer close/reopen.
 *
 * Editor metrics follow TV's Pine editor (Menlo/Consolas 13px/18px, no
 * minimap — DESIGN.md).
 */
import { createEffect, onCleanup, onMount } from "solid-js";
import { monaco, setupMonaco, applyOakTheme } from "./monaco-setup";
import * as scripts from "../../data/oakscript-store";

const AUTOSAVE_MS = 400;

type Props = {
  theme: "dark" | "light";
  /** Which stored script the editor shows; switching swaps monaco models. */
  scriptId: string;
  /** Cursor tracker for the panel's status bar ("Line N, Col N"). */
  onCursor?: (line: number, col: number) => void;
  /** Fires after a REAL change is persisted (not on no-op flushes) — the
   *  panel recompiles that script on this. */
  onSaved?: (scriptId: string, source: string) => void;
};

export default function OakScriptEditor(props: Props) {
  let host!: HTMLDivElement;
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  let saveTimer: number | undefined;
  /** The script the CURRENT model belongs to (saves are keyed to this, not to
   *  props.scriptId, which may already point at the next script mid-switch). */
  let activeId: string | undefined;
  let lastSaved: string | undefined;

  const flushSave = () => {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    const model = editor?.getModel();
    if (!model || !activeId) return;
    const source = model.getValue();
    if (source === lastSaved) return;
    lastSaved = source;
    scripts.saveSource(activeId, source);
    props.onSaved?.(activeId, source);
  };

  onMount(() => {
    setupMonaco();
    applyOakTheme(props.theme);

    editor = monaco.editor.create(host, {
      fontFamily: 'Menlo, "Ubuntu Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 18,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      tabSize: 2,
      // Drawer clips overflow; keep completion widgets visible near its edges.
      fixedOverflowWidgets: true,
    });

    editor.onDidChangeModelContent(() => {
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = window.setTimeout(flushSave, AUTOSAVE_MS);
    });
    editor.onDidChangeCursorPosition((e) =>
      props.onCursor?.(e.position.lineNumber, e.position.column),
    );
    // Ctrl+S saves immediately instead of triggering the browser dialog.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, flushSave);
  });

  // Bind the model for props.scriptId (declared after onMount so the editor
  // exists on the first run; re-runs on every script switch).
  createEffect(() => {
    const id = props.scriptId;
    if (!editor || id === activeId) return;
    flushSave(); // persist the outgoing script before rebinding
    const script = scripts.loadScript(id);
    if (!script) return;
    const uri = monaco.Uri.parse(`file:///oakscript/${id}.js`);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(script.source, "javascript", uri);
    activeId = id;
    lastSaved = model.getValue();
    editor.setModel(model);
    const pos = editor.getPosition();
    if (pos) props.onCursor?.(pos.lineNumber, pos.column);
  });

  createEffect(() => {
    const theme = props.theme;
    if (editor) applyOakTheme(theme);
  });

  onCleanup(() => {
    flushSave();
    editor?.dispose();
  });

  return <div class="oak-editor-host" ref={host} />;
}
