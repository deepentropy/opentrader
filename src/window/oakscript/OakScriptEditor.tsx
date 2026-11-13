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
 * A built-in study's source shows read-only (`readOnly` prop): its own model,
 * never saved; typing in it shows the read-only message.
 *
 * Editor metrics: Menlo/Consolas 13px/18px; the Editor settings (#324) set suggestions, minimap, line guide and
 * word wrap. Profiler mode (#312): the profile of the script's runs in a column left of the line numbers.
 */
import { Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { monaco, setupMonaco, applyOakTheme } from "./monaco-setup";
import * as scripts from "../../data/oakscript-store";
import { onAppEvent } from "../../data/app-events";
import { editorOptions, editorSettings } from "./editor-settings";
import { revealRequest, setRevealRequest } from "./editor-state";
import type { OakProfile } from "./engine-types";
import { PROFILER_GUTTER_CHARS, ProfilerGutter } from "./profiler/ProfilerGutter";
import { hotLines, profileRows } from "./profiler/rows";

const AUTOSAVE_MS = 400;
/** Shown when typing into a read-only source (the reference app's wording). */
const READ_ONLY_MESSAGE = "This script is read-only. It cannot be edited.";

type Props = {
  theme: "dark" | "light";
  /** Which stored script the editor shows; switching swaps monaco models. */
  scriptId: string;
  /** A read-only source shown instead of the stored script (a built-in: its editor id and source). */
  readOnly?: { id: string; source: string } | null;
  /** Cursor tracker for the panel's status bar ("Line N, Col N"). */
  onCursor?: (line: number, col: number) => void;
  /** Fires after a REAL change is persisted (not on no-op flushes) — the
   *  panel recompiles that script on this. */
  onSaved?: (scriptId: string, source: string) => void;
  /** Profiler mode: the profile shown (null: none yet). */
  profile?: OakProfile | null;
  /** Bumped to show the slowest line of the next profile (profiler mode turned on). */
  revealSlowest?: number;
  /** The editor's commands the panel calls (its More menu). */
  onReady?: (api: { commandPalette: () => void }) => void;
};

export default function OakScriptEditor(props: Props) {
  let host!: HTMLDivElement;
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  const [shownEditor, setShownEditor] = createSignal<monaco.editor.IStandaloneCodeEditor>();
  let saveTimer: number | undefined;
  /** The script the CURRENT model belongs to (saves are keyed to this, not to
   *  props.scriptId, which may already point at the next script mid-switch). */
  let activeId: string | undefined;
  let lastSaved: string | undefined;
  /** The current model is a read-only source (never saved). */
  let readOnlyActive = false;

  const flushSave = () => {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    const model = editor?.getModel();
    if (!model || !activeId || readOnlyActive) return;
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
      ...editorOptions(editorSettings()),
    });
    setShownEditor(editor);
    props.onReady?.({
      commandPalette: () => {
        editor?.focus();
        editor?.trigger("menu", "editor.action.quickCommand", null);
      },
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

  // A coding agent saved a script: its model (open or cached) takes the new text as one edit the user can undo.
  onCleanup(
    onAppEvent("oakscript-source-changed", (d) => {
      const model = monaco.editor.getModel(monaco.Uri.parse(`file:///oakscript/${d.scriptId}.js`));
      if (!model || model.getValue() === d.source) return;
      if (d.scriptId === activeId) {
        if (saveTimer !== undefined) clearTimeout(saveTimer);
        saveTimer = undefined;
        lastSaved = d.source; // already saved: the autosave this edit starts finds nothing to write
      }
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: d.source }], () => null);
    }),
  );

  // Bind the model for props.scriptId (declared after onMount so the editor
  // exists on the first run; re-runs on every script switch).
  createEffect(() => {
    const ro = props.readOnly ?? null;
    const id = ro ? ro.id : props.scriptId;
    if (!editor || id === activeId) return;
    flushSave(); // persist the outgoing script before rebinding
    let model: monaco.editor.ITextModel;
    if (ro) {
      const uri = monaco.Uri.parse(`file:///oakscript/${ro.id.replace(/[^\w-]/g, "_")}.js`);
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(ro.source, "javascript", uri);
    } else {
      const script = scripts.loadScript(id);
      if (!script) return;
      const uri = monaco.Uri.parse(`file:///oakscript/${id}.js`);
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(script.source, "javascript", uri);
    }
    activeId = id;
    readOnlyActive = ro !== null;
    lastSaved = model.getValue();
    editor.updateOptions({ readOnly: readOnlyActive, readOnlyMessage: { value: READ_ONLY_MESSAGE } });
    editor.setModel(model);
    const pos = editor.getPosition();
    if (pos) props.onCursor?.(pos.lineNumber, pos.column);
    revealAsked();
  });

  /** A line asked to be shown (a log message's "Source code"), once its script is the one shown. */
  function revealAsked(): void {
    const req = revealRequest();
    if (!editor || !req || req.scriptId !== activeId) return;
    setRevealRequest(null);
    const model = editor.getModel();
    const line = Math.min(req.line, model?.getLineCount() ?? req.line);
    editor.revealLineInCenter(line);
    editor.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model?.getLineMaxColumn(line) ?? 1 });
    editor.focus();
  }
  createEffect(on(revealRequest, revealAsked));

  createEffect(() => {
    const options = editorOptions(editorSettings());
    editor?.updateOptions(options);
  });

  // Profiler mode: the line numbers' gutter widens for the bars.
  createEffect(() => {
    editor?.updateOptions({ lineNumbersMinChars: props.profile ? PROFILER_GUTTER_CHARS : 5 });
  });
  // The first profile after profiler mode is turned on shows its slowest line.
  let revealed = props.revealSlowest ?? 0;
  createEffect(() => {
    const profile = props.profile;
    const want = props.revealSlowest ?? 0;
    if (!editor || !profile || want === revealed) return;
    const slowest = hotLines(profileRows(profile))[0] ?? [...profileRows(profile)].sort((a, b) => b.time - a.time)[0]?.line;
    if (slowest === undefined) return;
    revealed = want;
    editor.revealLineInCenter(slowest);
  });

  createEffect(() => {
    const theme = props.theme;
    if (editor) applyOakTheme(theme);
  });

  onCleanup(() => {
    flushSave();
    editor?.dispose();
  });

  return (
    <div class="oak-editor-wrap">
      <div class="oak-editor-host" ref={host} />
      <Show when={shownEditor() && props.profile}>
        {(profile) => <ProfilerGutter editor={shownEditor()!} profile={profile()} />}
      </Show>
    </div>
  );
}
