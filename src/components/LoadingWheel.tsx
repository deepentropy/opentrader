/*
 * The app's loading wheel (styles in chart-loading.css), centred in its
 * positioned parent: a faint track and a rotating arc.
 */
export function LoadingWheel() {
  return (
    <div class="ot-chart-loader" role="progressbar" aria-label="Loading">
      <svg class="ot-chart-loader__svg" viewBox="0 0 64 64">
        <circle class="ot-chart-loader__track" cx="32" cy="32" r="30" />
        <circle class="ot-chart-loader__arc" cx="32" cy="32" r="30" />
      </svg>
    </div>
  );
}
