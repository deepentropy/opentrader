/*
 * OakScriptPanel — bottom-docked OakScript editor drawer ("Move script to
 * bottom" mode).
 *
 * Vertical layout: resize handle | header | editor body | console (toggle) |
 * status bar. The header's script-name button opens the script menu (copy /
 * rename / create / recently-used / import / export / delete); scripts live
 * in the kv script store and execute in the shared worker engine.
 *
 * A built-in study's source (legend "Source code", study menu, Built-in…)
 * shows read-only, as in the reference app: its name as title, a banner
 * "This script is read-only. To edit its code you can make a copy." (the
 * link gives a new "Untitled script" with the source), "Make a copy…" in the
 * menu asks for the copy's name ("<name> copy"), "Add to chart" adds the
 * built-in study itself.
 */
import { For, Show, Suspense, createEffect, createSignal, lazy, on, onCleanup, onMount } from "solid-js";
import oakPackage from "../../../node_modules/oakscriptjs/package.json";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import * as kv from "../../data/kv";
import * as scripts from "../../data/oakscript-store";
import { getOakEngine, OakEngineError } from "./engine";
import { OakScriptMenu } from "./OakScriptMenu";
import {
  dropUserScriptRuntime,
  notifyScriptCompiled,
  notifyScriptRenamed,
  OAKSCRIPT_OPEN_EVENT,
  userIndicatorId,
} from "../chart/indicators/user-scripts";
import { dropUserStrategy, notifyUserStrategyCompiled, userStrategyId } from "../chart/indicators/strategy-entries";
import { typeIdOf } from "../chart/indicators/study-id";
import { onAppEvent } from "../../data/app-events";
import { showRename } from "../../components/Dialogs";
import { builtinName, builtinScriptId, builtinTypeOf, loadBuiltinSource } from "./builtin-sources";
import { setOpenedScript } from "./editor-state";
import { BuiltinScriptDialog } from "./BuiltinScriptDialog";

// Monaco (and the oakscriptjs typings) stay in this lazy chunk — nothing
// editor-sized loads until the drawer first opens.
const OakScriptEditor = lazy(() => import("./OakScriptEditor"));

const HEIGHT_KEY = "ot:oakscript:panelHeight";
const MINIMIZED_KEY = "ot:oakscript:panelMinimized";
const CONSOLE_KEY = "ot:oakscript:consoleOpen";
const MAX_LOG_ENTRIES = 200;
/** Bottom-dock default (275px on a 994px window). */
const DEFAULT_HEIGHT = 275;
const MIN_HEIGHT = 120;
/** Keep the chart at least this tall when the editor grows or maximizes off. */
const CHART_MIN = 150;
/** Engine version shown in the status bar, read from the installed package. */
const ENGINE_LABEL = `OakScript v${oakPackage.version}`;

function loadHeight(): number {
  const n = Number(kv.getItem(HEIGHT_KEY));
  return Number.isFinite(n) && n >= MIN_HEIGHT ? n : DEFAULT_HEIGHT;
}

type Props = {
  theme: "dark" | "light";
  /** Active pane's indicator ids — drives the Add/Remove button state. */
  indicators: string[];
  /** Same add/remove toggle the indicators dialog uses. */
  onToggleIndicator: (id: string) => void;
  /** Add a study (a new instance) to the focused chart: "Add to chart" of a built-in. */
  onAddIndicator: (id: string) => void;
  onClose: () => void;
};

