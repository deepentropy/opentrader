/*
 * Profiler mode's column in the editor (#312), as the reference app shows it: left of the line numbers (the editor
 * widens its line number gutter for it), on each line that ran a bar with its share of the run time, the share faint
 * under 1 %, a flame on the three slowest lines (when there are more than three); the slowest lines out of view
 * are counted at the top or bottom edge (a click shows them). Hovering a bar selects its lines and shows the times:
 * "Line number" (or "Code block range" with the block's own "Line time"), "Time", "Executions".
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { editor as MonacoEditor, Selection } from "monaco-editor";
import { monaco } from "../monaco-setup";
import { Icon } from "../../../components/Icon";
import { formatted, translateWith } from "../../../i18n/translator";
import { numberText } from "../../../i18n/format";
import type { OakProfile } from "../engine-types";
import { formatProfileTime, hotLines, profileRows, roundPercent, type ProfileRow } from "./rows";

/** Characters of line number gutter in profiler mode (the bars take its left part). */
export const PROFILER_GUTTER_CHARS = 23;
/** Width kept for the line numbers on the right of the bars. */
const NUMBERS_WIDTH = 45;

type Props = {
  editor: MonacoEditor.IStandaloneCodeEditor;
  profile: OakProfile;
};

export function ProfilerGutter(props: Props) {
  const ed = props.editor;
  // Bumped when the editor scrolls or resizes: the rows are placed again.
  const [frame, setFrame] = createSignal(0);
  const [hover, setHover] = createSignal<{ row: ProfileRow; x: number; y: number } | null>(null);
  const rows = createMemo(() => profileRows(props.profile));
  const hot = createMemo(() => hotLines(rows()));
  let kept: Selection[] | null = null;

  onMount(() => {
    const bump = () => setFrame((n) => n + 1);
    // The gutter widens for the column (an option change) just before or after this mounts.
    const subs = [ed.onDidScrollChange(bump), ed.onDidLayoutChange(bump), ed.onDidChangeConfiguration(bump), ed.onDidChangeHiddenAreas(bump), ed.onDidChangeModel(bump)];
    const raf = requestAnimationFrame(bump);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      subs.forEach((s) => s.dispose());
    });
  });

  const width = () => {
    frame();
    const info = ed.getLayoutInfo();
    return Math.max(0, info.lineNumbersLeft + info.lineNumbersWidth - NUMBERS_WIDTH);
  };
  const height = () => {
    frame();
    return ed.getLayoutInfo().height;
  };
  const top = (line: number) => {
    frame();
    return ed.getTopForLineNumber(line) - ed.getScrollTop();
  };
  /** The hot lines above and below the visible lines. */
  const offscreen = createMemo(() => {
    frame();
    const ranges = ed.getVisibleRanges();
    const above: number[] = [];
    const below: number[] = [];
    if (!ranges.length) return { above, below };
    const first = ranges[0].startLineNumber;
    const last = ranges[ranges.length - 1].endLineNumber;
    for (const l of hot()) {
      if (l < first) above.push(l);
      else if (l > last) below.push(l);
    }
    return { above, below };
  });
  const lineHeight = () => ed.getOption(monaco.editor.EditorOption.lineHeight);

  const show = (line: number) => ed.revealLineInCenter(line);

  const enter = (row: ProfileRow, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setHover({ row, x: r.right + 4, y: r.top });
    const model = ed.getModel();
    if (!model) return;
    kept = ed.getSelections();
    const end = Math.min(row.end ?? row.line, model.getLineCount());
    ed.setSelection({ startLineNumber: row.line, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(end) });
  };
  const leave = () => {
    setHover(null);
    if (kept) ed.setSelections(kept);
    kept = null;
  };

  return (
    <div class="oak-profiler" style={{ width: `${width()}px`, height: `${height()}px` }} data-qa-id="oakscript-profiler">
      <For each={rows()}>
        {(row) => {
          const pct = () => roundPercent(row.percent);
          const y = () => top(row.line);
          return (
            <Show when={y() > -lineHeight() && y() < height()}>
              <div class="oak-profiler__row" style={{ top: `${y()}px`, height: `${lineHeight() - 1}px` }}>
                <span class="oak-profiler__hot" aria-hidden="true">
                  <Show when={hot().includes(row.line)}>
                    <Icon name="oak-profiler-hot" size={14} />
                  </Show>
                </span>
                <div
                  class="oak-profiler__bar"
                  classList={{ "is-faint": pct() < 1 }}
                  onMouseEnter={(e) => enter(row, e.currentTarget)}
                  onMouseLeave={leave}
                >
                  <div class="oak-profiler__rest" style={{ width: `${Math.max(0, 100 - pct())}%` }} />
                  <span class="oak-profiler__text ot-value">{formatted(`${numberText(pct(), { maximumFractionDigits: 1 })}%`)}</span>
                </div>
              </div>
            </Show>
          );
        }}
      </For>
      <Show when={offscreen().above.length > 0}>
        <button type="button" class="oak-profiler__nav" style={{ top: "0px" }} onClick={() => show(Math.max(...offscreen().above))} aria-label="Slowest lines above">
          <Icon name="oak-profiler-hot" size={14} />
          <span class="ot-value">{offscreen().above.length}</span>
        </button>
      </Show>
      <Show when={offscreen().below.length > 0}>
        <button type="button" class="oak-profiler__nav" style={{ top: `${height() - 20}px` }} onClick={() => show(Math.min(...offscreen().below))} aria-label="Slowest lines below">
          <Icon name="oak-profiler-hot" size={14} />
          <span class="ot-value">{offscreen().below.length}</span>
        </button>
      </Show>
      <Show when={hover()}>
        {(h) => <ProfileTooltip row={h().row} total={props.profile.total} x={h().x} y={h().y} />}
      </Show>
    </div>
  );
}

function ProfileTooltip(props: { row: ProfileRow; total: number; x: number; y: number }) {
  const r = () => props.row;
  const share = (us: number) => (props.total > 0 ? roundPercent((us / props.total) * 100) : 0);
  const pct = (us: number) => formatted(`${numberText(share(us), { maximumFractionDigits: 1 })}%`);
  return (
    <Portal>
      <div class="oak-profiler-tip" role="tooltip" style={{ left: `${props.x}px`, top: `${props.y}px` }}>
        <div class="oak-profiler-tip__row">
          <Show when={r().end !== undefined} fallback={<>{translateWith("Line number: {0}", r().line)}</>}>
            {translateWith("Code block range: [{0}; {1}]", r().line, r().end!)}
          </Show>
        </div>
        <div class="oak-profiler-tip__divider" />
        <div class="oak-profiler-tip__row">
          {translateWith("Time: {0} ({1} from {2} total)", pct(r().time), formatProfileTime(r().time), formatProfileTime(props.total))}
        </div>
        <Show when={r().lineTime !== undefined}>
          <div class="oak-profiler-tip__row">
            {translateWith("Line time: {0} ({1} from {2} total)", pct(r().lineTime!), formatProfileTime(r().lineTime!), formatProfileTime(props.total))}
          </div>
        </Show>
        <div class="oak-profiler-tip__row">{translateWith("Executions: {0}", numberText(r().invocations))}</div>
      </div>
    </Portal>
  );
}
