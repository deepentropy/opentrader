/*
 * SegmentedControl — TV's iOS-style toggle pill. One shared CSS module,
 * used verbatim across panels.
 */
import { For } from "solid-js";

export interface SegmentedControlItem<Id extends string> {
  id: Id;
  label: string;
}

interface Props<Id extends string> {
  items: readonly SegmentedControlItem<Id>[];
  value: Id;
  onChange: (id: Id) => void;
  class?: string;
  ariaLabel?: string;
}

export function SegmentedControl<Id extends string>(props: Props<Id>) {
  return (
    <div
      role="tablist"
      aria-label={props.ariaLabel}
      class={`tv-segmented-control${props.class ? " " + props.class : ""}`}
    >
      <For each={props.items}>
        {(it) => {
          const selected = () => props.value === it.id;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={selected()}
              class={`tv-segmented-control__segment${selected() ? " selected" : ""}`}
              onClick={() => props.onChange(it.id)}
            >
              {it.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}
