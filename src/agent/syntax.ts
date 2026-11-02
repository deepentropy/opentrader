/*
 * Where a script's syntax error is. The script engine reports a syntax error without its place; the editor's
 * JavaScript service (monaco, already in the app for the OakScript editor) finds it. Loaded on the first syntax
 * error only.
 */

export type SyntaxPlace = { message: string; line: number; column: number };

const CHECK_URI = "file:///oakscript/agent-syntax-check.js";

export async function locateSyntaxError(source: string): Promise<SyntaxPlace | null> {
  const { monaco, setupMonaco } = await import("../window/oakscript/monaco-setup");
  setupMonaco();
  const uri = monaco.Uri.parse(CHECK_URI);
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(source, "javascript", uri);
  if (model.getValue() !== source) model.setValue(source);
  const getWorker = await monaco.typescript.getJavaScriptWorker();
  const worker = await getWorker(uri);
  const diags = await worker.getSyntacticDiagnostics(uri.toString());
  const d = diags.find((x) => x.start !== undefined);
  if (!d || d.start === undefined) return null;
  const pos = model.getPositionAt(d.start);
  const text = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
  return { message: text, line: pos.lineNumber, column: pos.column };
}
