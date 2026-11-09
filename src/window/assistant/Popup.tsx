/*
 * A small menu of the AI assistant panel, under or above its button.
 */
import { createPopover } from "../../components/popover";

/** A small menu under (or above) its button; a click outside or Escape closes it. Its Escape is marked handled:
 *  the panel keeps its overlay. Presses on menu buttons are theirs (they toggle their menu). */
export function Popup(props: { onClose: () => void; class?: string; children: any }) {
  const el = createPopover(undefined, {
    onClose: props.onClose,
    placement: false,
    press: "mousedown",
    insideSelector: "[aria-haspopup]",
    escape: "mark",
  });
  return (
    <div ref={el} class={"asst-popup " + (props.class ?? "")} role="menu">
      {props.children}
    </div>
  );
}
