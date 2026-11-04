/*
 * RightRailTabs — vertical strip on the far right of the chart that
 * switches the right-rail panel between Watchlist / Alerts / Object tree.
 *
 * Toggle: clicking the active tab clears the selection (collapses the
 * panel, leaves the strip visible).
 *
 * The buttons sit in a group stuck to the top and one stuck to the bottom
 * (right-rail-layout.ts). Dragging a button moves it: a placeholder shows
 * where it lands, in either group.
 */
import { For, Show, createSignal, onCleanup } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { TOP_TABS, type Tab } from "../../data/right-rail-tabs";
import { COMMUNITY_ENABLED } from "../../data/community/api";
import { unread as communityUnread } from "../../data/community/notifications";
import { moveInLayout, railLayout, setRailLayout, type RailGroup } from "../../data/right-rail-layout";

const SHOWN_TABS = TOP_TABS.filter((t) => t.id !== "community" || COMMUNITY_ENABLED);
const TAB_BY_ID = new Map(SHOWN_TABS.map((t) => [t.id, t]));
const IDS = SHOWN_TABS.map((t) => t.id);
/** Pointer travel (px) before a press becomes a drag. */
const DRAG_START = 4;
const PLACEHOLDER = "\u0000placeholder";

type Props = {
  active: string | null;
  setActive: (id: string | null) => void;
  /** Buttons shown pressed without being the active panel tab (the
   *  screener split view while it is open). */
  pressed?: (id: string) => boolean;
  /** Buttons whose panel was collapsed (its "Collapse panel"): a dot at their left edge. */
  collapsed?: (id: string) => boolean;
};

type Drag = { id: string; x: number; y: number; group: RailGroup; index: number };

export function RightRailTabs(props: Props) {
  let topRef!: HTMLDivElement;
  let bottomRef!: HTMLDivElement;
  const [drag, setDrag] = createSignal<Drag | null>(null);
  const layout = () => railLayout(IDS);
  /** A drag just ended on a button: its click is not a selection. */
  let swallowClick = false;
  let stopDrag: (() => void) | null = null;
  onCleanup(() => stopDrag?.());

  const select = (id: string) => {
    if (swallowClick) return;
    props.setActive(props.active === id ? null : id);
  };

  /** Press on a button: past DRAG_START it drags. The drop slots are read
   *  from the buttons' places when the drag starts. */
  function onPointerDown(e: PointerEvent, id: string) {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let slots: { group: RailGroup; mid: number }[] = [];
    let split = 0;
    let started = false;
    const target = (y: number): { group: RailGroup; index: number } => {
      const group: RailGroup = y > split ? "bottom" : "top";
      return { group, index: slots.filter((s) => s.group === group && s.mid < y).length };
    };
    const onMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START) return;
        started = true;
        const read = (el: HTMLElement, group: RailGroup) =>
          [...el.querySelectorAll<HTMLElement>("[data-rail-id]")]
            .filter((b) => b.dataset.railId !== id)
            .map((b) => {
              const r = b.getBoundingClientRect();
              return { group, mid: r.top + r.height / 2, top: r.top, bottom: r.bottom };
            });
        const top = read(topRef, "top");
        const bottom = read(bottomRef, "bottom");
        slots = [...top, ...bottom];
        // Between the groups: the middle of the free space.
        const topEnd = top.length ? top[top.length - 1].bottom : topRef.getBoundingClientRect().top;
        const bottomStart = bottom.length ? bottom[0].top : bottomRef.getBoundingClientRect().bottom;
        split = (topEnd + bottomStart) / 2;
        document.body.style.cursor = "grabbing";
      }
      setDrag({ id, x: ev.clientX, y: ev.clientY, ...target(ev.clientY) });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey, true);
      stopDrag = null;
      const d = drag();
      setDrag(null);
      if (!started) return;
      document.body.style.cursor = "";
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 0);
      if (commit && d) setRailLayout(moveInLayout(layout(), d.id, d.group, d.index));
    };
    const onUp = () => finish(true);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !started) return;
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey, true);
    stopDrag = () => finish(false);
  }

  /** A group's buttons while dragging: the dragged one out, the placeholder in. */
  const entries = (group: RailGroup) => {
    const d = drag();
    const ids = layout()[group].filter((id) => id !== d?.id);
    if (d?.group === group) ids.splice(d.index, 0, PLACEHOLDER);
    return ids;
  };

  const renderTab = (t: Tab) => {
    const isActive = () => props.active === t.id || !!props.pressed?.(t.id);
    return (
      <Tooltip text={t.label} side="left">
        <button
          type="button"
          data-name={t.id}
          data-rail-id={t.id}
          aria-label={t.label}
          aria-pressed={isActive()}
          class={"ot-toolbar-button right-rail-tab" + (isActive() ? " active" : "")}
          classList={{ "is-collapsed": !!props.collapsed?.(t.id) }}
          onPointerDown={(e) => onPointerDown(e, t.id)}
          onClick={() => select(t.id)}
        >
          {t.iconName && <Icon name={t.iconName} size={44} />}
          {t.id === "community" && communityUnread() > 0 && <span class="right-rail-tab-dot" aria-label={`${communityUnread()} unread`} />}
        </button>
      </Tooltip>
    );
  };
  const renderEntry = (id: string) => (id === PLACEHOLDER ? <div class="right-rail-drop-slot" aria-hidden="true" /> : renderTab(TAB_BY_ID.get(id)!));

  return (
    <nav class="right-rail-tabs" classList={{ "is-dragging": !!drag() }} aria-label="Right rail">
      <div class="right-rail-tabs-group" ref={topRef}>
        <For each={entries("top")}>{renderEntry}</For>
      </div>
      <div class="right-rail-tabs-spacer" />
      <div class="right-rail-tabs-group" ref={bottomRef}>
        <For each={entries("bottom")}>{renderEntry}</For>
      </div>
      <Show when={drag()}>
        {(d) => (
          <div class="right-rail-ghost" style={{ left: `${d().x - 22}px`, top: `${d().y - 22}px` }} aria-hidden="true">
            <Show when={TAB_BY_ID.get(d().id)?.iconName}>{(name) => <Icon name={name()} size={44} />}</Show>
          </div>
        )}
      </Show>
    </nav>
  );
}
