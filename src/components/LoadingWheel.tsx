/*
 * The app's loading wheel (styles in chart-loading.css), centred in its
 * positioned parent: a faint track and a rotating arc. An optional label sits
 * inside the wheel (a share downloaded) and a caption under it.
 */
import { Show } from "solid-js";

export function LoadingWheel(props: { label?: string; caption?: string }) {
  return (
    <div class="ot-chart-loader" role="progressbar" aria-label={props.caption || "Loading"}>
      <svg class="ot-chart-loader__svg" viewBox="0 0 64 64">
        <circle class="ot-chart-loader__track" cx="32" cy="32" r="30" />
        <circle class="ot-chart-loader__arc" cx="32" cy="32" r="30" />
      </svg>
      <Show when={props.label}>
        <span class="ot-chart-loader__label">{props.label}</span>
      </Show>
      <Show when={props.caption}>
        <span class="ot-chart-loader__caption">{props.caption}</span>
      </Show>
    </div>
  );
}
