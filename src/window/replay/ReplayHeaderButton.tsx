/*
 * Header "Replay" button (the reference app header-toolbar-replay): opens Bar Replay, or
 * closes it ("Leave current replay?" once a replay runs). In a multi-chart
 * layout a "Replay mode" chevron picks Single chart / All charts; changing it
 * while a replay runs asks first ("Confirm reset", with "Don't show again").
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { showConfirm } from "../../components/Dialogs";
import * as kv from "../../data/kv";
import {
  cancelSelect,
  closeReplay,
  openReplay,
  replayEnabled,
  replayMode,
  replayStarted,
  replayTiming,
  setReplayMode,
  stopReplay,
  toggleSelect,
  type ReplayMode,
} from "../../data/replay";

const HIDE_RESET_CONFIRM_KEY = "ot:replay-mode-change-hide-confirm";

/** Close Bar Replay; a running replay asks first. */
export function requestCloseReplay() {
  if (!replayStarted()) {
    closeReplay();
    return;
  }
  showConfirm({
    title: "Leave current replay?",
    text: "",
    mainText: "Leave",
    cancelText: "Stay",
    intent: "neutral",
    onConfirm: () => closeReplay(),
  });
}

/** Single chart / All charts. A replay that runs is reset (after a confirm). */
function changeMode(m: ReplayMode) {
  if (m === replayMode()) return;
  if (!replayStarted()) {
    setReplayMode(m);
    cancelSelect();
    return;
  }
  const apply = () => {
    setReplayMode(m);
    stopReplay();
    if (replayTiming() === "bar") toggleSelect();
  };
  if (kv.getItem(HIDE_RESET_CONFIRM_KEY) === "true") {
    apply();
    return;
  }
  const [hide, setHide] = createSignal(false);
  showConfirm({
    title: "Confirm reset",
    text: "If you change modes now, the chart replay will reset. Do you still want to go ahead?",
    mainText: "Reset and change",
    cancelText: "Stay in this mode",
    doNotShow: { label: "Don't show again", checked: hide, onChange: setHide },
    onConfirm: () => {
      if (hide()) kv.setItem(HIDE_RESET_CONFIRM_KEY, "true");
      apply();
    },
  });
}

function ModeMenu(props: { anchor: DOMRect; onClose: () => void }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);
  onMount(() => {
    const M = 4;
    let left = Math.round(props.anchor.left);
    if (left + el.offsetWidth > window.innerWidth - M) left = window.innerWidth - el.offsetWidth - M;
    setPos({ left, top: Math.round(props.anchor.bottom + 4) });
    let armed = false;
    const t = window.setTimeout(() => (armed = true), 0);
    const onDown = (e: MouseEvent) => {
      if (armed && !el.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });
  const items: { id: ReplayMode; label: string }[] = [
    { id: "ActiveChart", label: "Single chart" },
    { id: "AllCharts", label: "All charts" },
  ];
  return (
    <Portal>
      <div
        ref={el}
        class="ot-popover ot-replay-menu is-down"
        role="menu"
        aria-label="Replay mode"
        style={pos() ? { left: `${pos()!.left}px`, top: `${pos()!.top}px` } : { left: "-9999px", top: "-9999px" }}
      >
        <For each={items}>
          {(it) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={replayMode() === it.id}
              data-qa-id={it.id === "ActiveChart" ? "single-chart" : "all-charts"}
              class={`ot-replay-menu__item${replayMode() === it.id ? " is-selected" : ""}`}
              onClick={() => {
                props.onClose();
                changeMode(it.id);
              }}
            >
              <span>{it.label}</span>
            </button>
          )}
        </For>
      </div>
    </Portal>
  );
}

export function ReplayHeaderButton(props: { multiChart: boolean }) {
  const [menu, setMenu] = createSignal<DOMRect | null>(null);
  return (
    <>
      <Tooltip text="Bar replay" side="bottom">
        <button
          type="button"
          data-name="header-toolbar-replay"
          aria-label="Bar replay"
          aria-pressed={replayEnabled()}
          class="ot-toolbar-button header-toolbar-btn is-iconText ot-replay-header-btn"
          onClick={() => (replayEnabled() ? requestCloseReplay() : openReplay())}
        >
          <Icon name="header-bar-replay" size={28} />
          <span class="header-toolbar-label">Replay</span>
        </button>
      </Tooltip>
      <Show when={props.multiChart}>
        <Tooltip text="Replay mode" side="bottom">
          <button
            type="button"
            aria-label="Replay mode"
            aria-haspopup="menu"
            aria-expanded={!!menu()}
            class="ot-toolbar-button header-toolbar-btn is-chevron"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu((m) => (m ? null : r));
            }}
          >
            <Icon name="header-replay-mode" size={8} />
          </button>
        </Tooltip>
      </Show>
      <Show when={menu()}>{(a) => <ModeMenu anchor={a()} onClose={() => setMenu(null)} />}</Show>
    </>
  );
}
