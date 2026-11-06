/*
 * First open of the assistant: one sentence, a beta warning and Activate, which downloads its model
 * (src/data/assistant/local.ts).
 * Nothing comes with the installer; Remove is in the panel's menu once it is there.
 */
import { Show, onMount } from "solid-js";
import { cancelLocal, gb, installLocal, localBlocker, localError, localInfo, localProgress, refreshLocal } from "../../data/assistant/local";

export function AssistantSetup() {
  onMount(() => void refreshLocal());
  const busy = () => !!localInfo()?.installing || !!localProgress();
  const pct = () => {
    const p = localProgress();
    return p && p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : 0;
  };
  return (
    <div class="asst-column asst-models">
      <div class="asst-empty asst-setup">
        <p class="asst-greeting">Your assistant works the app for you: charts, indicators, screens and alerts.</p>
        <Show when={localInfo()}>
          {(i) => (
            <Show
              when={!busy()}
              fallback={
                <div class="asst-progress-block">
                  <div class="asst-progress"><div style={{ width: `${pct()}%` }} /></div>
                  <div class="asst-inline">
                    <span class="asst-muted">Activating… {pct()}%</span>
                    <button type="button" class="asst-btn" onClick={cancelLocal}>Stop</button>
                  </div>
                </div>
              }
            >
              <Show when={localBlocker(i())} fallback={
                <>
                  <p class="asst-beta">
                    <span class="asst-beta-tag">Beta</span>
                    The assistant is a beta release: it can misread a request, and some of its steps can fail.
                  </p>
                  <button type="button" class="asst-btn is-primary" onClick={() => void installLocal()}>
                    Activate ({gb(i().downloadBytes)})
                  </button>
                </>
              }>
                {(why) => <span class="asst-muted">{why()}</span>}
              </Show>
            </Show>
          )}
        </Show>
        <Show when={localError()}>{(e) => <p class="asst-status is-error">{e()}</p>}</Show>
      </div>
    </div>
  );
}