export function OakScriptPanel(props: Props) {
  const [height, setHeight] = createSignal<number>(loadHeight());
  const [minimized, setMinimized] = createSignal(kv.getItem(MINIMIZED_KEY) === "1");
  // Maximized fills the chart-pane column; not persisted (restores docked).
  const [maximized, setMaximized] = createSignal(false);
  const [cursor, setCursor] = createSignal<{ line: number; col: number } | null>(null);
  let rootRef: HTMLElement | undefined;

  // ── Script store state ────────────────────────────────────────────────────
  // The editor's current item: a built-in shown read-only, else the stored
  // script `currentScript` (kept as the one to come back to).
  const startBuiltin = builtinTypeOf(scripts.currentScriptId() ?? "");
  const [currentScript, setCurrentScript] = createSignal(startBuiltin ? storedFallback() : scripts.ensureCurrentScript());
  const [builtin, setBuiltin] = createSignal<{ typeId: string; name: string; source: string } | null>(null);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [renaming, setRenaming] = createSignal(false);
  const [builtinDialog, setBuiltinDialog] = createSignal(false);
  let importInputRef: HTMLInputElement | undefined;

  /** A stored script to hold while a built-in is current (the current id stays the built-in's); none stored: an
   *  empty placeholder, not saved (opening a built-in creates no script). */
  function storedFallback(): scripts.OakScript {
    const first = scripts.listScripts()[0];
    return (first && scripts.loadScript(first.id)) || { id: "", name: "", source: "", createdAt: 0, updatedAt: 0 };
  }

  /** Name and id of what the editor shows. */
  const shownName = () => builtin()?.name ?? currentScript().name;
  const shownId = () => {
    const b = builtin();
    return b ? builtinScriptId(b.typeId) : currentScript().id;
  };

  function openScript(id: string): void {
    const typeId = builtinTypeOf(id);
    if (typeId) {
      void openBuiltin(typeId);
      return;
    }
    const s = scripts.loadScript(id);
    if (!s) return;
    scripts.setCurrentScriptId(id);
    // Back from a built-in to the held script: the id does not change, so log here.
    if (builtin() && s.id === currentScript().id) {
      log("info", `"${s.name}" opened`);
      void compileScript(s.id, s.source);
    }
    setBuiltin(null);
    setCurrentScript(s);
    setIsStrategy(!!s.meta?.strategy);
  }

  /** Show built-in `typeId` read-only (its source loads first). */
  async function openBuiltin(typeId: string): Promise<void> {
    const source = await loadBuiltinSource(typeId);
    if (source === undefined) return;
    const name = builtinName(typeId);
    scripts.setCurrentScriptId(builtinScriptId(typeId));
    const was = builtin();
    setBuiltin({ typeId, name, source });
    setIsStrategy(false);
    if (was?.typeId !== typeId) log("info", `"${name}" opened`);
  }
  if (startBuiltin) onMount(() => void openBuiltin(startBuiltin));

  // The legends show "Opened in OakScript Editor" on the studies of the shown script.
  createEffect(() => setOpenedScript(shownId()));
  onCleanup(() => setOpenedScript(null));

  // Legend "Source code" of a study: its script in the editor, the panel
  // restored when minimized.
  onCleanup(
    onAppEvent(OAKSCRIPT_OPEN_EVENT, (d) => {
      const id = d?.scriptId;
      if (!id) return;
      openScript(id);
      setMinimized(false);
    }),
  );

  // ── Console + execution engine ────────────────────────────────────────────
  type LogEntry = {
    time: string;
    kind: "info" | "error";
    text: string;
    loc?: { line: number; col: number };
  };
  const [consoleOpen, setConsoleOpen] = createSignal(kv.getItem(CONSOLE_KEY) === "1");
  const [logs, setLogs] = createSignal<LogEntry[]>([]);
  let consoleRef: HTMLDivElement | undefined;
  // Shared with the chart layer — a script compiled here is hot for chart runs.
  const engine = getOakEngine();
  // A script that declares strategy() goes on the chart as a strategy
  // (Strategy Tester) rather than as an indicator.
  const [isStrategy, setIsStrategy] = createSignal(!!currentScript().meta?.strategy);
  const chartIdsOf = (scriptId: string) => [userIndicatorId(scriptId), userStrategyId(scriptId)];
  /** The type id this script is on the chart with (any instance), if any. */
  const idOnChart = () => chartIdsOf(currentScript().id).find((id) => props.indicators.some((x) => typeIdOf(x) === id));
  const onChart = () => idOnChart() !== undefined;
  function toggleOnChart(): void {
    // A built-in: "Add to chart" adds the built-in study (one more instance), as the reference does.
    const b = builtin();
    if (b) {
      props.onAddIndicator(b.typeId);
      log("info", `"${b.name}" added to chart.`);
      return;
    }
    const id = currentScript().id;
    props.onToggleIndicator(idOnChart() ?? (isStrategy() ? userStrategyId(id) : userIndicatorId(id)));
  }

  function log(kind: LogEntry["kind"], text: string, loc?: LogEntry["loc"]): void {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    setLogs((l) => [...l.slice(-(MAX_LOG_ENTRIES - 1)), { time, kind, text, loc }]);
  }

  async function compileScript(scriptId: string, source: string): Promise<void> {
    const name = scripts.loadScript(scriptId)?.name ?? "script";
    log("info", "Compiling...");
    try {
      const meta = await engine.compile(scriptId, source);
      // Persist the compiled shape and redraw the study on any chart using it.
      notifyScriptCompiled(scriptId, meta);
      notifyUserStrategyCompiled(scriptId, meta);
      if (scriptId === currentScript().id) setIsStrategy(!!meta.strategy);
      log("info", `"${name}" compiled.`);
    } catch (err) {
      if (err instanceof OakEngineError) {
        const { line, col } = err.detail;
        log("error", err.detail.message, line !== undefined ? { line, col: col ?? 1 } : undefined);
      } else {
        log("error", String(err));
      }
    }
  }

  // Opening a script (including the initial one) logs + compiles it. When the
  // editor opens on a built-in, the held stored script is not "opened".
  let holding = !!startBuiltin;
  createEffect(
    on(
      () => currentScript().id,
      (id) => {
        if (holding) {
          holding = false;
          return;
        }
        const s = scripts.loadScript(id);
        if (!s) return;
        log("info", `"${s.name}" opened`);
        void compileScript(id, s.source);
      },
    ),
  );

  // ── Script menu actions ───────────────────────────────────────────────────
  /** "Make a copy…": the reference's "Make copy of script" dialog, name "<name> copy" selected; the copy is a
   *  stored script, opened. */
  function copyScript(): void {
    const b = builtin();
    const held = currentScript();
    showRename({
      title: "Make copy of script",
      label: "New script name",
      maxLength: 128,
      names: [],
      replaceText: () => "",
      initialValue: `${shownName()} copy`,
      saveText: "Make copy",
      onSave: (name) => {
        const copy = b ? scripts.createScript(name, b.source) : scripts.duplicateScript(held.id, name);
        if (copy) openScript(copy.id);
      },
    });
  }

  /** Banner link "make a copy.": a new script with the built-in's source, named as a new script is
   *  ("Untitled script"; the reference opens an unsaved "Untitled script"). */
  function copyBuiltinQuick(): void {
    const b = builtin();
    if (!b) return;
    openScript(scripts.createScript(undefined, b.source).id);
  }

  /** Built-in… dialog pick: a new script with that built-in's source. */
  async function newFromBuiltin(typeId: string): Promise<void> {
    setBuiltinDialog(false);
    const source = await loadBuiltinSource(typeId);
    if (source === undefined) return;
    openScript(scripts.createScript(undefined, source).id);
  }

  function createNewScript(): void {
    const s = scripts.createScript();
    openScript(s.id);
  }

  function commitRename(value: string): void {
    setRenaming(false);
    const id = currentScript().id;
    scripts.renameScript(id, value);
    const s = scripts.loadScript(id);
    if (!s) return;
    notifyScriptRenamed(id);
    setCurrentScript(s);
  }

  function exportScript(): void {
    const s = builtin() ?? currentScript();
    const url = URL.createObjectURL(new Blob([s.source], { type: "text/javascript" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${s.name.replace(/[\\/:*?"<>|]/g, "_")}.js`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importScript(file: File): void {
    void file.text().then((text) => {
      const name = file.name.replace(/\.[^.]*$/, "") || "Imported script";
      const s = scripts.createScript(name);
      scripts.saveSource(s.id, text);
      openScript(s.id);
    });
  }

  function deleteScript(): void {
    if (builtin()) return; // a built-in cannot be deleted
    const s = currentScript();
    for (const uid of chartIdsOf(s.id)) {
      if (props.indicators.some((x) => typeIdOf(x) === uid)) props.onToggleIndicator(uid); // pull it off the chart
    }
    dropUserScriptRuntime(s.id);
    dropUserStrategy(s.id);
    scripts.deleteScript(s.id);
    log("info", `"${s.name}" deleted.`);
    // Fall back to the next stored script, or a fresh template.
    const next = scripts.listScripts()[0];
    if (next) openScript(next.id);
    else {
      const fresh = scripts.ensureCurrentScript();
      setCurrentScript(fresh);
      setIsStrategy(!!fresh.meta?.strategy);
    }
  }

  // Pin the console to its newest entry.
  createEffect(() => {
    logs();
    if (consoleRef) consoleRef.scrollTop = consoleRef.scrollHeight;
  });

  createEffect(() => {
    kv.setItem(HEIGHT_KEY, String(Math.round(height())));
    kv.setItem(MINIMIZED_KEY, minimized() ? "1" : "0");
    kv.setItem(CONSOLE_KEY, consoleOpen() ? "1" : "0");
  });

  /** Parent is the chart-pane flex column (chart canvas + this + BottomBar). */
  const maxHeight = () => Math.max(MIN_HEIGHT, (rootRef?.parentElement?.clientHeight ?? 0) - CHART_MIN);

  function beginResize(e: MouseEvent) {
    if (minimized() || maximized()) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = height();
    const maxH = maxHeight();
    const onMove = (ev: MouseEvent) =>
      setHeight(Math.min(maxH, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY))));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const styleHeight = () => {
    if (maximized()) return "100%";
    if (minimized()) return "auto"; // header only
    return `${height()}px`;
  };

  return (
    <section
      ref={rootRef}
      class="oak-panel"
      style={{ height: styleHeight() }}
      aria-label="OakScript Editor"
    >
      <Show when={!minimized() && !maximized()}>
        <div
          class="oak-panel__resizer"
          onMouseDown={beginResize}
          role="separator"
          aria-orientation="horizontal"
          title="Resize"
        />
      </Show>
      <header class="oak-panel__header">
        <div class="oak-panel__header-left">
          <Show
            when={!renaming()}
            fallback={
              <input
                class="oak-panel__rename-input"
                value={currentScript().name}
                ref={(el) => setTimeout(() => { el.focus(); el.select(); })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename((e.currentTarget as HTMLInputElement).value);
                  else if (e.key === "Escape") setRenaming(false);
                }}
                onBlur={(e) => commitRename((e.currentTarget as HTMLInputElement).value)}
              />
            }
          >
            <button
              type="button"
              class="oak-panel__name-btn"
              aria-haspopup="menu"
              aria-expanded={menuOpen()}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span class="oak-panel__logo">
                <Icon name="rr-pine-dialog-button" size={18} />
              </span>
              <span class="oak-panel__title">{shownName()}</span>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M2.5 7.5 6 4l3.5 3.5" stroke="currentColor" stroke-width="1.2" />
              </svg>
            </button>
          </Show>
          <Show when={menuOpen()}>
            <OakScriptMenu
              scriptsList={scripts.recentScripts((id) => {
                const t = builtinTypeOf(id);
                return t ? builtinName(t) : undefined;
              })}
              currentId={shownId()}
              readOnly={builtin() !== null}
              onSelect={openScript}
              onCopy={copyScript}
              onRename={() => setRenaming(true)}
              onCreateNew={createNewScript}
              onBuiltin={() => setBuiltinDialog(true)}
              onExport={exportScript}
              onImport={() => importInputRef?.click()}
              onDelete={deleteScript}
              onClose={() => setMenuOpen(false)}
            />
          </Show>
          <input
            ref={importInputRef}
            type="file"
            accept=".js,.mjs,.ts,text/javascript"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = (e.currentTarget as HTMLInputElement).files?.[0];
              if (file) importScript(file);
              (e.currentTarget as HTMLInputElement).value = "";
            }}
          />
        </div>
        <div class="oak-panel__header-right">
          <button
            type="button"
            class="oak-panel__action-btn"
            onClick={toggleOnChart}
          >
            {!builtin() && onChart() ? "Remove from chart" : "Add to chart"}
          </button>
          <Tooltip text={minimized() ? "Restore" : "Minimize"} side="top">
            <button
              type="button"
              class="oak-panel__chrome-btn"
              aria-label={minimized() ? "Restore" : "Minimize"}
              onClick={() => {
                setMaximized(false);
                setMinimized((m) => !m);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d={minimized() ? "M4 9.5 8 5.5l4 4" : "M4 6.5l4 4 4-4"}
                  stroke="currentColor"
                  stroke-width="1.2"
                />
              </svg>
            </button>
          </Tooltip>
          <Tooltip text={maximized() ? "Restore" : "Maximize"} side="top">
            <button
              type="button"
              class="oak-panel__chrome-btn"
              aria-label={maximized() ? "Restore" : "Maximize"}
              onClick={() => {
                setMinimized(false);
                setMaximized((m) => !m);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <Show
                  when={maximized()}
                  fallback={<rect x="3.5" y="3.5" width="9" height="9" stroke="currentColor" stroke-width="1.2" />}
                >
                  <path d="M5.5 3.5h7v7M3.5 5.5h7v7h-7z" stroke="currentColor" stroke-width="1.2" />
                </Show>
              </svg>
            </button>
          </Tooltip>
          <Tooltip text="Close" side="top">
            <button
              type="button"
              class="oak-panel__chrome-btn"
              aria-label="Close"
              onClick={props.onClose}
            >
              <Icon name="tab-close" size={16} />
            </button>
          </Tooltip>
        </div>
      </header>
      <Show when={builtin() && !minimized()}>
        <div class="oak-panel__readonly" role="note" data-qa-id="oakscript-readonly">
          <span class="oak-panel__readonly-icon" aria-hidden="true">
            <svg viewBox="0 0 18 18" width="22" height="22">
              <path fill="currentColor" fill-rule="evenodd" d="M9 1a8 8 0 1 1 0 16A8 8 0 0 1 9 1Zm-.9 3.5h1.8l-.3 6.2H8.4l-.3-6.2ZM9 12a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
            </svg>
          </span>
          <span>
            <span class="oak-panel__readonly-header">This script is read-only.</span>
            <span>To edit its code you can</span>
            <a class="oak-panel__readonly-link" role="button" onClick={copyBuiltinQuick}>make a copy.</a>
          </span>
        </div>
      </Show>
      <Show when={builtinDialog()}>
        <BuiltinScriptDialog onPick={(t) => void newFromBuiltin(t)} onClose={() => setBuiltinDialog(false)} />
      </Show>
      <Show when={!minimized()}>
        <div class="oak-panel__body">
          <Suspense fallback={<div class="ot-empty-state">Loading editor…</div>}>
            <OakScriptEditor
              theme={props.theme}
              scriptId={currentScript().id}
              readOnly={builtin() ? { id: builtinScriptId(builtin()!.typeId), source: builtin()!.source } : null}
              onCursor={(line, col) => setCursor({ line, col })}
              onSaved={(scriptId, source) => void compileScript(scriptId, source)}
            />
          </Suspense>
        </div>
        <Show when={consoleOpen()}>
          <div class="oak-console" ref={consoleRef} role="log" aria-label="OakScript console">
            <For each={logs()}>
              {(e) => (
                <div class={"oak-console__row" + (e.kind === "error" ? " oak-console__row--error" : "")}>
                  <span class="oak-console__time">{e.time}</span>
                  <span class="oak-console__msg">
                    <Show when={e.loc}>
                      <span class="oak-console__badge">{`Error at ${e.loc!.line}:${e.loc!.col}`}</span>
                    </Show>
                    {e.text}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
        <footer class="oak-panel__status">
          <div class="oak-panel__status-left">
            <Tooltip text="Console" side="top">
              <button
                type="button"
                class="oak-panel__chrome-btn"
                aria-label="Console"
                aria-pressed={consoleOpen()}
                onClick={() => setConsoleOpen((o) => !o)}
              >
                <Icon name="oak-console" size={16} />
              </button>
            </Tooltip>
          </div>
          <div class="oak-panel__status-right">
            <Show when={cursor()}>
              {(c) => (
                <span class="oak-panel__status-item">{`Line ${c().line}, Col ${c().col}`}</span>
              )}
            </Show>
            <span class="oak-panel__status-item">{ENGINE_LABEL}</span>
          </div>
        </footer>
      </Show>
    </section>
  );
}
