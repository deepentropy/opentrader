/*
 * Logs panel (#323): the log.*() messages of a script's study, in the right-side panel, as the reference app shows
 * them: the study's name as title; a toolbar with "Disable logging" (the list stops following the runs), Search and a
 * menu (Filter levels: Info / Warning / Error, Download logs); one row per message "[bar time]: text", coloured by
 * level, with "Source code" (its line in the editor) and "Scroll to bar" (the chart goes to its bar) on hover; a
 * "Scroll down" button while the list is not at its end.
 *
 * The toolbar's clock (#325) asks for a start date (date, time and calendar, in the chart's time zone): the list
 * then starts at that time, shown under the toolbar as a tag whose cross removes it. Download logs gives the
 * messages the filters show.
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import type { LogEntry, LogLevel } from "oakscriptjs/script";
import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/IconButton";
import { PanelHeader } from "../../../components/PanelHeader";
import { Tooltip } from "../../../components/Tooltip";
import { createPopover } from "../../../components/popover";
import { CheckMarkBox } from "../../../components/form";
import { emitAppEvent, onAppEvent } from "../../../data/app-events";
import * as scripts from "../../../data/oakscript-store";
import { dateText } from "../../../i18n/format";
import { formatted, translate } from "../../../i18n/translator";
import { GoToDateDialog } from "../../bottom-bar/GoToDateDialog";
import { OAKSCRIPT_OPEN_EVENT, OAKSCRIPT_UPDATED_EVENT } from "../../chart/indicators/user-scripts";
import { STRATEGY_UPDATED_EVENT } from "../../chart/indicators/strategy-entries";
import { setRevealRequest } from "../editor-state";
import { logsTarget, readScriptLogs } from "./script-logs";
import { filterLogs, startDateNow, startDateSeconds } from "./log-filter";

const LEVELS: { level: LogLevel; label: string }[] = [
  { level: "info", label: "Info" },
  { level: "warning", label: "Warning" },
  { level: "error", label: "Error" },
];

type Props = {
  /** The chart's time zone (IANA): the bar times of the messages. */
  timeZone?: string;
  onClose: () => void;
};

