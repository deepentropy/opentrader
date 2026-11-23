/*
 * The OakScript editor in a window of its own (#325, More menu "Open editor ▸ New window", desktop), linked to the
 * chart tab it came from (detached-editor.ts): the chart window tells it that tab's studies, and does what the
 * editor asks of the chart (Add to chart, Logs, In-place) and of its script runtime (a script compiled, renamed or
 * deleted here). "Unlinked" once that tab or its window is gone. The window keeps its size for the next one.
 */
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createAppTheme } from "../shell/app-theme";
import { currentWindowLabel } from "../shell/window-bridge";
import { DialogHost } from "../../components/Dialogs";
import { SavedFileToast } from "../shell/SavedFileToast";
import { emitAppEvent } from "../../data/app-events";
import * as scripts from "../../data/oakscript-store";
import { OakScriptPanel } from "./OakScriptPanel";
import { shownScriptName } from "./editor-state";
import { OAKSCRIPT_OPEN_EVENT } from "../chart/indicators/user-scripts";
import {
  editorWindowTitle,
  LINK_REQUEST,
  LINK_SHOW,
  LINK_STATE,
  rememberEditorWindowSize,
  type LinkRequest,
  type LinkShow,
  type LinkState,
} from "./detached-editor";

type RequestBody = LinkRequest extends infer R ? (R extends unknown ? Omit<R, "from" | "tab"> : never) : never;

export function OakScriptWindow() {
  const { theme, observeTheme } = createAppTheme();
  const params = new URLSearchParams(location.search);
  const parent = params.get("parent") ?? "main";
  const [tab, setTab] = createSignal(params.get("tab") ?? "");
  /** The linked tab's studies; null: the tab, or its window, is gone. */
  const [studies, setStudies] = createSignal<string[] | null>(null);
  const me = currentWindowLabel();
  const win = getCurrentWebviewWindow();

  const ask = (body: RequestBody) =>
    void emitTo(parent, LINK_REQUEST, { ...body, from: me, tab: tab() } as LinkRequest).catch(() => undefined);

  onMount(() => {
    observeTheme();
    const offState = listen<LinkState>(LINK_STATE, (e) => {
      if (e.payload.tab === tab()) setStudies(e.payload.indicators);
    });
    // The chart asks for the editor (another tab's "Open editor", a study's "Source code"): linked to that tab, the
    // script shown.
    const offShow = listen<LinkShow>(LINK_SHOW, (e) => {
      if (e.payload.tab !== tab()) {
        setTab(e.payload.tab);
        ask({ op: "hello" });
      }
      if (e.payload.scriptId) emitAppEvent(OAKSCRIPT_OPEN_EVENT, { scriptId: e.payload.scriptId });
    });
    // The chart window closed: unlinked.
    let offGone: (() => void) | undefined;
    void WebviewWindow.getByLabel(parent).then((p) => {
      if (!p) return setStudies(null);
      void p.once("tauri://destroyed", () => setStudies(null)).then((f) => (offGone = f));
    });
    const offClose = win.onCloseRequested(() => ask({ op: "bye" }));
    let sizeTimer: number | undefined;
    const onResize = () => {
      clearTimeout(sizeTimer);
      sizeTimer = window.setTimeout(() => rememberEditorWindowSize(window.innerWidth, window.innerHeight), 500);
    };
    window.addEventListener("resize", onResize);
    // Listening first, so the answer is not missed.
    void Promise.all([offState, offShow]).then(() => ask({ op: "hello" }));
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      void offState.then((f) => f());
      void offShow.then((f) => f());
      void offClose.then((f) => f());
      offGone?.();
    });
  });

  createEffect(() => {
    const name = shownScriptName();
    if (name) void win.setTitle(editorWindowTitle(name)).catch(() => undefined);
  });

  return (
    <div class="oak-editor-window">
      <OakScriptPanel
        theme={theme()}
        placement="window"
        linked={studies() !== null}
        indicators={studies() ?? []}
        onToggleIndicator={(typeId) => ask({ op: "toggle", typeId })}
        onAddIndicator={(typeId) => ask({ op: "add", typeId })}
        onClose={() => void win.close()}
        onOpenEditor={(where) => {
          if (where !== "in-place") return;
          ask({ op: "in-place", scriptId: scripts.currentScriptId() ?? "" });
          void win.close();
        }}
        onLogs={(scriptId) => ask({ op: "logs", scriptId })}
        onScriptChange={(c) => ask(c.kind === "compiled" ? { op: "compiled", scriptId: c.scriptId, source: c.source } : { op: c.kind, scriptId: c.scriptId })}
      />
      <DialogHost />
      <SavedFileToast />
    </div>
  );
}
