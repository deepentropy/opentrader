/*
 * Popup of the chart legend's status pill (reference app 3.4.1, "chart-statuses-
 * popup"): under the pill, the section icon over the pill's icon, one section
 * per status shown — Bar Replay ("Replay mode") while the chart is in replay,
 * else the market status: coloured title, description and bold countdown, the
 * session bar of the exchange day (current-time marker, bounds of the current
 * part) and the exchange time zone. Closes on a click outside, Escape, a
 * scroll or resize, or a second click on the pill.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { cachedSymbolSessions, sessionsVersion } from "../../data/session";
import {
  MARKET_STATUS_TEXT,
  REPLAY_STATUS_TEXT,
  STATUS_ITEMS,
  countdownText,
  marketStatusAt,
  sessionTimeline,
  type MarketStatusKind,
  type TimelineSegment,
} from "./legend-status";

const REPLAY_PATH = "M8 13 4 9l4-4zm4 0L8 9l4-4z";

type Props = {
  /** The status pill (the popup opens under it). */
  anchor: HTMLElement;
  /** Symbol whose sessions give the market status. */
  symbol?: string;
  /** The legend's market status (shown when not in replay). */
  marketStatus?: "open" | "pre" | "post" | "closed";
  replayStatus?: "select" | "pause" | "play" | null;
  onClose: () => void;
};

export function LegendStatusPopup(props: Props) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);
  // The countdown and the time marker follow the clock.
  const [clock, setClock] = createSignal(Date.now());
  const timer = window.setInterval(() => setClock(Date.now()), 10_000);
  onCleanup(() => window.clearInterval(timer));

  onMount(() => {
    const r = props.anchor.getBoundingClientRect();
    // The section icon sits over the pill's icon (16 px section padding, 1 px item padding).
    let left = Math.round(r.left - 15);
    const w = el.offsetWidth;
    if (left + w > window.innerWidth - 4) left = Math.max(4, window.innerWidth - w - 4);
    setPos({ left, top: Math.round(r.bottom + 7) });
    let armed = false;
    const t = window.setTimeout(() => (armed = true), 0);
    const onDown = (e: MouseEvent) => {
      if (!armed) return;
      const target = e.target as Node;
      if (el.contains(target) || props.anchor.contains(target)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    const onAway = () => props.onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onAway);
    window.addEventListener("wheel", onAway, { capture: true, passive: true });
    onCleanup(() => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onAway);
      window.removeEventListener("wheel", onAway, true);
    });
  });

  const sessions = () => {
    sessionsVersion();
    return props.symbol ? cachedSymbolSessions(props.symbol) : null;
  };
  const market = createMemo(() => {
    const sec = clock() / 1000;
    const s = sessions();
    const kind: MarketStatusKind = s ? marketStatusAt(s, sec) : props.marketStatus ?? "closed";
    return {
      kind,
      item: STATUS_ITEMS[kind],
      text: MARKET_STATUS_TEXT[kind],
      countdown: s ? countdownText(s, sec) : null,
      timeline: s ? sessionTimeline(s, sec) : null,
    };
  });
  const replay = () => (props.replayStatus ? REPLAY_STATUS_TEXT[props.replayStatus === "select" ? "select" : "on"] : null);

  return (
    <Portal>
      <div
        ref={el}
        class="ot-lsp"
        data-qa-id="chart-statuses-popup"
        role="dialog"
        style={pos() ? { left: `${pos()!.left}px`, top: `${pos()!.top}px` } : { left: "-9999px", top: "-9999px" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Show
          when={replay()}
          fallback={
            <div class="ot-lsp-section">
              <span class="ot-lsp-icon ot-legend-status-item" style={{ color: market().item.color, "--status-overlay": market().item.overlay }} aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path fill="currentColor" d={market().item.path} /></svg>
              </span>
              <div class="ot-lsp-desc">
                <span class="ot-lsp-title" style={{ color: market().text.color }}>{market().text.title}</span>
                <p class="ot-lsp-text">
                  <span class="ot-lsp-item">{market().text.description}</span>
                  <Show when={market().countdown}>
                    <span class="ot-lsp-item is-bold">{market().countdown}</span>
                  </Show>
                </p>
                <Show when={market().timeline}>{(t) => <TimelineView t={t()} />}</Show>
              </div>
            </div>
          }
        >
          {(r) => (
            <div class="ot-lsp-section">
              <span
                class={`ot-lsp-icon ot-legend-status-item is-replay ${props.replayStatus === "select" ? "is-replay-select" : "is-replay-on"}`}
                aria-hidden="true"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path fill="currentColor" d={REPLAY_PATH} /></svg>
              </span>
              <div class="ot-lsp-desc">
                <span class="ot-lsp-title" style={{ color: r().color }}>{r().title}</span>
                <p class="ot-lsp-text">
                  <span class="ot-lsp-item">{r().text}</span>
                </p>
              </div>
            </div>
          )}
        </Show>
      </div>
    </Portal>
  );
}

function TimelineView(props: { t: ReturnType<typeof sessionTimeline> }) {
  const pct = (v: number) => `${v * 100}%`;
  // Hover tooltip of a part (shown at once, 8 px above it, centred).
  const [hover, setHover] = createSignal<{ seg: TimelineSegment; x: number; y: number } | null>(null);
  const enter = (seg: TimelineSegment, e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setHover({ seg, x: r.left + r.width / 2, y: r.top - 8 });
  };
  return (
    <div class="ot-lsp-timeline">
      <div class="ot-lsp-days">
        <div class="ot-lsp-day is-active">
          <div class="ot-lsp-weekday">{props.t.weekday}</div>
          <div class="ot-lsp-segments">
            <For each={props.t.segments}>
              {(s) => (
                <div
                  class={`ot-lsp-segment is-${s.type}`}
                  classList={{ "is-start": s.start, "is-end": s.end, "is-small": s.to - s.from < 0.03 }}
                  style={{ left: pct(s.from), width: `calc(${pct(s.to - s.from)} + ${s.to - s.from < 0.03 ? 2 : 0}px)` }}
                  onMouseEnter={(e) => enter(s, e)}
                  onMouseLeave={() => setHover(null)}
                />
              )}
            </For>
          </div>
        </div>
        <div class="ot-lsp-now-wrap">
          <div class="ot-lsp-now" style={{ left: pct(props.t.now) }} />
        </div>
      </div>
      <Show when={props.t.marks}>
        {(m) => (
          <div class="ot-lsp-day">
            <div class="ot-lsp-weekday" />
            <div class="ot-lsp-marks">
              <div class="ot-lsp-mark-seg" classList={{ "is-ends": m().alignEnds }} style={{ left: pct(m().left), width: pct(m().width) }}>
                <For each={m().titles}>{(title) => <div class="ot-lsp-mark">{title}</div>}</For>
              </div>
            </div>
          </div>
        )}
      </Show>
      <div class="ot-lsp-zone">{props.t.zone}</div>
      <Show when={hover()}>
        {(h) => (
          <Portal>
            <div class="ot-tooltip ot-tooltip-top ot-tooltip-normal ot-lsp-tip" role="tooltip" style={{ left: `${h().x}px`, top: `${h().y}px` }}>
              <span class={`ot-lsp-tip-title is-${h().seg.type}`}>{h().seg.tip.title}</span>{" "}
              <span class="ot-lsp-tip-time">{h().seg.tip.time}</span>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
}
