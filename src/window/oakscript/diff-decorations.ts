/*
 * Diff decorations of the OakScript editor (#325, Editor settings "Diff decorations"), as the reference's: a mark in
 * the gutter on each block of lines changed since the saved version (green: added, hatched blue: modified, a red
 * pointer: removed). A click on a mark opens the block's inline diff under it ("Local working changes": a diff
 * editor of the whole script around the block, Discard changes puts the block back as saved, Close).
 *
 * Scripts save as they are typed, so "the saved version" is the text the script had when the editor opened it, and
 * Ctrl+S (the reference's Save) makes the current text the saved version.
 */
import { render } from "solid-js/web";
import type { editor as MonacoEditor, IDisposable } from "monaco-editor";
import { monaco } from "./monaco-setup";
import { diffLines, markedLines, splitLines, type DiffHunk } from "./line-diff";
import { DiffZone } from "./DiffZone";

/** The saved version of each script model (by model URI), kept while the app runs. */
const savedVersions = new Map<string, string>();

/** Height of the inline diff (the reference's: 11 lines of 18 px, the header included). */
const ZONE_HEIGHT = 198;
/** Edits are diffed this long after the last one. */
const DIFF_DELAY_MS = 200;

type OpenZone = {
  line: number;
  hunk: DiffHunk;
  zoneId: string;
  widget: MonacoEditor.IOverlayWidget;
  node: HTMLDivElement;
  diff?: MonacoEditor.IStandaloneDiffEditor;
  original?: MonacoEditor.ITextModel;
  disposeView: () => void;
  subs: IDisposable[];
};

export class DiffDecorations {
  private readonly deco: MonacoEditor.IEditorDecorationsCollection;
  private hunks: DiffHunk[] = [];
  private enabled = false;
  private timer: number | undefined;
  private zone: OpenZone | null = null;
  private readonly subs: IDisposable[];

  constructor(private readonly ed: MonacoEditor.IStandaloneCodeEditor) {
    this.deco = ed.createDecorationsCollection();
    this.subs = [
      ed.onDidChangeModelContent(() => this.schedule()),
      ed.onDidChangeModel(() => {
        this.closeZone();
        this.refresh();
      }),
      ed.onMouseDown((e) => this.onMouseDown(e)),
    ];
  }

