/*
 * Global keyboard shortcuts of the window. Window/alert shortcuts fire
 * regardless of chart focus; everything else is suppressed while a text
 * field is focused or a modal dialog already owns the keyboard:
 *   Alt+A         → Create alert;       Ctrl/Cmd+N → new window;
 *   Ctrl/Cmd+S    → Save layout;
 *   Shift+F       → fullscreen;         "/"        → Indicators dialog;
 *   Alt+R/I/L/P   → reset / invert / log / percent scale (focused pane);
 *   Ctrl+Alt+S    → download image;     Ctrl+Shift+S → copy image;
 *   Ctrl+↑/↓      → zoom in / out;      Ctrl+←/→   → jump left / right;
 *   Space/Shift+Sp → next / prev watchlist symbol (even off the list);
 *   ←/→           → scroll one bar;     ","        → chart-interval menu;
 *   any digit     → chart-interval menu (type a number to change frame);
 *   any letter    → Symbol search seeded with that character.
 * Chart pan/zoom/scale/snapshot are sent as app events; the focused
 * ChartView pane handles them (see ChartView's chart-* listeners). The shell
 * hotkeys (tab cycling, Ctrl+T / F4 / U / W / R, F5) act on the tabs.
 */
import { emitAppEvent } from "../../data/app-events";
import { isIntradayInterval, tickerOf, type SessionId } from "../../data/datafeed";
import { requestDataWindow } from "../../data/data-window-store";
import { requestOpenList, watchlistStore } from "../../data/watchlist-store";
import { activeChartProbe } from "../chart/active-chart";
import { selectedDrawingId } from "../drawings/drawing-selection";
import { openNewWindow, toggleFullscreen } from "./window-bridge";
import type { AppTabs } from "./app-tabs";
import {
  openMenuAt,
  openSymbolSearch,
  setActiveRailTab,
  setAlertDialog,
  setAppSettingsTab,
  setIndicatorsDialogOpen,
  setIntervalDialog,
} from "./app-dialogs";

/** What the shortcuts act on (App's state and operations). */
export type ShortcutActions = {
  tabs: Pick<
    AppTabs,
    "tabs" | "activeTabId" | "activeTab" | "activateTab" | "newTab" | "closeTab" | "duplicateTab" | "reloadTab" | "reopenClosed" | "setActivePaneIndex"
  >;
  symbol: () => string;
  interval: () => string;
  session: () => SessionId;
  setSession: (id: SessionId) => void;
  undo: () => void;
  redo: () => void;
  saveLayout: () => void;
  openLayoutBrowser: () => void;
};

/** Listen to the shortcuts (document keydown / keyup, window blur). Returns
 *  the disposer. */
