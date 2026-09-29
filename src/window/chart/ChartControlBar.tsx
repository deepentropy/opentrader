/*
 * The centred control bar: zoom out/in, maximize, scroll left/right, reset.
 * The `.control-bar` half of the navigation controls (the other half, the
 * bottom-right "Scroll to the most recent bar" button, lives in ChartView).
 *
 * Purely presentational — ChartView measures the anchor, decides which groups
 * fit and owns every action. The DOM order below is zoom, maximize,
 * scroll, reset, which is NOT the priority order the groups drop in.
 *
 * Buttons are wrapped in Tooltip, so each one reports its own hotkey; the two
 * scroll buttons repeat while held, which is why they are on mousedown/up
 * rather than click.
 */
import { Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import type { GroupId } from "./control-bar";

type Props = {
  /** Wrapper anchor, in px from the chart's bottom-left. */
  bottom: number;
  left: number;
  /** Hidden state: the whole bar fades as one. */
  visible: boolean;
  /** Groups with room to render, from the priority fit. */
  fits: Set<GroupId>;
  /** Reset is hidden (but still reserves space) when scales are at default. */
  resetAvailable: boolean;
  /** True while this chart is the maximized one: the button lights up. */
  maximized: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleMaximize: () => void;
  /** Held-down repeat: `dir` -1 scrolls into history, +1 toward the last bar. */
  onMoveStart: (dir: -1 | 1) => void;
  onMoveStop: () => void;
  onReset: () => void;
  ref?: (el: HTMLDivElement) => void;
};

/** Move-left/right starts on mousedown and stops on mouseup *or* mouseout. */
function holdProps(start: () => void, stop: () => void) {
  return {
    onMouseDown: (e: MouseEvent) => {
      e.preventDefault();
      start();
    },
    onMouseUp: stop,
    onMouseOut: stop,
    onContextMenu: (e: MouseEvent) => e.preventDefault(),
  };
}

export function ChartControlBar(props: Props) {
  return (
    <div
      ref={props.ref}
      class="ot-control-bar"
      style={{ bottom: `${props.bottom}px`, left: `${props.left}px` }}
    >
      <div class="ot-control-bar__row" classList={{ "ot-control-bar__row--hidden": !props.visible }}>
        <Show when={props.fits.has("zoom")}>
          <div class="ot-control-bar__group ot-control-bar__group--zoom">
            <Tooltip text="Zoom out" hotkey="Ctrl + ↓" side="top">
              <div class="ot-control-bar__btn" onClick={props.onZoomOut} onContextMenu={(e) => e.preventDefault()}>
                <Icon name="chart-zoom-out" />
              </div>
            </Tooltip>
            <Tooltip text="Zoom in" hotkey="Ctrl + ↑" side="top">
              <div class="ot-control-bar__btn" onClick={props.onZoomIn} onContextMenu={(e) => e.preventDefault()}>
                <Icon name="chart-zoom-in" />
              </div>
            </Tooltip>
          </div>
        </Show>
        <Show when={props.fits.has("maximize")}>
          <div class="ot-control-bar__group ot-control-bar__group--maximize">
            <Tooltip
              text={props.maximized ? "Restore chart" : "Maximize chart"}
              hotkey="Alt + Click + Alt + Enter"
              hotkeyText="{0} + {1}, {2} + {3}"
              side="top"
            >
              <div
                class="ot-control-bar__btn"
                classList={{ "ot-control-bar__btn--activated": props.maximized }}
                onClick={props.onToggleMaximize}
                onContextMenu={(e) => e.preventDefault()}
              >
                <Icon name="chart-maximize" />
              </div>
            </Tooltip>
          </div>
        </Show>
        <Show when={props.fits.has("scroll")}>
          <div class="ot-control-bar__group ot-control-bar__group--scroll">
            <Tooltip text="Scroll to the left" hotkey="←" side="top">
              <div
                class="ot-control-bar__btn ot-control-bar__btn--move-left"
                {...holdProps(() => props.onMoveStart(-1), props.onMoveStop)}
              >
                <Icon name="chart-move" />
              </div>
            </Tooltip>
            <Tooltip text="Scroll to the right" hotkey="→" side="top">
              <div class="ot-control-bar__btn" {...holdProps(() => props.onMoveStart(1), props.onMoveStop)}>
                <Icon name="chart-move" />
              </div>
            </Tooltip>
          </div>
        </Show>
        <Show when={props.fits.has("reset")}>
          <div class="ot-control-bar__group ot-control-bar__group--reset">
            <Tooltip text="Reset chart view" hotkey="Alt + R" side="top">
              <div
                class="ot-control-bar__btn"
                classList={{ "ot-control-bar__btn--hidden": !props.resetAvailable }}
                onClick={props.onReset}
                onContextMenu={(e) => e.preventDefault()}
              >
                <Icon name="chart-reset-view" />
              </div>
            </Tooltip>
          </div>
        </Show>
      </div>
    </div>
  );
}
