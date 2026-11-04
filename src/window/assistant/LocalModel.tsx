/*
 * The assistant's model on this computer (src/data/assistant/local.ts): its download, its progress, and Remove once
 * it is there. Nothing comes with the installer.
 */
import { Show, onMount } from "solid-js";
import { cancelLocal, gb, installLocal, localBlocker, localError, localInfo, localProgress, refreshLocal, removeLocal } from "../../data/assistant/local";

/** "Run on this computer": OpenTrader's small model, downloaded when asked for (nothing in the installer). */
export function LocalModelCard() {
  onMount(() => void refreshLocal());
  const busy = () => !!localInfo()?.installing || !!localProgress();
  const pct = () => {
    const p = localProgress();
    return p && p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : 0;
  };
  return (
    <Show when={localInfo()}>
      {(i) => (
        <div class="asst-local">
          <div class="asst-model-row-text">
            <span class="asst-model-name">Run on this computer</span>
            <span class="asst-muted">
              OpenTrader's own small model, trained to work the app: offline, private, free. It runs on the graphics card when there is one, else on the processor.
            </span>
          </div>
          <Show
            when={!i().installed}
            fallback={
              <div class="asst-inline">
                <span class="asst-muted">Installed ({gb(i().diskBytes)}){i().running ? " · running" : ""}</span>
                <button type="button" class="asst-btn" onClick={() => void removeLocal()}>Remove</button>
              </div>
            }
          >
            <Show
              when={!busy()}
              fallback={
                <div class="asst-progress-block">
                  <div class="asst-progress"><div style={{ width: `${pct()}%` }} /></div>
                  <div class="asst-inline">
                    <span class="asst-muted">
                      {localProgress()?.file ?? "Starting…"} · {pct()}%
                    </span>
                    <button type="button" class="asst-btn" onClick={cancelLocal}>Stop</button>
                  </div>
                </div>
              }
            >
              <Show when={localBlocker(i())} fallback={
                <button type="button" class="asst-btn is-primary" onClick={() => void installLocal()}>
                  Download ({gb(i().downloadBytes)})
                </button>
              }>
                {(why) => <span class="asst-muted">{why()}</span>}
              </Show>
            </Show>
          </Show>
          <Show when={localError()}>{(e) => <p class="asst-status is-error">{e()}</p>}</Show>
        </div>
      )}
    </Show>
  );
}