export function installKeyboardShortcuts(a: ShortcutActions): () => void {
  const { tabs, activeTabId, activeTab, activateTab, newTab, closeTab, duplicateTab, reloadTab, reopenClosed, setActivePaneIndex } = a.tabs;
  const { symbol, interval, session, setSession } = a;
  // Arrow key currently driving a held scroll — plain (moveByBar) or Ctrl
  // (move). One slot for both: the two gestures share one animation, so
  // only one can be live.
  let pannedKey: string | null = null;
  const onKey = (e: KeyboardEvent) => {
    // Shell hotkeys. They apply whatever holds focus: tab cycling wraps
    // around, Ctrl+1..8 picks tab N, Ctrl+9 the last one.
    if (e.ctrlKey && !e.metaKey && !e.altKey) {
      const list = tabs();
      const cur = list.findIndex((t) => t.id === activeTabId());
      const go = (i: number) => {
        e.preventDefault();
        const t = list[(i + list.length) % list.length];
        if (t) activateTab(t.id);
      };
      if (!e.shiftKey && (e.code === "PageDown" || e.code === "Numpad3" || e.key === "Tab")) return go(cur + 1);
      if ((e.shiftKey && e.key === "Tab") || (!e.shiftKey && (e.code === "PageUp" || e.code === "Numpad9"))) return go(cur - 1);
      if (!e.shiftKey && /^Digit[1-8]$/.test(e.code)) {
        e.preventDefault();
        const t = list[Number(e.code.slice(5)) - 1];
        if (t) activateTab(t.id);
        return;
      }
      if (!e.shiftKey && e.code === "Digit9") return go(list.length - 1);
      if (!e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        newTab();
        return;
      }
      if (!e.shiftKey && e.code === "F4") {
        e.preventDefault();
        closeTab(activeTabId());
        return;
      }
      if (!e.shiftKey && e.code === "Comma") {
        e.preventDefault();
        setAppSettingsTab("general");
        return;
      }
    }
    // F5 → reload the active tab, not the webview.
    if (e.code === "F5" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      reloadTab(activeTabId());
      return;
    }
    // Ctrl+Alt+Q → reset the time scale only. AltGr
    // reports as Ctrl+Alt on Windows intl layouts: ignore it, as for Ctrl+Alt+S.
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.code === "KeyQ" && !e.getModifierState?.("AltGraph")) {
      const tgt = e.target as HTMLElement | null;
      const typing = !!(tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable));
      if (!typing && !document.querySelector('[role="dialog"]')) {
        e.preventDefault();
        emitAppEvent("chart-reset-time");
        return;
      }
    }
    // Snapshot combos: Ctrl+Alt+S → download image, Ctrl+Shift+S → copy
    // image. Skip while a text field is focused or a modal owns the keyboard
    // (so the keystroke isn't eaten), and ignore AltGr+S — on Windows intl
    // layouts AltGr reports as Ctrl+Alt, so typing e.g. 'ś' must not download.
    if (e.ctrlKey && !e.metaKey && e.code === "KeyS") {
      const tgt = e.target as HTMLElement | null;
      const typing = !!(tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable));
      const modal = !!document.querySelector('[role="dialog"]');
      if (!typing && !modal) {
        if (e.altKey && !e.shiftKey && !e.getModifierState?.("AltGraph")) {
          e.preventDefault();
          emitAppEvent("chart-snapshot", { action: "download" });
          return;
        }
        if (e.shiftKey && !e.altKey) {
          e.preventDefault();
          emitAppEvent("chart-snapshot", { action: "copy" });
          return;
        }
      }
    }
    // Alt+A → Create alert. Handled before the modifier guard.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "a" || e.key === "A")) {
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      // On the selected study when it is a source, at the crosshair price.
      setAlertDialog({ symbol: symbol(), ...(activeChartProbe()?.alertTarget?.() ?? {}) });
      return;
    }
    // Ctrl/Cmd+Z → undo drawing change; Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y →
    // redo. Skipped while typing / while a modal owns the keyboard.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "z" || e.key === "Z")) {
      const tgt = e.target as HTMLElement | null;
      const typing = !!(tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable));
      if (typing || document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      if (e.shiftKey) a.redo();
      else a.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "y" || e.key === "Y")) {
      const tgt = e.target as HTMLElement | null;
      const typing = !!(tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable));
      if (typing || document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      a.redo();
      return;
    }
    // Ctrl/Cmd+R → reload the active tab (also stops the
    // webview's own page reload).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      reloadTab(activeTabId());
      return;
    }
    // Ctrl/Cmd+Shift+T → reopen the newest closed tab / window.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey && (e.key === "t" || e.key === "T")) {
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      void reopenClosed();
      return;
    }
    // Ctrl/Cmd+N → open a new window. No-op off-shell, where we let the
    // browser keep its native shortcut.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "n" || e.key === "N")) {
      if (openNewWindow()) e.preventDefault();
      return;
    }
    // Ctrl/Cmd+S → save the active chart layout ("Save layout").
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "s" || e.key === "S")) {
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      a.saveLayout();
      return;
    }
    // Ctrl+U / Ctrl+W → duplicate / close the active tab (the hotkeys the
    // tab context menu advertises). Safe to claim in a Tauri webview — there
    // is no browser chrome for Ctrl+W to collide with. Suppressed while a
    // text field is focused (inline watchlist inputs etc.), like Ctrl+Z.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === "KeyU" || e.code === "KeyW")) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || el.closest?.(".monaco-editor"))) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      if (e.code === "KeyU") duplicateTab(activeTabId());
      else closeTab(activeTabId());
      return;
    }
    const t = e.target as HTMLElement | null;
    // monaco 0.5x types through the EditContext API — its key events target a
    // plain div (only an IME fallback textarea exists), so the OakScript
    // editor must be recognized structurally, not by tag.
    const editable = !!(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest?.(".monaco-editor")));
    const blocked = editable || !!document.querySelector('[role="dialog"]');
    // Space / Shift+Space → load the next / previous watchlist symbol, even
    // when the chart (not the watchlist) holds focus. When the watchlist
    // itself is focused, its own key handler runs — defer to it here so the
    // symbol doesn't advance twice.
    if ((e.code === "Space" || e.key === " ") && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (blocked) return;
      if ((document.activeElement as HTMLElement | null)?.closest?.(".watchlist-rows")) return;
      e.preventDefault();
      emitAppEvent("watchlist-navigate", { dir: e.shiftKey ? -1 : 1 });
      return;
    }
    // Shift+F → toggle fullscreen. Skip while typing so capital F works.
    if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "F" || e.key === "f")) {
      if (blocked) return;
      e.preventDefault();
      void toggleFullscreen();
      return;
    }
    // Shift+W → open the watchlist "Open list" picker. Surface the rail's
    // watchlist tab first, then flag the request the panel consumes on mount.
    if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "W" || e.key === "w")) {
      if (blocked) return;
      e.preventDefault();
      setActiveRailTab("base");
      requestOpenList();
      return;
    }
    // Trading hotkeys (reference app, bound whether or not a broker is
    // connected): Shift+B buy, Shift+S sell, Shift+T order ticket, and
    // Alt+Shift+B / Alt+Shift+S limit orders (the Alt+Shift block below).
    // They run the chart menu's Buy / Sell / Add order rows, which have no
    // trading backend in this app, so they do nothing; they no longer
    // start a symbol search with that letter.
    if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && (e.code === "KeyB" || e.code === "KeyS" || e.code === "KeyT")) {
      if (blocked) return;
      e.preventDefault();
      return;
    }
    // Alt+Shift+→ / ← → jump to the most recent / the first bar on the focused
    // pane (control-bar hotkey, the same action as its goto-realtime arrow).
    // Kept above the Alt-only block, which requires !shiftKey.
    // Repeat-guarded like the held gestures: the guard covers all four arrow
    // branches, and without it holding the key would restart the 1s ease
    // every repeat, so the chart would only ever creep along its slow
    // opening frames.
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (blocked) return;
      // Alt+Shift+E → next session: intraday only,
      // cycles the symbol's sessions (Regular → Extended → Regular).
      // Alt+Shift+B / Alt+Shift+S: trading hotkeys (see Shift+B above).
      if (e.code === "KeyB" || e.code === "KeyS") { e.preventDefault(); return; }
      if (e.code === "KeyE") {
        e.preventDefault();
        if (!isIntradayInterval(interval())) return;
        const ids: SessionId[] = ["RTH", "ETH"];
        setSession(ids[(ids.indexOf(session()) + 1) % ids.length]);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        if (pannedKey !== null) return; // key repeat
        pannedKey = e.key;
        emitAppEvent(e.key === "ArrowRight" ? "chart-goto-realtime" : "chart-goto-first");
        return;
      }
    }
    // Alt+{R,I,L,P} → reset view / scale toggles on the focused pane. Other
    // Alt combos belong to drawing tools (Alt+T/H/F/V/C/J), Alt+G / Alt+Enter
    // (bottom bar), and Alt+Shift+R — left untouched here. Alt+S ("copy
    // link", a cloud action) is not offered.
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (blocked) return;
      if (e.code === "KeyR") { e.preventDefault(); emitAppEvent("chart-reset"); return; }
      if (e.code === "KeyI") { e.preventDefault(); emitAppEvent("chart-scale", { mode: "invert" }); return; }
      if (e.code === "KeyL") { e.preventDefault(); emitAppEvent("chart-scale", { mode: "log" }); return; }
      if (e.code === "KeyP") { e.preventDefault(); emitAppEvent("chart-scale", { mode: "percent" }); return; }
      // Alt+D → Object tree page on its Data window view.
      if (e.code === "KeyD") {
        e.preventDefault();
        setActiveRailTab("object_tree");
        requestDataWindow();
        return;
      }
      // Alt+W → add the focused symbol to the end of the active watchlist
      // (no anchor), deduped by the store.
      if (e.code === "KeyW") {
        e.preventDefault();
        const full = symbol();
        if (full) {
          watchlistStore.addSymbols(
            [{ ticker: full, short: tickerOf(full), last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null }],
            null,
          );
        }
        return;
      }
      return;
    }
    // Ctrl/Cmd + arrows → zoom (↑/↓) and the held accelerating pan (←/→) on
    // the focused pane. The pan starts on the FIRST keydown only, because
    // the motion builds speed off its own elapsed time and a repeat would
    // restart it at zero. `keyup` (below) ends it.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      if (blocked) return;
      if (e.key === "ArrowUp") { e.preventDefault(); emitAppEvent("chart-zoom", { dir: "in" }); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); emitAppEvent("chart-zoom", { dir: "out" }); return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        if (pannedKey !== null) return; // key repeat
        pannedKey = e.key;
        emitAppEvent("chart-scroll-start", { dir: e.key === "ArrowLeft" ? -1 : 1, mode: "smooth" });
        return;
      }
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (blocked) return;
    // Tab / Shift+Tab → cycle the focused pane ("switch between charts").
    // Single-pane layouts fall through to native focus traversal.
    if (e.key === "Tab") {
      const count = activeTab().panes.length;
      if (count <= 1) return;
      e.preventDefault();
      const cur = activeTab().activePane;
      setActivePaneIndex(e.shiftKey ? (cur - 1 + count) % count : (cur + 1) % count);
      return;
    }
    // Shift+→ / Shift+← → switch focused pane (alternate binding for Tab).
    if (e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const count = activeTab().panes.length;
      if (count <= 1) return;
      e.preventDefault();
      const cur = activeTab().activePane;
      setActivePaneIndex(e.key === "ArrowRight" ? (cur + 1) % count : (cur - 1 + count) % count);
      return;
    }
    // ←↑→↓ → nudge the selected drawing 1px; with nothing selected,
    // ←/→ scroll the chart (↑/↓ do nothing — no vertical pan).
    // Held ←/→ is moveByBar: a run that walks one bar, then speeds up the
    // longer it's held. Like the Ctrl variant it starts on the FIRST keydown
    // only and ends on keyup, so repeats must not restart it.
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (selectedDrawingId()) {
        e.preventDefault();
        const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
        emitAppEvent("drawing-nudge", { dx, dy });
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        if (pannedKey !== null) return; // key repeat
        pannedKey = e.key;
        emitAppEvent("chart-scroll-start", { dir: e.key === "ArrowLeft" ? -1 : 1, mode: "bar" });
      }
      return;
    }
    if (e.key === "/") {
      e.preventDefault();
      setIndicatorsDialogOpen(true);
    } else if (e.key === ".") {
      // "." → open the saved-layout browser ("Open layout").
      e.preventDefault();
      a.openLayoutBrowser();
    } else if (e.key.length === 1 && /[1-9]/.test(e.key)) {
      // A digit 1-9 → "Change interval" dialog with that digit, caret at
      // the end.
      e.preventDefault();
      setIntervalDialog({ initVal: e.key, selectOnInit: false });
    } else if (e.key === ",") {
      // "," → the chart-interval menu.
      e.preventDefault();
      const btn = document.querySelector<HTMLButtonElement>('[data-name="chart-interval"]');
      if (!btn) return;
      openMenuAt("chart-interval", btn.getBoundingClientRect());
    } else if (e.key.length === 1 && /[a-zA-Z0]/.test(e.key)) {
      // A letter (or 0, which is not an interval key) starts a symbol
      // lookup anywhere.
      e.preventDefault();
      openSymbolSearch(e.key);
    }
  };
  // Ends the held scroll. Keyed on the ARROW alone, so letting go of
  // Ctrl first still stops it. `blur` covers releasing the key while the
  // window is in the background, which never delivers a keyup.
  const onKeyUp = (e: KeyboardEvent) => {
    if (pannedKey === null || e.key !== pannedKey) return;
    pannedKey = null;
    emitAppEvent("chart-scroll-stop");
  };
  const onBlur = () => {
    if (pannedKey === null) return;
    pannedKey = null;
    emitAppEvent("chart-scroll-stop");
  };
  document.addEventListener("keydown", onKey);
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  return () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}
