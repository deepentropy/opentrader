/*
 * FontIconPicker — the picker that opens when the user picks Icon / Emoji /
 * Sticker from the DrawingToolbar's Font Icons group. Solid port of the
 * reference mock's picker: a LEFT-DOCKED panel flush against the drawing
 * toolbar (not a floating modal), with three stacked rows — a top category
 * strip, a scrollable section-headed glyph grid, and a bottom tab strip
 * (Emojis / Stickers / Icons). Selecting a glyph stages it (via `onPick`) and
 * closes; the next chart click places it as a `font-icon` drawing.
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { TV_ICON_CATEGORIES, TV_STICKERS } from "./font-icons-catalog";
import { EMOJI_CATEGORIES } from "./emoji-catalog";

export type FontIconTab = "emoji" | "sticker" | "icon";

const TAB_LABELS: Record<FontIconTab, string> = { emoji: "Emojis", sticker: "Stickers", icon: "Icons" };

type Props = {
  /** Which bottom tab opens first (driven by the submenu row picked). */
  initialTab: FontIconTab;
  onClose: () => void;
  /** Stage the chosen glyph (emoji char or raw `<svg>` markup) + close. */
  onPick: (value: string) => void;
};

type PickerCategory = { id: string; label: string; symbol: string; isSvg: boolean };
type GridCell = { key: string; value: string; isSvg: boolean };

const EMOJI_PICKER_CATEGORIES: PickerCategory[] = EMOJI_CATEGORIES.map((c) => ({
  id: c.id, label: c.label, symbol: c.symbol, isSvg: false,
}));
const ICON_PICKER_CATEGORIES: PickerCategory[] = TV_ICON_CATEGORIES.map((c) => ({
  id: c.id, label: c.label, symbol: c.glyphs[0]?.svg ?? "", isSvg: true,
}));

/** Renders a cell's content: SVG markup inline, or a Unicode glyph as text. */
function GlyphContent(props: { value: string; isSvg: boolean }) {
  return (
    <Show when={props.isSvg} fallback={<>{props.value}</>}>
      <span class="font-icon-picker-svg" innerHTML={props.value} />
    </Show>
  );
}

export function FontIconPicker(props: Props) {
  const [tab, setTab] = createSignal<FontIconTab>(props.initialTab);
  const [emojiCat, setEmojiCat] = createSignal<string>(EMOJI_CATEGORIES[0].id);
  const [iconCat, setIconCat] = createSignal<string>(TV_ICON_CATEGORIES[0].id);

  onMount(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); props.onClose(); } };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  // The category strip above the grid (empty for the Stickers tab).
  const categories = (): PickerCategory[] =>
    tab() === "emoji" ? EMOJI_PICKER_CATEGORIES : tab() === "icon" ? ICON_PICKER_CATEGORIES : [];
  const activeCat = () => (tab() === "emoji" ? emojiCat() : iconCat());
  const setActiveCat = (id: string) => (tab() === "emoji" ? setEmojiCat(id) : setIconCat(id));

  const grid = createMemo<GridCell[]>(() => {
    if (tab() === "emoji") {
      const glyphs = EMOJI_CATEGORIES.find((c) => c.id === emojiCat())?.glyphs ?? [];
      return glyphs.map((g, i) => ({ key: `emoji-${i}-${g}`, value: g, isSvg: false }));
    }
    if (tab() === "sticker") {
      return TV_STICKERS.map((s) => ({ key: `sticker-${s.name}`, value: s.svg, isSvg: true }));
    }
    const glyphs = TV_ICON_CATEGORIES.find((c) => c.id === iconCat())?.glyphs ?? [];
    return glyphs.map((g) => ({ key: `icon-${iconCat()}-${g.name}`, value: g.svg, isSvg: true }));
  });

  const sectionHeader = () =>
    tab() === "emoji" ? EMOJI_CATEGORIES.find((c) => c.id === emojiCat())?.label :
    tab() === "icon" ? TV_ICON_CATEGORIES.find((c) => c.id === iconCat())?.label :
    "Stickers";

  const pick = (value: string) => { props.onPick(value); props.onClose(); };

  // Backdrop + panel are SIBLINGS: the panel docks at the toolbar's right edge
  // (its position:relative parent); the backdrop is a separate fixed layer that
  // only catches outside clicks.
  return (
    <>
      <div class="font-icon-picker-backdrop" onMouseDown={() => props.onClose()} />
      <div class="font-icon-picker" onMouseDown={(e) => e.stopPropagation()}>
        <Show when={categories().length > 0}>
          <div class="font-icon-picker-category-bar">
            <For each={categories()}>
              {(cat) => (
                <button
                  type="button"
                  title={cat.label}
                  class={`font-icon-picker-cat${activeCat() === cat.id ? " active" : ""}`}
                  onClick={() => setActiveCat(cat.id)}
                ><GlyphContent value={cat.symbol} isSvg={cat.isSvg} /></button>
              )}
            </For>
          </div>
        </Show>

        <div class="font-icon-picker-list">
          <Show when={sectionHeader()}>
            <div class="font-icon-picker-section-header">{sectionHeader()!.toUpperCase()}</div>
          </Show>
          <div class={`font-icon-picker-grid grid-${tab()}`}>
            <For each={grid()}>
              {(cell) => (
                <button type="button" class="font-icon-picker-cell" onClick={() => pick(cell.value)}>
                  <GlyphContent value={cell.value} isSvg={cell.isSvg} />
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="font-icon-picker-tabs">
          <For each={["emoji", "sticker", "icon"] as FontIconTab[]}>
            {(t) => (
              <button
                type="button"
                class={`font-icon-picker-tab${tab() === t ? " active" : ""}`}
                onClick={() => setTab(t)}
              >{TAB_LABELS[t]}</button>
            )}
          </For>
        </div>
      </div>
    </>
  );
}
