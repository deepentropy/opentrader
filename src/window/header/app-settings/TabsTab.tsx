/*
 * Settings > Tabs: the parts of a tab title, their order (drag) and visibility.
 */
import { createSignal, For, type JSX } from "solid-js";
import { Icon } from "../../../components/Icon";
import { CheckField } from "../../../components/form";
import { DEFAULT_TAB_TITLE_PARTS, TAB_TITLE_LABEL, type TabTitlePartState } from "../../shell/tab-title";
import { Section } from "./parts";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function TabsTab(props: { parts: TabTitlePartState[]; onChange: (p: TabTitlePartState[]) => void }) {
  // Sliding drag-reorder: the order array stays put during the drag — only
  // transforms move. The grabbed row follows the cursor; rows it passes slide
  // one slot to open the landing gap. On pointer-up we reorder + clear.
  const [drag, setDrag] = createSignal<{ id: string; from: number; dy: number; stride: number } | null>(null);
  let info: { id: string; from: number; stride: number; startY: number } | null = null;
  let listEl: HTMLDivElement | undefined;

  const toggle = (id: string) =>
    props.onChange(props.parts.map((p) => (p.id === id ? { ...p, visible: !p.visible } : p)));
  const reset = () => props.onChange(DEFAULT_TAB_TITLE_PARTS.map((p) => ({ ...p })));

  const targetIndex = (d: { from: number; dy: number; stride: number }) =>
    clamp(d.from + Math.round(d.dy / d.stride), 0, props.parts.length - 1);

  const onHandleDown = (e: PointerEvent, id: string, index: number) => {
    e.preventDefault();
    const rows = listEl?.querySelectorAll<HTMLElement>(".app-settings-drag-row");
    const stride = rows && rows.length > 1
      ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top
      : 36;
    info = { id, from: index, stride, startY: e.clientY };
    setDrag({ id, from: index, dy: 0, stride });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: PointerEvent) => {
    if (!info) return;
    setDrag({ id: info.id, from: info.from, stride: info.stride, dy: e.clientY - info.startY });
  };
  const onHandleUp = (e: PointerEvent) => {
    const i = info;
    info = null;
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (i) {
      const to = targetIndex({ from: i.from, dy: e.clientY - i.startY, stride: i.stride });
      if (to !== i.from) {
        const next = props.parts.slice();
        const [moved] = next.splice(i.from, 1);
        next.splice(to, 0, moved);
        props.onChange(next);
      }
    }
    setDrag(null);
  };

  const rowStyle = (i: number): JSX.CSSProperties => {
    const d = drag();
    if (!d) return {};
    if (props.parts[i].id === d.id) {
      return { transform: `translateY(${d.dy}px)`, transition: "none", "z-index": 2, position: "relative" };
    }
    const to = targetIndex(d);
    let ty = 0;
    if (to > d.from && i > d.from && i <= to) ty = -d.stride;
    else if (to < d.from && i >= to && i < d.from) ty = d.stride;
    return { transform: `translateY(${ty}px)`, transition: "transform 0.15s ease" };
  };

  return (
    <>
      <Section label="TAB TITLE (DRAG TO REORDER)">
        <div class="app-settings-tab-order" ref={listEl}>
          <For each={props.parts}>
            {(p, i) => (
              <div
                class={`app-settings-drag-row${drag()?.id === p.id ? " is-dragging" : ""}`}
                style={rowStyle(i())}
              >
                <CheckField variant="settings" label={TAB_TITLE_LABEL[p.id]} checked={p.visible} onChange={() => toggle(p.id)} />
                <span
                  class="app-settings-drag-handle"
                  aria-label="Drag to reorder"
                  onPointerDown={(e) => onHandleDown(e, p.id, i())}
                  onPointerMove={onHandleMove}
                  onPointerUp={onHandleUp}
                >
                  <Icon name="settings-drag" size={18} />
                </span>
              </div>
            )}
          </For>
        </div>
      </Section>
      <div class="app-settings-control-button">
        <button type="button" class="app-settings-btn" onClick={reset}>Back to defaults</button>
      </div>
    </>
  );
}
