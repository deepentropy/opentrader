/*
 * ChartEventHint — a blue pill centred at the bottom of the chart (32 px up),
 * text + close button (a tooltip without arrow): #2962FF, radius 4, padding 8,
 * text 14/21 px white with 4px 8px padding, 18 px close icon; the row spans
 * the chart less 10 px each side and only the pill takes the pointer.
 */
import type { JSX } from "solid-js";

const CLOSE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><path fill="currentColor" d="M9.707 9l4.647-4.646-.707-.708L9 8.293 4.354 3.646l-.708.708L8.293 9l-4.647 4.646.708.708L9 9.707l4.646 4.647.708-.707L9.707 9z"/></svg>';

export function ChartEventHint(props: { text: string; onClose: () => void; bottom?: number }): JSX.Element {
  return (
    <div class="chart-event-hint" style={{ bottom: `${props.bottom ?? 32}px` }}>
      <div class="chart-event-hint-center">
        <div class="chart-event-hint-pill" role="status">
          <div class="chart-event-hint-content">
            <div class="chart-event-hint-text">{props.text}</div>
          </div>
          <span
            class="chart-event-hint-close"
            role="button"
            aria-label="Close"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              props.onClose();
            }}
            innerHTML={CLOSE_ICON}
          />
        </div>
      </div>
    </div>
  );
}
