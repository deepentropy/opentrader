/*
 * Bar Replay toolbar: the strip above the bottom bar while replay is on (the
 * reference app "replay-bottom-toolbar"):
 *   [Select bar ▾] | [Play] [Forward] [1x] [1m] | [Jump to real-time] … [×]
 * The split button runs the last start mode (Bar / Date… / First available
 * date / Random bar, picked in its menu). Play, Forward and Jump follow the
 * focused chart; speed and update interval menus open upwards.
 *
 * First-use hints (reference app): the toolbar flashes the first 3 times it
 * opens (a click on it ends that), and while a bar is picked "Click to select
 * the starting point." shows 32 px above it until it is closed once.
 */
import { For, Show, createEffect, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { longIntervalLabel, shortIntervalLabel } from "../chart/interval-favorites";
import { requestCloseReplay } from "./ReplayHeaderButton";
import { GoToDateDialog } from "../bottom-bar/GoToDateDialog";
import { showNotice } from "../../components/Dialogs";
import {
  REPLAY_SPEEDS,
  activeInReplay,
  activeReplayPane,
  closeDateDialog,
  selectDate,
  cancelSelect,
  replayDateDialog,
  replayDelay,
  replayFirstAvailable,
  replayFixedUpdate,
  replaySelecting,
  replayStarted,
  replayTiming,
  replayUpdateInterval,
  replayUpdateIntervals,
  replayPlaying,
  runTimingMode,
  setReplayDelay,
  setReplayUpdateInterval,
  setTimingMode,
  step,
  jumpToRealtime,
  togglePlay,
  takeReplayToolbarHighlight,
  stopReplayToolbarHighlight,
  replayJumpHintShown,
  closeReplayJumpHint,
  type TimingMode,
} from "../../data/replay";

const TIMING: Record<TimingMode, { button: string; item: string; icon: string }> = {
  bar: { button: "Select bar", item: "Bar", icon: "replay-select-bar" },
  date: { button: "Select date", item: "Date…", icon: "replay-select-date" },
  first: { button: "Select first available date", item: "First available date", icon: "replay-select-first" },
  random: { button: "Select random bar", item: "Random bar", icon: "replay-select-random" },
};

type MenuId = "start" | "speed" | "interval";

/** A menu opening upwards from its button (left edge + 2 px, 2 px above). */
function UpMenu(props: { anchor: DOMRect; label: string; width?: number; onClose: () => void; children: JSX.Element }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);
  onMount(() => {
    const M = 4;
    let left = Math.round(props.anchor.left + 2);
    const top = Math.max(M, Math.round(props.anchor.top - 2 - el.offsetHeight));
    if (left + el.offsetWidth > window.innerWidth - M) left = window.innerWidth - el.offsetWidth - M;
    setPos({ left, top });
    let armed = false;
    const t = window.setTimeout(() => (armed = true), 0);
    const onDown = (e: MouseEvent) => {
      if (armed && !el.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });
  return (
    <Portal>
      <div
        ref={el}
        class="ot-popover ot-replay-menu"
        role="menu"
        aria-label={props.label}
        style={{ ...(pos() ? { left: `${pos()!.left}px`, top: `${pos()!.top}px` } : { left: "-9999px", top: "-9999px" }), ...(props.width ? { width: `${props.width}px` } : {}) }}
      >
        <div class="ot-replay-menu__title">{props.label}</div>
        {props.children}
      </div>
    </Portal>
  );
}

function ToolButton(props: {
  title: string;
  hotkey?: string;
  hotkeyText?: string;
  disabled?: boolean;
  pressed?: boolean;
  class?: string;
  dataName?: string;
  onClick: (e: MouseEvent & { currentTarget: HTMLButtonElement }) => void;
  children: JSX.Element;
}) {
  return (
    <Tooltip text={props.title} hotkey={props.hotkey} hotkeyText={props.hotkeyText} side="top">
      <button
        type="button"
        class={`ot-toolbar-button ot-replay-btn${props.class ? ` ${props.class}` : ""}${props.disabled ? " is-disabled" : ""}`}
        aria-label={props.title}
        aria-pressed={props.pressed === undefined ? undefined : props.pressed}
        data-name={props.dataName}
        disabled={props.disabled}
        onClick={(e) => props.onClick(e)}
      >
        {props.children}
      </button>
    </Tooltip>
  );
}

export function ReplayToolbar() {
  const [menu, setMenu] = createSignal<{ id: MenuId; anchor: DOMRect } | null>(null);
  const open = (id: MenuId, el: HTMLElement) =>
    setMenu((m) => (m?.id === id ? null : { id, anchor: el.getBoundingClientRect() }));
  const close = () => setMenu(null);
  let wrap!: HTMLDivElement;
  const [width, setWidth] = createSignal(1000);
  /** Toolbar box (the jump hint sits above it). */
  const [box, setBox] = createSignal<DOMRect | null>(null);
  onMount(() => {
    const ro = new ResizeObserver(() => {
      setWidth(wrap.clientWidth);
      setBox(wrap.getBoundingClientRect());
    });
    ro.observe(wrap);
    const onResize = () => setBox(wrap.getBoundingClientRect());
    window.addEventListener("resize", onResize);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    });
  });
  // Measured again when the hint shows (the panels below may have moved it).
  createEffect(on(replayJumpHintShown, (v) => v && setBox(wrap.getBoundingClientRect())));
  // Flashes on its first openings (counted when it mounts).
  const highlighted = takeReplayToolbarHighlight();

  const timing = () => TIMING[replayTiming()];
  /** First available date / Random bar wait for the data start. */
  const autoDateReady = () => replayFirstAvailable() !== null;
  const mainDisabled = () => (replayTiming() === "first" || replayTiming() === "random") && !autoDateReady();
  const mainPressed = () => (replayTiming() === "bar" && replaySelecting()) || (replayTiming() === "date" && replayDateDialog());
  const pick = (m: TimingMode) => {
    close();
    // "Bar" while a bar is being picked already: nothing to do.
    if (m === "bar" && replaySelecting()) {
      setTimingMode(m);
      return;
    }
    setTimingMode(m);
    runTimingMode();
  };
  const speedLabel = () => REPLAY_SPEEDS.find((s) => s.delay === replayDelay())?.label ?? "1x";
  const playDisabled = () => !activeInReplay();
  /** First day with data, in the focused chart's calendar. */
  const firstDay = () => {
    const first = replayFirstAvailable();
    const p = activeReplayPane();
    if (first === null || !p) return null;
    const w = p.timeToWall(first);
    return new Date(w.y, w.m, w.d);
  };

  // Shift+↓ play / pause, Shift+→ one step (held: repeats), Escape cancels a
  // bar selection.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape" && replaySelecting()) {
        e.preventDefault();
        cancelSelect();
        return;
      }
      if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || !replayStarted()) return;
      if (e.key === "ArrowDown") {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        togglePlay();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        void step();
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  return (
    <div
      ref={wrap}
      class="ot-replay-toolbar"
      classList={{ "is-highlighted": highlighted }}
      data-name="replay-bottom-toolbar"
      onClick={() => stopReplayToolbarHighlight()}
    >
      <Show when={replayJumpHintShown() && box()}>
        {(b) => (
          <Portal>
            <div class="ot-replay-hint" style={{ left: `${b().left + 10}px`, width: `${b().width - 20}px`, top: `${b().top - 32}px` }}>
              <div class="ot-replay-hint__box" data-name="replay-jump-hint">
                <div class="ot-replay-hint__text">Click to select the starting point.</div>
                <button type="button" class="ot-replay-hint__close" aria-label="Close" onClick={() => closeReplayJumpHint()}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" aria-hidden="true">
                    <path fill="currentColor" d="M9.707 9l4.647-4.646-.707-.708L9 8.293 4.354 3.646l-.708.708L8.293 9l-4.647 4.646.708.708L9 9.707l4.646 4.647.708-.707L9.707 9z" />
                  </svg>
                </button>
              </div>
            </div>
          </Portal>
        )}
      </Show>
      <div class="ot-replay-toolbar__controls">
        <div class="ot-replay-toolbar__group">
          <ToolButton
            title={timing().button}
            class={`ot-replay-start${width() > 463 ? " has-text" : ""}`}
            pressed={mainPressed()}
            disabled={mainDisabled()}
            onClick={() => runTimingMode()}
          >
            <Icon name={timing().icon} size={28} />
            <Show when={width() > 463}>
              <span class="ot-replay-btn__text">{timing().button}</span>
            </Show>
          </ToolButton>
          <ToolButton
            title="Select starting point"
            class="ot-replay-chevron"
            dataName="select-date-bar-mode-menu"
            pressed={menu()?.id === "start"}
            onClick={(e) => open("start", e.currentTarget)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 8" width="8" height="4" class={menu()?.id === "start" ? "is-open" : ""}>
              <path fill="currentColor" d="M0 1.475l7.396 6.04.596.485.593-.49L16 1.39 14.807 0 7.393 6.122 8.58 6.12 1.186.08z" />
            </svg>
          </ToolButton>
          <div class="ot-replay-toolbar__sep" />
          <ToolButton
            title={replayPlaying() ? "Pause" : "Play"}
            hotkey="Shift+↓"
            disabled={playDisabled()}
            pressed={replayPlaying()}
            onClick={() => togglePlay()}
          >
            <Icon name={replayPlaying() ? "replay-pause" : "replay-play"} size={28} />
          </ToolButton>
          <ToolButton title="Forward" hotkey="Shift+→" disabled={playDisabled()} onClick={() => void step()}>
            <Icon name="replay-forward" size={28} />
          </ToolButton>
          <ToolButton title="Replay speed" class="is-text" pressed={menu()?.id === "speed"} onClick={(e) => open("speed", e.currentTarget)}>
            <span class="ot-replay-btn__text">{speedLabel()}</span>
          </ToolButton>
          <ToolButton title="Update interval" class="is-text" pressed={menu()?.id === "interval"} onClick={(e) => open("interval", e.currentTarget)}>
            <span class="ot-replay-btn__text">{shortIntervalLabel(replayUpdateInterval())}</span>
          </ToolButton>
          <div class="ot-replay-toolbar__sep" />
          <ToolButton title="Jump to real-time chart" disabled={playDisabled()} onClick={() => jumpToRealtime()}>
            <Icon name="replay-jump" size={28} />
          </ToolButton>
        </div>
      </div>
      <div class="ot-replay-toolbar__close">
        <ToolButton title="Exit Bar Replay" onClick={() => requestCloseReplay()}>
          <Icon name="replay-exit" size={17} />
        </ToolButton>
      </div>

      <Show when={replayDateDialog()}>
        <GoToDateDialog
          anchor={wrap.getBoundingClientRect()}
          dateOnly={activeReplayPane()?.dateOnly() ?? false}
          replay={{ minDate: firstDay() }}
          onSubmit={(date, minutes) => {
            const p = activeReplayPane();
            if (!p) return;
            if (!selectDate(p.wallToTime(date, minutes))) {
              showNotice({
                title: "Data point unavailable",
                text: "The selected date is not available for playback. The chart was moved to the first point available for playback.",
              });
            }
          }}
          onClose={closeDateDialog}
        />
      </Show>
      <Show when={menu()}>
        {(m) => (
          <>
            <Show when={m().id === "start"}>
              <UpMenu anchor={m().anchor} label="Select starting point" onClose={close}>
                <For each={["bar", "date", "first", "random"] as TimingMode[]}>
                  {(id) => (
                    <Show when={id !== "first" || autoDateReady()}>
                      <button
                        type="button"
                        role="menuitem"
                        class={`ot-replay-menu__item has-icon${replayTiming() === id ? " is-selected" : ""}${id === "random" && !autoDateReady() ? " is-disabled" : ""}`}
                        disabled={id === "random" && !autoDateReady()}
                        onClick={() => pick(id)}
                      >
                        <Icon name={TIMING[id].icon} size={28} />
                        <span>{TIMING[id].item}</span>
                      </button>
                    </Show>
                  )}
                </For>
              </UpMenu>
            </Show>
            <Show when={m().id === "speed"}>
              <UpMenu anchor={m().anchor} label="Replay speed" width={196} onClose={close}>
                <For each={REPLAY_SPEEDS}>
                  {(s) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={s.delay === replayDelay()}
                      class={`ot-replay-menu__item${s.delay === replayDelay() ? " is-selected" : ""}`}
                      onClick={() => { setReplayDelay(s.delay); close(); }}
                    >
                      <span>{s.label}</span>
                      <span class="ot-replay-menu__desc">{s.desc}</span>
                    </button>
                  )}
                </For>
              </UpMenu>
            </Show>
            <Show when={m().id === "interval"}>
              <UpMenu anchor={m().anchor} label="Update interval" width={196} onClose={close}>
                <For each={replayUpdateIntervals()}>
                  {(id) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={id === replayUpdateInterval()}
                      class={`ot-replay-menu__item${id === replayUpdateInterval() ? " is-selected" : ""}`}
                      onClick={() => { setReplayUpdateInterval(id); close(); }}
                    >
                      <span>{longIntervalLabel(id)}</span>
                    </button>
                  )}
                </For>
                <div class="ot-replay-menu__sep" />
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={replayFixedUpdate() === null}
                  class="ot-replay-menu__item ot-replay-menu__switch-row"
                  onClick={() => setReplayUpdateInterval(replayFixedUpdate() === null ? replayUpdateInterval() : null)}
                >
                  <span>Auto select interval</span>
                  <span class={`ot-replay-switch${replayFixedUpdate() === null ? " is-on" : ""}`} aria-hidden="true">
                    <span class="ot-replay-switch__knob" />
                  </span>
                </button>
              </UpMenu>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
