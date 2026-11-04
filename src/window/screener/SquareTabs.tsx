/*
 * Square tabs (the reference app's small square tabs: 34 px, 12 px side padding, 8 px apart, the selected one
 * bold on a filled background), used by a wide screener for its column sets and the Charts date range. Tabs
 * that do not fit go, from the end, into a "More" menu at the end of the row. A tab keeps the width of its
 * bold label, so selecting one does not move the others.
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "../../components/Icon";
import { PopItem, Popover } from "./Popover";

export type SquareTab = { id: string; label: string };

const GAP = 8;

export function SquareTabs(props: { items: SquareTab[]; active: string | null; onPick: (id: string) => void; label: string }) {
  let wrap!: HTMLDivElement;
  let measure!: HTMLDivElement;
  let moreBtn!: HTMLButtonElement;
  const [fit, setFit] = createSignal(Number.POSITIVE_INFINITY);
  const [menuOpen, setMenuOpen] = createSignal(false);

  /** How many tabs fit: their widths (read from the hidden copy) and the gaps, less the More button when some
   *  are left out. */
  const layout = () => {
    const tabs = [...measure.querySelectorAll<HTMLElement>("[data-tab]")].map((e) => e.offsetWidth);
    const more = measure.querySelector<HTMLElement>("[data-more]")?.offsetWidth ?? 0;
    const room = wrap.clientWidth;
    const width = (n: number) => tabs.slice(0, n).reduce((s, w) => s + w, 0) + Math.max(0, n - 1) * GAP;
    if (width(tabs.length) <= room) return setFit(tabs.length);
    let n = tabs.length;
    while (n > 0 && width(n) + GAP + more > room) n--;
    setFit(n);
  };
  onMount(() => {
    const ro = new ResizeObserver(layout);
    ro.observe(wrap);
    ro.observe(measure);
    onCleanup(() => ro.disconnect());
  });

  const shown = () => props.items.slice(0, fit());
  const hidden = () => props.items.slice(fit());
  const tab = (t: SquareTab, fake = false) => (
    <button
      type="button"
      role="tab"
      class="scr-sqtab"
      classList={{ "is-selected": t.id === props.active }}
      aria-selected={t.id === props.active}
      tabIndex={fake ? -1 : undefined}
      data-tab={fake ? "" : undefined}
      onClick={() => !fake && props.onPick(t.id)}
    >
      <span class="scr-sqtab-text">{t.label}</span>
      <span class="scr-sqtab-bold" aria-hidden="true">{t.label}</span>
    </button>
  );

  return (
    <div ref={wrap} class="scr-sqtabs" role="tablist" aria-label={props.label}>
      <For each={shown()}>{(t) => tab(t)}</For>
      <Show when={hidden().length > 0}>
        <button
          ref={moreBtn}
          type="button"
          class="scr-sqtab scr-sqtab-more"
          classList={{ "is-open": menuOpen() }}
          aria-haspopup="menu"
          aria-expanded={menuOpen()}
          onClick={() => setMenuOpen(!menuOpen())}
        >
          <span class="scr-sqtab-text">More</span>
          <span class="scr-sqtab-arrow" classList={{ "is-open": menuOpen() }}><Icon name="scr-caret-small" size={18} /></span>
        </button>
      </Show>
      {/* Every tab and the More button, out of sight, for their widths. */}
      <div ref={measure} class="scr-sqtabs-measure" aria-hidden="true">
        <For each={props.items}>{(t) => tab(t, true)}</For>
        <span class="scr-sqtab scr-sqtab-more" data-more="">
          <span class="scr-sqtab-text">More</span>
          <span class="scr-sqtab-arrow"><Icon name="scr-caret-small" size={18} /></span>
        </span>
      </div>
      <Show when={menuOpen()}>
        <Popover anchor={moreBtn} onClose={() => setMenuOpen(false)}>
          <For each={hidden()}>
            {(t) => (
              <PopItem
                title={t.label}
                selected={t.id === props.active}
                onClick={() => {
                  setMenuOpen(false);
                  props.onPick(t.id);
                }}
              />
            )}
          </For>
        </Popover>
      </Show>
    </div>
  );
}
