/*
 * IconButton — 28×28 compact button used by panel headers.
 * Composes the shared `.tv-toolbar-button` base for the hover pill;
 * `.tv-icon-button` only adds dimensions + a 4px pill radius.
 */
import type { JSX } from "solid-js";
import { splitProps } from "solid-js";

type Props = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  class?: string;
  ref?: (el: HTMLButtonElement) => void;
};

export function IconButton(props: Props) {
  const [local, rest] = splitProps(props, ["class", "children", "type"]);
  return (
    <button
      type={local.type ?? "button"}
      class={`tv-toolbar-button tv-icon-button${local.class ? " " + local.class : ""}`}
      {...rest}
    >
      {local.children}
    </button>
  );
}
