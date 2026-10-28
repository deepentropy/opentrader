/*
 * Order presets of the order ticket (header button, reference app): the menu
 * ("Save order preset…", then the ORDER PRESETS list, each preset with its
 * order type, price offsets and exits, a delete button on hover) and the
 * "Save order preset" dialog (name, the order parameters saved). A preset
 * keeps the order type, the price offsets in ticks (the same value for buys
 * and sells: "Sell Bid – 5  Buy Ask + 5") and the exits in ticks / % price /
 * % balance; choosing one applies them to the ticket.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { showConfirm } from "../../components/Dialogs";
import { Tooltip } from "../../components/Tooltip";
import { replayBroker } from "../../data/trading/replay-broker";
import { MAX_PRESETS, ticketQty, tradingUi, type OrderPreset, type TicketDraft } from "../../data/trading/trading-ui";
import type { Side } from "../../data/trading/types";
import { InfoIcon, Popup } from "./TicketMenus";
import { buildTicket, presetFields, presetPriceText, resolveDraft } from "./ticket";
import { tickDecimals } from "./format";
import { ChevronIcon, CloseIcon } from "./icons";

const TYPE_TEXT: Record<OrderPreset["orderType"], string> = {
  market: "Market order",
  limit: "Limit order",
  stop: "Stop order",
  stopLimit: "Stop Limit order",
};

const OFFSET_INFO = "Presets use a tick offset from bid and ask — this is the same value for buys and sells.";

const num = (v: number) => String(Number(v.toFixed(8)));

function exitText(prefix: "TP" | "SL", v: number | undefined, type: OrderPreset["tpPriceType"]): string {
  if (!v) return "";
  if (type === "balancePct") return `${prefix} ${num(v)} % balance`;
  if (type === "pricePct") return `${prefix} ${num(v)} % price`;
  return `${prefix} ${num(v)}`;
}

/** The lines describing a preset: order type, prices, exits. */
export function presetLines(p: Omit<OrderPreset, "id" | "title">): { type: string; prices: string[] | null; exits: string | null } {
  const prices =
    p.buyPrice === undefined || p.sellPrice === undefined
      ? null
      : p.stopBuyLimitPrice === undefined || p.stopSellLimitPrice === undefined
        ? [`${presetPriceText("Sell Bid", p.sellPrice)}  ${presetPriceText("Buy Ask", p.buyPrice)}`]
        : [
            `${presetPriceText("Sell Bid", p.sellPrice)}  ${presetPriceText("Limit at Stop", p.stopSellLimitPrice)}`,
            `${presetPriceText("Buy Ask", p.buyPrice)}  ${presetPriceText("Limit at Stop", p.stopBuyLimitPrice)}`,
          ];
  const tp = exitText("TP", p.tpPrice, p.tpPriceType);
  const sl = exitText("SL", p.slPrice, p.slPriceType);
  return { type: TYPE_TEXT[p.orderType], prices, exits: tp || sl ? `Exits: ${[tp, sl].filter(Boolean).join("  ")}` : null };
}

function PresetDescription(props: { preset: Omit<OrderPreset, "id" | "title">; bullets?: boolean; info?: boolean }) {
  const l = () => presetLines(props.preset);
  return (
    <div class="trd-preset-desc" classList={{ "is-bullets": !!props.bullets }}>
      <div>{l().type}</div>
      <Show when={l().prices}>
        {(ps) => (
          <div>
            <For each={ps()}>{(t, i) => <>{i() > 0 ? <br /> : null}{t}</>}</For>
            <Show when={props.info}>
              <Tooltip text={OFFSET_INFO} side="top" width="normal">
                <span class="trd-menu-info">
                  <InfoIcon />
                </span>
              </Tooltip>
            </Show>
          </div>
        )}
      </Show>
      <Show when={l().exits}>{(t) => <div>{t()}</div>}</Show>
    </div>
  );
}

const SaveIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <path d="M9 19.5H8a4 4 0 0 1-.6-7.96 5.5 5.5 0 0 1 10.73-1.3A4.5 4.5 0 0 1 19.5 19.5H19" stroke-linejoin="round" />
    <path d="M14 21.5v-8m-3 3 3-3 3 3" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

const PresetsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <rect x="2.5" y="2.5" width="5" height="5" rx="1" />
    <rect x="10.5" y="2.5" width="5" height="5" rx="1" />
    <rect x="2.5" y="10.5" width="5" height="5" rx="1" />
    <path d="M13 10.5v5M10.5 13h5" stroke-linecap="round" />
  </svg>
);

const TrashIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <path d="M3.5 5h11M7 5V3.5h4V5M5 5l.7 9.5h6.6L13 5M7.5 7.5v5M10.5 7.5v5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

/** Favourite star: outlined, filled once starred. */
const StarIcon = (p: { filled: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path
      d="M9 2.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L9 12.4l-3.8 2 .7-4.3-3.1-3 4.3-.6z"
      fill={p.filled ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-linejoin="round"
    />
  </svg>
);

/** The favourite presets as tags at the top of the order ticket (reference
 *  app): the title's leading emoji, else its first letter; a click applies
 *  the preset, `applied` marks the one the ticket matches. */
export function FavoritePresets(props: { applied: (p: OrderPreset) => boolean; apply: (p: OrderPreset) => void }) {
  const favorites = () => tradingUi.presets().filter((p) => p.favorite);
  return (
    <Show when={favorites().length > 0}>
      <div class="trd-fav-presets" data-qa-id="favorite-order-presets">
        <For each={favorites()}>
          {(p, i) => (
            <button type="button" class="trd-fav-preset" aria-label={p.title} data-qa-id={`favorite-preset-tag-${i() + 1}`} onClick={() => props.apply(p)}>
              <span class="trd-fav-preset-tag" classList={{ "is-applied": props.applied(p) }}>
                {leadingSymbol(p.title)}
              </span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

/** The title's first character (a whole grapheme: an emoji stays whole). */
function leadingSymbol(title: string): string {
  const t = title.trim();
  const seg = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  const first = seg ? (seg.segment(t)[Symbol.iterator]().next().value?.segment ?? "") : Array.from(t)[0] ?? "";
  return first;
}

/** Ask before deleting a preset. */
function confirmRemove(p: OrderPreset) {
  showConfirm({
    title: "Delete this preset?",
    text: `Doing this will permanently delete your
"${p.title}" order preset.`,
    mainText: "Delete",
    cancelText: "Cancel",
    intent: "danger",
    onConfirm: () => tradingUi.removePreset(p.id),
  });
}

/** The ORDER PRESETS section of a presets menu: each preset with its order
 *  type, prices and exits, a delete button on hover; `active` = the one
 *  selected (chart Buy / Sell buttons). */
function PresetList(props: { active?: string | null; onSelect: (p: OrderPreset) => void; onClose: () => void }) {
  return (
    <>
      <div class="trd-menu-section">Order presets</div>
      <For each={tradingUi.presets()}>
        {(p) => (
          <div
            class="trd-menu-row trd-preset-item"
            classList={{ "is-selected": props.active === p.id }}
            role="menuitem"
            tabIndex={0}
            onClick={() => {
              props.onClose();
              props.onSelect(p);
            }}
          >
            <div class="trd-preset-body">
              <div class="trd-preset-title">{p.title}</div>
              <PresetDescription preset={p} />
            </div>
            <button
              type="button"
              class="trd-preset-remove"
              aria-label="Remove"
              onClick={(e) => {
                e.stopPropagation();
                props.onClose();
                confirmRemove(p);
              }}
            >
              <TrashIcon />
            </button>
            <Tooltip text={p.favorite ? "Remove from favorites" : "Add to favorites"} side="top">
              <button
                type="button"
                class="trd-preset-favorite"
                classList={{ "is-on": !!p.favorite }}
                aria-label={p.favorite ? "Remove from favorites" : "Add to favorites"}
                onClick={(e) => {
                  e.stopPropagation();
                  e.currentTarget.blur();
                  tradingUi.togglePresetFavorite(p.id);
                }}
              >
                <StarIcon filled={!!p.favorite} />
              </button>
            </Tooltip>
          </div>
        )}
      </For>
    </>
  );
}

/** Header button: the presets menu. `current` = the preset the ticket would
 *  save now (null: nothing to save); `apply` = choose a preset. */
export function OrderPresetsButton(props: { current: () => Omit<OrderPreset, "id" | "title"> | null; apply: (p: OrderPreset) => void }) {
  const [open, setOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  let btn!: HTMLButtonElement;
  const close = () => setOpen(false);
  return (
    <>
      <Show when={!open()} fallback={<PresetsBtn ref={(e) => (btn = e)} open onClick={close} />}>
        <Tooltip text="Order presets" side="bottom">
          <PresetsBtn ref={(e) => (btn = e)} open={false} onClick={() => setOpen(true)} />
        </Tooltip>
      </Show>
      <Show when={open()}>
        <Popup anchor={btn} alignEnd onClose={close} class="trd-menu-presets" label="Order presets">
          <button
            type="button"
            class="trd-menu-row trd-preset-save"
            classList={{ "is-disabled": !props.current() }}
            aria-disabled={!props.current()}
            onClick={() => {
              if (!props.current()) return;
              close();
              // At most MAX_PRESETS (reference app's warning).
              if (tradingUi.presets().length >= MAX_PRESETS) {
                showConfirm({
                  title: "You've reached the maximum limit of presets",
                  text: `Currently, you can create up to ${MAX_PRESETS} presets. To create a new preset, delete an existing one.`,
                  mainText: "Got it",
                  cancelText: null,
                  intent: "neutral",
                  onConfirm: () => {},
                });
                return;
              }
              setSaving(true);
            }}
          >
            <SaveIcon />
            <span class="trd-menu-title">Save order preset…</span>
          </button>
          <div class="trd-menu-divider" />
          <Show
            when={tradingUi.presets().length}
            fallback={<div class="trd-preset-empty">No order presets created yet</div>}
          >
            <PresetList onSelect={props.apply} onClose={close} />
          </Show>
        </Popup>
      </Show>
      <Show when={saving() && props.current()}>
        {(cur) => <SavePresetDialog preset={cur()} onClose={() => setSaving(false)} />}
      </Show>
    </>
  );
}

/** Chevron after the chart's Buy / Sell buttons (shown while presets
 *  exist): "Reset order preset" (no preset active: disabled), then the
 *  presets; the one chosen titles the buttons and shapes their orders. */
export function BuySellPresetsButton() {
  const [open, setOpen] = createSignal(false);
  let btn!: HTMLButtonElement;
  const close = () => setOpen(false);
  return (
    <>
      <Tooltip text="Select order preset" side="bottom">
        <button
          type="button"
          ref={btn}
          class="ot-trd-buysell__presets"
          classList={{ "is-active": open() }}
          aria-label="Select order preset"
          aria-haspopup="menu"
          aria-expanded={open()}
          data-qa-id="sell-buy-buttons-order-presets-menu-button"
          onClick={() => setOpen(!open())}
        >
          <ChevronIcon open={open()} />
        </button>
      </Tooltip>
      <Show when={open()}>
        <Popup anchor={btn} onClose={close} class="trd-menu-presets" label="Order presets">
          <button
            type="button"
            class="trd-menu-row"
            classList={{ "is-disabled": !tradingUi.activePreset() }}
            aria-disabled={!tradingUi.activePreset()}
            onClick={() => {
              if (!tradingUi.activePreset()) return;
              close();
              tradingUi.setActivePreset(null);
            }}
          >
            <span class="trd-menu-title">Reset order preset</span>
          </button>
          <div class="trd-menu-divider" />
          <PresetList active={tradingUi.activePreset()?.id} onSelect={(p) => tradingUi.setActivePreset(p.id)} onClose={close} />
        </Popup>
      </Show>
    </>
  );
}

/** One-click Buy / Sell with an active preset: the preset's order at once
 *  (the next orders' quantity); a preset that gives no valid order asks to
 *  reset it. */
export function placePresetOrder(p: OrderPreset, side: Side, symbol: string) {
  const q = replayBroker.quote();
  const tick = q?.minTick ?? 0.01;
  const dec = Math.max(2, tickDecimals(tick) ?? 2);
  const base: TicketDraft = { ...tradingUi.newDraft(symbol, side), qty: String(ticketQty()) };
  const d: TicketDraft = { ...base, ...presetFields(p, base, q, tick, dec) };
  const balance = replayBroker.settings().initialCapital + (replayBroker.report()?.performance.all.netProfit ?? 0);
  const t = buildTicket(resolveDraft(d, q, { tick, decimals: dec, balance, pointValue: 1 }), q);
  if (typeof t !== "string") {
    replayBroker.place(t);
    return;
  }
  showConfirm({
    title: "Order can't be placed with current settings",
    text: t,
    mainText: "Reset order preset",
    cancelText: "Cancel",
    onConfirm: () => tradingUi.setActivePreset(null),
  });
}

function PresetsBtn(props: { ref: (e: HTMLButtonElement) => void; open: boolean; onClick: () => void }) {
  return (
    <button type="button" ref={props.ref} class="trd-icon-btn" classList={{ "is-active": props.open }} aria-label="Order presets" aria-haspopup="menu" aria-expanded={props.open} onClick={() => props.onClick()}>
      <PresetsIcon />
    </button>
  );
}

/** "Save order preset": a name (an existing one is replaced) and the order
 *  parameters saved. */
function SavePresetDialog(props: { preset: Omit<OrderPreset, "id" | "title">; onClose: () => void }) {
  const [name, setName] = createSignal("");
  const [listOpen, setListOpen] = createSignal(false);
  const names = createMemo(() => tradingUi.presets().map((p) => p.title));
  let input!: HTMLInputElement;
  const save = () => {
    const n = name().trim();
    if (!n) return;
    const same = tradingUi.presets().find((p) => p.title === n);
    if (same) tradingUi.removePreset(same.id);
    tradingUi.addPreset({ ...props.preset, title: n });
    props.onClose();
  };
  onMount(() => {
    input.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (listOpen()) setListOpen(false);
        else props.onClose();
      } else if (e.key === "Enter") {
        e.stopPropagation();
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", key, true);
    onCleanup(() => window.removeEventListener("keydown", key, true));
  });
  return (
    <Portal mount={document.body}>
      <div class="ot-dlg-layer" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <div class="ot-dlg trd-preset-dlg" role="dialog" aria-label="Save order preset">
          <div class="ot-dlg-title">Save order preset</div>
          <button type="button" class="ot-dlg-close" aria-label="close" onClick={() => props.onClose()}>
            <CloseIcon />
          </button>
          <div class="ot-dlg-content">
            <label class="ot-dlg-label" for="trd-preset-name">Name</label>
            <div class="ot-dlg-field">
              <span class="ot-dlg-input-box">
                <input
                  ref={input}
                  id="trd-preset-name"
                  class="ot-dlg-input"
                  type="text"
                  maxLength={64}
                  placeholder="Enter preset name"
                  value={name()}
                  spellcheck={false}
                  autocomplete="off"
                  onInput={(e) => setName(e.currentTarget.value)}
                />
                <Show when={names().length > 0}>
                  <button type="button" class="ot-dlg-list-btn" classList={{ "is-open": listOpen() }} aria-label="Show names" tabIndex={-1} onClick={() => setListOpen(!listOpen())}>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                      <path fill="currentColor" d="M3.92 7.83 9 12.29l5.08-4.46-1-1.13L9 10.29l-4.09-3.6-.99 1.14Z" />
                    </svg>
                  </button>
                </Show>
              </span>
              <Show when={listOpen()}>
                <div class="ot-dlg-suggestions" role="listbox">
                  <For each={names()}>
                    {(n) => (
                      <div role="option" class="ot-dlg-suggestion" onMouseDown={(e) => e.preventDefault()} onClick={() => { setName(n); setListOpen(false); input.focus(); }}>
                        {n}
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
            <div class="trd-preset-params-title">Order parameters</div>
            <PresetDescription preset={props.preset} bullets info />
          </div>
          <div class="ot-dlg-footer">
            <button type="button" class="ot-dlg-btn is-secondary" onClick={() => props.onClose()}>Cancel</button>
            <button type="button" class="ot-dlg-btn is-main is-neutral" data-name="submit-button" disabled={!name().trim()} aria-disabled={!name().trim()} onClick={save}>
              Save
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