/** A message's bar time as shown, seconds in the chart's time zone. */
function logTime(time: number, timeZone?: string): string {
  return dateText(
    time * 1000,
    { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
    timeZone,
  );
}

/** The start date's tag: "12 November 2026, 16:33" in the chart's time zone. */
function startText(time: number, timeZone?: string): string {
  return dateText(time * 1000, { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, timeZone);
}

export function ScriptLogsPanel(props: Props) {
  const [logs, setLogs] = createSignal<LogEntry[] | null>(null);
  const [paused, setPaused] = createSignal(false);
  const [levels, setLevels] = createSignal<Record<LogLevel, boolean>>({ info: true, warning: true, error: true });
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [atEnd, setAtEnd] = createSignal(true);
  /** UNIX seconds of the first message time shown; null: no start date. */
  const [from, setFrom] = createSignal<number | null>(null);
  const [startAnchor, setStartAnchor] = createSignal<DOMRect | null>(null);
  let list!: HTMLDivElement;
  let moreBtn!: HTMLButtonElement;
  let startBtn!: HTMLButtonElement;
  /** The time zone the start date is picked in: the chart's, as the messages' times. */
  const zone = () => props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const title = () => {
    const t = logsTarget();
    return t ? (scripts.loadScript(t.scriptId)?.name ?? "") : "";
  };

  const read = () => {
    const t = logsTarget();
    if (!t || paused()) return;
    setLogs(readScriptLogs(t));
  };
  createEffect(on(logsTarget, read));
  createEffect(on(paused, (p) => { if (!p) read(); }));
  onCleanup(onAppEvent(OAKSCRIPT_UPDATED_EVENT, (d) => { if (d.scriptId === logsTarget()?.scriptId) read(); }));
  onCleanup(onAppEvent(STRATEGY_UPDATED_EVENT, read));

  const shown = createMemo(() => filterLogs(logs() ?? [], { levels: levels(), query: query(), from: from() }));

  // The list follows the newest messages while it is at its end. The rows off screen have an estimated height until
  // they are shown (content-visibility), so the end is reached over a few frames; those scrolls are not the user's.
  let following = 0;
  const toEnd = () => {
    following = 3;
    const step = () => {
      list.scrollTop = list.scrollHeight;
      if (--following > 0) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  createEffect(on(shown, () => {
    if (atEnd()) toEnd();
  }));
  const onScroll = () => {
    if (following > 0) return;
    setAtEnd(list.scrollHeight - list.scrollTop - list.clientHeight < 4);
  };

  const showSource = (e: LogEntry) => {
    const t = logsTarget();
    if (!t || e.line === undefined) return;
    setRevealRequest({ scriptId: t.scriptId, line: e.line });
    emitAppEvent(OAKSCRIPT_OPEN_EVENT, { scriptId: t.scriptId });
  };

  const download = () => {
    const text = shown().map((e) => `[${logTime(e.time, props.timeZone)}] ${e.level.toUpperCase()}: ${e.message}`).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title().replace(/[\\/:*?"<>|]/g, "_") || "script"} logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside class="ot-rail-panel oak-logs-panel" aria-label="Logs">
      <PanelHeader
        ariaLabel="Logs header"
        left={<span class="oak-logs-panel__title" data-no-translate>{title()}</span>}
        right={
          <Tooltip text={translate("Close")} side="bottom">
            <IconButton aria-label="Close" onClick={props.onClose}>
              <Icon name="tab-close" size={18} />
            </IconButton>
          </Tooltip>
        }
      />
      <div class="oak-logs-panel__toolbar">
        <Tooltip text={paused() ? "Enable logging" : "Disable logging"} side="bottom">
          <IconButton aria-label={paused() ? "Enable logging" : "Disable logging"} aria-pressed={paused()} onClick={() => setPaused((p) => !p)}>
            <Icon name={paused() ? "replay-play" : "replay-pause"} size={20} />
          </IconButton>
        </Tooltip>
        <span class="oak-logs-panel__spacer" />
        <Tooltip text="Search" side="bottom">
          <IconButton aria-label="Search" aria-pressed={searching()} onClick={() => { setSearching((s) => !s); if (!searching()) setQuery(""); }}>
            <Icon name="scr-search" size={24} />
          </IconButton>
        </Tooltip>
        <Tooltip text="Start date" side="bottom">
          <IconButton
            ref={(el: HTMLButtonElement) => (startBtn = el)}
            aria-label="Start date"
            aria-haspopup="dialog"
            aria-expanded={startAnchor() !== null}
            onClick={() => setStartAnchor(startAnchor() ? null : startBtn.getBoundingClientRect())}
          >
            <Icon name="oak-logs-start-date" size={24} />
          </IconButton>
        </Tooltip>
        <Tooltip text="Settings" side="bottom">
          <IconButton ref={(el: HTMLButtonElement) => (moreBtn = el)} aria-label="Settings" aria-haspopup="menu" aria-expanded={menuOpen()} onClick={() => setMenuOpen((o) => !o)}>
            <Icon name="dt-more" size={24} />
          </IconButton>
        </Tooltip>
      </div>
      <Show when={searching()}>
        <div class="oak-logs-panel__search">
          <input
            class="oak-logs-panel__search-input"
            type="search"
            placeholder={translate("Search")}
            value={query()}
            ref={(el) => setTimeout(() => el.focus())}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setSearching(false); setQuery(""); } }}
          />
        </div>
      </Show>
      <Show when={from()}>
        {(f) => (
          <div class="oak-logs-panel__start">
            <span class="oak-logs-tag">
              <Icon name="oak-logs-start-date" size={28} />
              <span class="oak-logs-tag__text" data-no-translate>{formatted(startText(f(), props.timeZone))}</span>
              <button type="button" class="oak-logs-tag__close" aria-label="Close" onClick={() => setFrom(null)}>
                <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                  <path stroke="currentColor" d="M5 5l8 8M13 5l-8 8" />
                </svg>
              </button>
            </span>
          </div>
        )}
      </Show>
      <Show when={startAnchor()}>
        {(rect) => {
          const now = startDateNow(Date.now(), zone());
          return (
            <GoToDateDialog
              anchor={rect()}
              initial={now}
              startDate={{ latest: now }}
              onSubmit={(date, minutes) => setFrom(startDateSeconds(date, minutes, zone()))}
              onClose={() => setStartAnchor(null)}
            />
          );
        }}
      </Show>
      <Show when={menuOpen()}>
        <LogsMenu anchor={moreBtn} levels={levels()} onLevel={(l) => setLevels((v) => ({ ...v, [l]: !v[l] }))} onDownload={download} onClose={() => setMenuOpen(false)} />
      </Show>
      <div class="oak-logs-panel__list" ref={list} onScroll={onScroll} role="log" aria-label="Messages">
        <Show
          when={logs() !== null}
          fallback={<div class="ot-empty-state">Add the script to a chart to see its logs.</div>}
        >
          <Show when={shown().length > 0} fallback={<div class="ot-empty-state">No messages</div>}>
            <For each={shown()}>
              {(e) => (
                <div class={`oak-log oak-log--${e.level}`}>
                  <span class="oak-log__msg" data-no-translate>
                    {formatted(`[${logTime(e.time, props.timeZone)}]: ${e.message}`)}
                  </span>
                  <span class="oak-log__actions">
                    <Show when={e.line !== undefined}>
                      <Tooltip text="Source code" side="bottom">
                        <button type="button" class="oak-log__action" aria-label="Source code" onClick={() => showSource(e)}>
                          <Icon name="st-legend-source-code" size={18} />
                        </button>
                      </Tooltip>
                    </Show>
                    <Tooltip text="Scroll to bar" side="bottom">
                      <button type="button" class="oak-log__action" aria-label="Scroll to bar" onClick={() => emitAppEvent("chart-link-time", { time: e.time })}>
                        <Icon name="oak-scroll-to-bar" size={18} />
                      </button>
                    </Tooltip>
                  </span>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
      <Show when={!atEnd()}>
        <Tooltip text="Scroll down" side="top">
          <button type="button" class="oak-logs-panel__down" aria-label="Scroll down" onClick={() => { setAtEnd(true); toEnd(); }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M9 3v11M4 9.5 9 14.5l5-5" stroke="currentColor" stroke-width="1.3" />
            </svg>
          </button>
        </Tooltip>
      </Show>
    </aside>
  );
}

/** The panel's menu: the levels shown, then Download logs. */
function LogsMenu(props: {
  anchor: HTMLElement;
  levels: Record<LogLevel, boolean>;
  onLevel: (l: LogLevel) => void;
  onDownload: () => void;
  onClose: () => void;
}) {
  const popover = createPopover(() => props.anchor, {
    onClose: () => props.onClose(),
    placement: { side: "below", gap: 4, align: "end" },
    on: { target: "window", capture: false },
  });
  return (
    <Portal>
      <div ref={popover} class="ot-popover oak-logs-menu" role="menu" aria-label="Logs menu">
        <div class="oak-script-menu__section">Filter levels</div>
        <For each={LEVELS}>
          {(l) => (
            <button type="button" role="menuitemcheckbox" aria-checked={props.levels[l.level]} class="ot-menu-item" onClick={() => props.onLevel(l.level)}>
              <span class="ot-menu-item__icon" aria-hidden="true">
                <CheckMarkBox checked={props.levels[l.level]} variant="menu" />
              </span>
              <span class="ot-menu-item__label">{l.label}</span>
            </button>
          )}
        </For>
        <div class="ot-popover__divider" />
        <button type="button" role="menuitem" class="ot-menu-item" onClick={() => { props.onDownload(); props.onClose(); }}>
          <span class="ot-menu-item__icon" aria-hidden="true">
            <Icon name="st-trades-download-csv" size={20} />
          </span>
          <span class="ot-menu-item__label">Download logs</span>
        </button>
      </div>
    </Portal>
  );
}
