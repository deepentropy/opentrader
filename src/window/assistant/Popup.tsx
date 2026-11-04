/*
 * A small menu of the AI assistant panel, under or above its button.
 */
import { onCleanup, onMount } from "solid-js";

/** A small menu under (or above) its button; a click outside or Escape closes it. */
export function Popup(props: { onClose: () => void; class?: string; children: any }) {
  let el!: HTMLDivElement;
  onMount(() => {
    const down = (e: MouseEvent) => {
      if (!el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[aria-haspopup]")) props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      }
    };
    document.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
    });
  });
  return (
    <div ref={el} class={"asst-popup " + (props.class ?? "")} role="menu">
      {props.children}
    </div>
  );
}
