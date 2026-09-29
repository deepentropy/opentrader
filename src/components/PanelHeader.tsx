/*
 * PanelHeader — shared 48-px header strip used by every right-rail widget
 * (Watchlist today; Alerts/Object tree/Chats when they land).
 *
 * Slot model: `left` carries the widget's name or a SegmentedControl;
 * `right` carries the per-panel action buttons.
 */
import type { JSX } from "solid-js";

type Props = {
  left?: JSX.Element;
  right?: JSX.Element;
  class?: string;
  ariaLabel?: string;
};

export function PanelHeader(props: Props) {
  return (
    <header
      class={`ot-panel-header${props.class ? " " + props.class : ""}`}
      aria-label={props.ariaLabel}
    >
      {props.left !== undefined && (
        <div class="ot-panel-header__left">{props.left}</div>
      )}
      {props.right !== undefined && (
        <div class="ot-panel-header__right">{props.right}</div>
      )}
    </header>
  );
}
