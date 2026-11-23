/*
 * Editor settings dialog of the OakScript editor (#324), the reference's layout: a "Text editor" section of check
 * rows, then Reset to default / Cancel / Ok. Edits a draft: Cancel drops it, Ok saves it.
 */
import { For, Show, createSignal } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { CheckBox } from "../../components/form";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { DEFAULT_EDITOR_SETTINGS, editorSettings, saveEditorSettings, type EditorSettings } from "./editor-settings";

const ROWS: { key: keyof EditorSettings; label: string; tip?: string }[] = [
  { key: "suggestions", label: "Suggestions as you type" },
  { key: "minimap", label: "Minimap" },
  { key: "lineGuide", label: "Line length guide" },
  { key: "inlayHints", label: "Inlay hints for imports", tip: "Shows the version of each imported package, or that it cannot be loaded" },
  { key: "diffDecorations", label: "Diff decorations", tip: "Marks the lines changed since the script was opened, or since the last Ctrl+S" },
  { key: "wordWrap", label: "Use word wrap by default", tip: "Wraps lines to fit the editor width." },
];

export function EditorSettingsDialog(props: { onClose: () => void }) {
  const [draft, setDraft] = createSignal<EditorSettings>({ ...editorSettings() });
  const toggle = (key: keyof EditorSettings) => setDraft((d) => ({ ...d, [key]: !d[key] }));
  const ok = () => {
    saveEditorSettings(draft());
    props.onClose();
  };
  return (
    <Dialog
      look="settings"
      layerClass="settings-backdrop"
      backdrop="close"
      class="settings-dialog oak-editor-settings"
      data-qa-id="oakscript-editor-settings"
      title="Editor settings"
      onClose={props.onClose}
      onEnter={() => ok()}
    >
      <div class="oak-editor-settings__body">
        <div class="oak-editor-settings__section">Text editor</div>
        <For each={ROWS}>
          {(r) => (
            <div class="oak-editor-settings__row">
              <CheckBox checked={draft()[r.key]} onToggle={() => toggle(r.key)} />
              <span class="cp3-title" onClick={() => toggle(r.key)}>{r.label}</span>
              <Show when={r.tip}>
                {(tip) => (
                  <Tooltip text={tip()} side="top">
                    <span class="ind3-info" aria-label={tip()}>
                      <Icon name="st-settings-info" size={18} />
                    </span>
                  </Tooltip>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>
      <footer class="cp3-footer">
        <button type="button" class="cp3-btn" onClick={() => setDraft({ ...DEFAULT_EDITOR_SETTINGS })}>Reset to default</button>
        <div class="cp3-footer-actions">
          <button type="button" class="cp3-btn" onClick={() => props.onClose()}>Cancel</button>
          <button type="button" class="cp3-btn is-primary" data-qa-id="submit-button" onClick={ok}>Ok</button>
        </div>
      </footer>
    </Dialog>
  );
}