  /** A model the editor is about to show: its text is the saved version, unless it has one already. */
  static opened(model: MonacoEditor.ITextModel): void {
    const uri = model.uri.toString();
    if (!savedVersions.has(uri)) savedVersions.set(uri, model.getValue());
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) this.closeZone();
    this.refresh();
  }

  /** Ctrl+S: the shown text is the saved version now. */
  saved(): void {
    const model = this.ed.getModel();
    if (!model) return;
    savedVersions.set(model.uri.toString(), model.getValue());
    this.closeZone();
    this.refresh();
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.closeZone();
    this.deco.clear();
    this.subs.forEach((s) => s.dispose());
  }

  private schedule(): void {
    if (!this.enabled) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), DIFF_DELAY_MS);
  }

  private savedText(): string | undefined {
    const model = this.ed.getModel();
    return model ? savedVersions.get(model.uri.toString()) : undefined;
  }

  private refresh(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const model = this.ed.getModel();
    const saved = this.savedText();
    this.hunks = this.enabled && model && saved !== undefined ? diffLines(saved, model.getValue()) : [];
    this.deco.set(
      this.hunks.map((h) => {
        const { from, to } = markedLines(h);
        const top = h.kind === "removed" && h.modStart === 1 ? " is-top" : "";
        return {
          range: new monaco.Range(from, 1, to, 1),
          options: { linesDecorationsClassName: `oak-line-deco oak-line-deco--${h.kind}${top}` },
        };
      }),
    );
    // An open diff stays on its block while it is edited, and closes when the block is gone.
    const z = this.zone;
    if (z) {
      const h = this.hunkAt(z.line);
      if (h) z.hunk = h;
      else this.closeZone();
    }
  }

  private hunkAt(line: number): DiffHunk | undefined {
    return this.hunks.find((h) => {
      const { from, to } = markedLines(h);
      return line >= from && line <= to;
    });
  }

  private onMouseDown(e: MonacoEditor.IEditorMouseEvent): void {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
    const el = e.target.element as HTMLElement | null;
    if (!el?.closest?.(".oak-line-deco")) return;
    const line = e.target.position?.lineNumber;
    const hunk = line ? this.hunkAt(line) : undefined;
    if (!line || !hunk) return;
    e.event.preventDefault();
    const open = this.zone;
    this.closeZone();
    // A second click on the mark of the open diff closes it.
    if (open && markedLines(open.hunk).from === markedLines(hunk).from) return;
    this.openZone(hunk, line);
  }

  private openZone(hunk: DiffHunk, line: number): void {
    const model = this.ed.getModel();
    const saved = this.savedText();
    if (!model || saved === undefined) return;
    const ed = this.ed;
    const node = document.createElement("div");
    node.className = "oak-diff-overlay";
    const layout = () => {
      const info = ed.getLayoutInfo();
      node.style.width = `${Math.max(0, info.width - info.verticalScrollbarWidth)}px`;
    };
    layout();
    const widget: MonacoEditor.IOverlayWidget = {
      getId: () => "oakscript.inline-diff",
      getDomNode: () => node,
      getPosition: () => null,
    };
    ed.addOverlayWidget(widget);
    let zoneId = "";
    ed.changeViewZones((acc) => {
      zoneId = acc.addZone({
        afterLineNumber: markedLines(hunk).to,
        heightInPx: ZONE_HEIGHT,
        domNode: document.createElement("div"),
        // The overlay follows the space the zone keeps between the lines.
        onDomNodeTop: (top) => (node.style.top = `${top}px`),
        onComputedHeight: (height) => (node.style.height = `${height}px`),
      });
    });
    const zone: OpenZone = { line, hunk, zoneId, widget, node, disposeView: () => {}, subs: [ed.onDidLayoutChange(layout)] };
    this.zone = zone;
    let host: HTMLDivElement | undefined;
    zone.disposeView = render(
      () =>
        DiffZone({
          kind: hunk.kind,
          arrowLeft: ed.getLayoutInfo().decorationsLeft + 2,
          onDiscard: () => this.discard(),
          onClose: () => this.closeZone(),
          editorHost: (el) => (host = el),
        }),
      node,
    );
    if (!host) return;
    // The saved side is plain text: a second script model would join the script's IntelliSense (same names declared twice).
    zone.original = monaco.editor.createModel(saved, "plaintext");
    zone.diff = monaco.editor.createDiffEditor(host, {
      renderSideBySide: false,
      useInlineViewWhenSpaceIsLimited: false,
      automaticLayout: true,
      originalEditable: false,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: false,
      scrollBeyondLastLine: true,
      minimap: { enabled: false },
      glyphMargin: false,
      lineNumbersMinChars: 5,
      fontFamily: ed.getOption(monaco.editor.EditorOption.fontFamily),
      fontSize: 13,
      lineHeight: 18,
      hover: { enabled: false },
      stickyScroll: { enabled: false },
      quickSuggestions: false,
      scrollbar: { vertical: "hidden", verticalScrollbarSize: 0, horizontalScrollbarSize: 4, alwaysConsumeMouseWheel: true },
    });
    zone.diff.setModel({ original: zone.original, modified: model });
    // Shown on the block once the diff is in.
    const focus = markedLines(hunk).from;
    const once = zone.diff.onDidUpdateDiff(() => {
      once.dispose();
      zone.diff?.getModifiedEditor().revealLineInCenter(focus);
    });
    zone.subs.push(once);
  }

  private closeZone(): void {
    const z = this.zone;
    if (!z) return;
    this.zone = null;
    z.subs.forEach((s) => s.dispose());
    z.diff?.setModel(null);
    z.diff?.dispose();
    z.original?.dispose();
    z.disposeView();
    this.ed.removeOverlayWidget(z.widget);
    this.ed.changeViewZones((acc) => acc.removeZone(z.zoneId));
  }

  /** "Discard changes": the open diff's block goes back to its saved lines (one undo step), the diff closes. */
  private discard(): void {
    const z = this.zone;
    const model = this.ed.getModel();
    const saved = this.savedText();
    if (!z || !model || saved === undefined) return;
    const h = z.hunk;
    const eol = model.getEOL();
    const lines = splitLines(saved).slice(h.origStart - 1, h.origStart - 1 + h.origCount);
    const count = model.getLineCount();
    let range: InstanceType<typeof monaco.Range>;
    let text: string;
    if (h.modCount > 0) {
      const end = h.modStart + h.modCount - 1;
      if (h.origCount > 0) {
        range = new monaco.Range(h.modStart, 1, end, model.getLineMaxColumn(end));
        text = lines.join(eol);
      } else if (end < count) {
        range = new monaco.Range(h.modStart, 1, end + 1, 1);
        text = "";
      } else if (h.modStart > 1) {
        range = new monaco.Range(h.modStart - 1, model.getLineMaxColumn(h.modStart - 1), end, model.getLineMaxColumn(end));
        text = "";
      } else {
        range = model.getFullModelRange();
        text = "";
      }
    } else if (h.modStart <= count) {
      range = new monaco.Range(h.modStart, 1, h.modStart, 1);
      text = lines.join(eol) + eol;
    } else {
      const col = model.getLineMaxColumn(count);
      range = new monaco.Range(count, col, count, col);
      text = eol + lines.join(eol);
    }
    this.closeZone();
    model.pushStackElement();
    model.pushEditOperations([], [{ range, text }], () => null);
    model.pushStackElement();
  }
}
