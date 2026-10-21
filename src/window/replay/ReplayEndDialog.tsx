/*
 * End of a Bar Replay session with trades (end of the data, Jump to
 * real-time): "Congrats, trader!" / "Keep training" with the profit, the win
 * rate and the best trade, and "Open full report" (the Replay Trading tab).
 * One dialog per chart that ended, stacked; ×, Escape and an outside click
 * close the top one. A one-shot confetti falls over it (green when the
 * session made money, a few red pieces when it lost).
 */
import { For, Show, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { replayBroker, type SessionResult } from "../../data/trading/replay-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import { money, percent } from "../strategy-tester/format";

const GREEN = ["#22ab94", "#42bda8", "#70ccbd", "#089981", "#ace5dc", "#2ec4a6"];
const RED = ["#f23645", "#f7525f", "#fa8c8c", "#cc2f3c"];

const CloseIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
  </svg>
);

/** Falling pieces, one shot. */
function Confetti(props: { win: boolean }) {
  const colors = props.win ? GREEN : RED;
  const pieces = Array.from({ length: props.win ? 120 : 10 }, (_, i) => ({
    left: Math.random() * 100,
    delay: Math.random() * 0.8,
    duration: 2.2 + Math.random() * 1.8,
    drift: (Math.random() - 0.5) * 160,
    spin: (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 720),
    w: 5 + Math.random() * 5,
    h: 3 + Math.random() * 4,
    color: colors[i % colors.length],
  }));
  return (
    <div class="re-confetti" aria-hidden="true">
      <For each={pieces}>
        {(p) => (
          <span
            class="re-confetti-piece"
            style={{
              left: `${p.left}%`,
              width: `${p.w}px`,
              height: `${p.h}px`,
              background: p.color,
              "animation-delay": `${p.delay}s`,
              "animation-duration": `${p.duration}s`,
              "--re-drift": `${p.drift}px`,
              "--re-spin": `${p.spin}deg`,
            }}
          />
        )}
      </For>
    </div>
  );
}

function EndDialog(props: { r: SessionResult; top: boolean }) {
  const win = props.r.netProfit > 0;
  const close = () => replayBroker.dismissResult(props.r.id);
  let box: HTMLDivElement | undefined;
  return (
    <div
      class="ot-dlg-layer re-layer"
      onPointerDown={(e) => {
        if (props.top && !box?.contains(e.target as Node)) close();
      }}
    >
      <div ref={box} class="re-dialog" classList={{ "is-loss": !win }} role="dialog" aria-label={win ? "Congrats, trader!" : "Keep training"} data-name="replay-end-dialog">
        <div class="re-header">
          <Show when={props.r.iconUrl} fallback={<span class="re-logo re-logo-letter">{props.r.symbol.replace(/^.*:/, "").slice(0, 1)}</span>}>
            {(src) => <img class="re-logo" src={src()} alt="" />}
          </Show>
        </div>
        <button type="button" class="re-close" aria-label="Close" onClick={close}>
          <CloseIcon />
        </button>
        <div class="re-title">{win ? "Congrats, trader!" : "Keep training"}</div>
        <div class="re-text">
          {win
            ? `Your hard work shows on ${props.r.description} in Bar Replay`
            : `The session is over and you lost paper money on ${props.r.description} in Bar Replay`}
        </div>
        <div class="re-stats">
          <div class="re-stat">
            <div class="re-stat-label">{win ? "Profit in cash" : "Loss in cash"}</div>
            <div class={`re-stat-value ${win ? "is-positive" : "is-negative"}`}>
              {money(props.r.netProfit, true)}
              <span class="re-cur">{props.r.currency}</span>
            </div>
          </div>
          <Show when={props.r.winRate !== null}>
            <div class="re-stat">
              <div class="re-stat-label">Win rate</div>
              <div class="re-stat-value is-positive">{percent(props.r.winRate)}</div>
            </div>
            <div class="re-stat">
              <div class="re-stat-label">Best trade</div>
              <div class="re-stat-value is-positive">
                {money(props.r.bestTrade, true)}
                <span class="re-cur">{props.r.currency}</span>
              </div>
            </div>
          </Show>
        </div>
        <div class="re-buttons">
          <button
            type="button"
            class="re-btn is-main"
            onClick={() => {
              tradingUi.showReplayReport("report");
              close();
            }}
          >
            Open full report
          </button>
        </div>
        <Confetti win={win} />
      </div>
    </div>
  );
}

export function ReplayEndDialog() {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const list = replayBroker.results();
    if (!list.length) return;
    e.preventDefault();
    e.stopPropagation();
    replayBroker.dismissResult(list[list.length - 1].id);
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  return (
    <Portal>
      <For each={replayBroker.results()}>
        {(r, i) => <EndDialog r={r} top={i() === replayBroker.results().length - 1} />}
      </For>
    </Portal>
  );
}
