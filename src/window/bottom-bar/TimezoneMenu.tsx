/*
 * TimezoneMenu — the drop-up popup from the bottom-bar timezone label. Ported
 * to SolidJS from the reference mock; a scrollable list of IANA zones, the
 * active one checked + scrolled into view. Click/Escape closes; selecting a row
 * sets the chart's display timezone.
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { TIMEZONES, type TimezoneEntry } from "../../data/timezones";

type Props = {
  anchor: DOMRect;
  activeLabel: string;
  onSelect: (entry: TimezoneEntry) => void;
  onClose: () => void;
};

const CheckIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
    <path fill="currentColor" d="M22 9.06 11 20 6 14.7l1.09-1.02 3.94 4.16L20.94 8 22 9.06Z" />
  </svg>
);

export function TimezoneMenu(props: Props) {
  let popupRef: HTMLDivElement | undefined;
  let selectedRow: HTMLTableRowElement | undefined;
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);

  onMount(() => {
    // Position above the anchor (drop-up); clamp into the viewport.
    if (popupRef) {
      const popH = popupRef.offsetHeight;
      const popW = popupRef.offsetWidth;
      const M = 4;
      let left = Math.round(props.anchor.right - popW);
      let top = Math.round(props.anchor.top - popH - M);
      if (left < M) left = M;
      if (left + popW > window.innerWidth - M) left = window.innerWidth - popW - M;
      if (top < M) top = Math.round(props.anchor.bottom + M);
      setPos({ left, top });
    }
    selectedRow?.scrollIntoView({ block: "center" });

    // Defer the outside-click listener a tick so the opening click doesn't close.
    let armed = false;
    const arm = () => { armed = true; };
    const onDown = (e: MouseEvent) => { if (armed && popupRef && !popupRef.contains(e.target as Node)) props.onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    const t = setTimeout(arm, 0);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });

  return (
    <Portal>
      <div
        ref={popupRef}
        class="tv-popover tv-popover--scrollable tz-menu-wrap context-menu"
        role="menu"
        aria-label="Timezone"
        style={pos() ? { left: `${pos()!.left}px`, top: `${pos()!.top}px` } : { left: "-9999px", top: "-9999px" }}
      >
        <div class="tz-menu-scroll">
          <div class="tz-menu-box" data-qa-id="menu-inner">
            <table>
              <tbody>
                <For each={TIMEZONES}>
                  {(tz) => {
                    const checked = tz.label === props.activeLabel;
                    return (
                      <>
                        <tr
                          ref={checked ? selectedRow : undefined}
                          data-role="menuitem"
                          tabIndex={-1}
                          class="tz-menu-item"
                          aria-checked={checked}
                          onClick={() => { props.onSelect(tz); props.onClose(); }}
                        >
                          <td class="tz-menu-icon-cell" data-icon-cell="true">
                            <span class="tz-menu-icon" data-icon-checkmark={checked ? "true" : undefined}>
                              <Show when={checked}><CheckIcon /></Show>
                            </span>
                          </td>
                          <td>
                            <div class="tz-menu-content">
                              <span class={`tz-menu-label${checked ? " tz-menu-label-checked" : ""}`} data-label="true">{tz.label}</span>
                            </div>
                          </td>
                        </tr>
                        <tr class="tz-menu-sub" aria-hidden="true"><td /></tr>
                      </>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Portal>
  );
}
