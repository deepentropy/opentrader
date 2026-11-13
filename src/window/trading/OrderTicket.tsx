/*
 * Order ticket: the order panel docked at the right of the charts, trading
 * through the replay broker (paper trading in Bar Replay).
 *
 * Header (broker mark, ticker, close), Sell (bid) | Buy (ask) with the spread
 * between, Market | Limit | Stop | Stop Limit, prices (distance to the market
 * in ticks), units (money at risk), tick value, Exits (take profit / stop
 * loss, 75 / 25 ticks from the entry by default, risk / reward), and the place
 * button ("Buy" over "1 QQQ MARKET"). Each field is typed in the type of its
 * label menu (a price or an offset in ticks; units or the money / % balance
 * at risk to the stop loss; exits as a price, ticks, % price, money or %
 * balance), its equivalent on the right (a drop-down picks its type) and ⇄
 * swaps the two. Header: order presets, ⋯ (Trading settings…, "SL enables
 * quantity in risk": turning the stop loss on sizes the order by risk). Once an order is sent the button reads
 * "Start creating order" until the form is used again. On a working order
 * (reference app): "QQQ, order 3" over "Buy Limit 1 @ 690.00", no side or type
 * choice, Confirm (grey until something changed, then the side colour) over
 * Discard. "Protect position" (position line menu) opens it on the position:
 * "Long 1 @ 644.33", its take profit / stop loss, the trade and tick values,
 * Confirm / Discard. ArrowUp / ArrowDown step a price by the symbol's tick.
 * Off replay (or before a start point) the form gives way to "Launch replay
 * to start".
 *
 * Its state and actions are ticket-model.ts, the fields TicketFields.tsx, the ⋯ menu TicketSettingsMenu.tsx.
 */
import { For, Show, createSignal, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { broker, brokerOf } from "../../data/trading/broker";
import { pluginBroker } from "../../data/trading/plugin-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import type { OrderType } from "../../data/trading/types";
import { fmtPrice, tickerOf } from "./format";
import { describeTicket } from "./ticket";
import { createTicketModel } from "./ticket-model";
import { ExitInput, PriceInput, QtyInput } from "./TicketFields";
import { ExitsSection, FieldTip, TicketSettingsMenu } from "./TicketSettingsMenu";
import { CloseIcon } from "./icons";
import { FavoritePresets, OrderPresetsButton } from "./OrderPresets";
import { DomPanel } from "./DomPanel";
import { orderSummary, positionSummary } from "../chart/trading-lines-model";
import { translateAs, translateWith } from "../../i18n/translator";

/** Order / DOM switch: tab, title, tooltip and its Shift hotkey. */
const TABS: ["order" | "dom", string, string, string][] = [
  ["order", "Order", "Order ticket", "T"],
  ["dom", "DOM", "DOM", "D"],
];

const TYPES: [OrderType, string][] = [
  ["market", "Market"],
  ["limit", "Limit"],
  ["stop", "Stop"],
  ["stopLimit", "Stop Limit"],
];

/** Docked: the order form (Order tab) or the DOM (DOM tab) at the right of
 *  the charts. Undocked ("Undock order ticket"), or an order of the docked
 *  DOM with one-click trading off: the form in a floating dialog. */
export function OrderTicket() {
  const docked = () => tradingUi.ticketMode() === "panel";
  const dom = () => docked() && tradingUi.ticketTab() === "dom";
  const floating = () => !docked() || tradingUi.orderDialog();
  return (
    <Show when={tradingUi.ticketOpen()}>
      <Show when={dom()}>
        <DomShell />
      </Show>
      <Show when={tradingUi.draft() && (floating() || !dom())}>
        <TicketBody floating={floating()} />
      </Show>
    </Show>
  );
}

/** Ticket header: broker mark, `title`, `extra` buttons, ⋯ and close. A
 *  floating ticket is dragged by it. */
function TicketHead(p: { title: JSX.Element; extra?: JSX.Element; onClose: () => void; onDrag?: (e: MouseEvent) => void }) {
  return (
    <div
      class="trd-tk-header"
      classList={{ "is-draggable": !!p.onDrag }}
      onMouseDown={(e) => {
        if (p.onDrag && !(e.target as HTMLElement).closest("button")) p.onDrag(e);
      }}
    >
      <Show
        when={brokerOf() === pluginBroker && pluginBroker.status()?.activeName}
        fallback={
          <Tooltip text="Replay Broker" side="bottom">
            <span class="trd-tk-mark">
              <Icon name="replay-status" size={18} />
            </span>
          </Tooltip>
        }
      >
        {(name) => (
          <span class="trd-tk-mark trd-broker-mark" title={name()} data-no-translate>
            {name()
              .split(/\s+/)
              .slice(0, 2)
              .map((w) => w[0]?.toUpperCase() ?? "")
              .join("")}
          </span>
        )}
      </Show>
      <span class="trd-tk-title">{p.title}</span>
      <span class="trd-tk-spacer" />
      <span class="trd-tk-head-btns">
        {p.extra}
        <TicketSettingsMenu />
        <Tooltip text={translateAs("Close", "action")} side="bottom">
          <button type="button" class="trd-icon-btn" aria-label="Close" onClick={() => p.onClose()}>
            <CloseIcon />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}

/** Order / DOM switch of the docked ticket. */
function TicketTabs() {
  return (
    <div class="trd-tk-tabs" role="tablist">
      <For each={TABS}>
        {([t, title, tip, key]) => (
          <Tooltip text={tip} hotkey={`Shift+${key}`} hotkeyText="{0} {1}" side="bottom">
            <button
              type="button"
              role="tab"
              class="trd-tk-tab"
              classList={{ "is-selected": tradingUi.ticketTab() === t }}
              aria-selected={tradingUi.ticketTab() === t}
              onClick={() => tradingUi.setTicketTab(t)}
            >
              {title}
            </button>
          </Tooltip>
        )}
      </For>
    </div>
  );
}

const DOM_MIN_WIDTH = 314;

/** Left-edge resize of the docked ticket. */
function beginResize(e: MouseEvent) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = tradingUi.ticketWidth();
  const next = (ev: MouseEvent) => startW + (startX - ev.clientX);
  const onMove = (ev: MouseEvent) => tradingUi.setTicketWidth(next(ev), false);
  const onUp = (ev: MouseEvent) => {
    tradingUi.setTicketWidth(next(ev), true);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
  };
  document.body.style.cursor = "ew-resize";
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/** The docked ticket on its DOM tab. */
function DomShell() {
  const state = broker.tradability;
  onCleanup(() => (document.body.style.cursor = ""));
  // The ladder's five columns need 314 px (reference app).
  return (
    <aside class="trd-ticket" style={{ width: `${Math.max(DOM_MIN_WIDTH, tradingUi.ticketWidth())}px` }} aria-label="Order panel" data-name="order-panel">
      <div class="trd-ticket-resize" onMouseDown={beginResize} />
      <TicketHead title={tickerOf(broker.symbol() || tradingUi.activeSymbol())} onClose={() => tradingUi.closeTicket()} />
      <TicketTabs />
      <Show
        when={state().ok || state().reason === "loading"}
        fallback={
          <div class="trd-tk-empty">
            <Show when={state().title}>
              <div class="trd-tk-empty-title">{state().title}</div>
            </Show>
            <div class="trd-tk-empty-text">{state().text}</div>
          </div>
        }
      >
        <DomPanel />
      </Show>
    </aside>
  );
}

function TicketBody(props: { floating: boolean }) {
  const m = createTicketModel();
  const { d, q, tick, dec, ccy, state, r, isPos, editing, editingPos, errorText, qtyTip, setQtyTip, slTip, setSlTip } = m;
  const { patch, spread, setType, qtyNum, submit, changed, rr, currentPreset, applyPreset, presetApplied } = m;

  // Floating: centred until dragged by the header (kept inside the window).
  const [size, setSize] = createSignal({ w: 414, h: 640 });
  const pos = () => {
    const p = tradingUi.floatPos();
    const { w, h } = size();
    const x = p ? p.x : (window.innerWidth - w) / 2;
    const y = p ? p.y : (window.innerHeight - h) / 2;
    return { x: Math.max(0, Math.min(x, window.innerWidth - w)), y: Math.max(0, Math.min(y, window.innerHeight - h)) };
  };
  const beginDrag = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = pos();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const onMove = (ev: MouseEvent) => tradingUi.setFloatPos({ x: start.x + ev.clientX - x0, y: start.y + ev.clientY - y0 });
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const close = () => (tradingUi.orderDialog() ? tradingUi.closeOrderDialog() : tradingUi.closeTicket());

  const content = (
    <>
      <TicketHead
        title={
          <>
            {tickerOf(d().symbol)}
            {d().editing && !isPos() ? translateWith(", order {0}", d().editing ?? "") : ""}
          </>
        }
        extra={
          <Show when={state().ok && !d().editing}>
            <OrderPresetsButton current={currentPreset} apply={applyPreset} />
          </Show>
        }
        onClose={close}
        onDrag={props.floating ? beginDrag : undefined}
      />
      <Show when={editing()}>{(o) => <div class="trd-tk-sub">{orderSummary(o(), tick())}</div>}</Show>
      <Show when={editingPos()}>{(pos) => <div class="trd-tk-sub">{positionSummary(pos(), tick())}</div>}</Show>

      <Show when={!d().editing && !props.floating}>
        <TicketTabs />
      </Show>

      <Show
        when={state().ok || state().reason === "loading"}
        fallback={
          <div class="trd-tk-empty">
            <Show when={state().title}>
              <div class="trd-tk-empty-title">{state().title}</div>
            </Show>
            <div class="trd-tk-empty-text">{state().text}</div>
          </div>
        }
      >
        <div class="trd-tk-scroll">
          <Show when={!d().editing}>
          <FavoritePresets applied={presetApplied} apply={applyPreset} />
          <div class="trd-tk-sides">
            <button
              type="button"
              class="trd-tk-side is-sell"
              classList={{ "is-selected": d().side === "sell" }}
              disabled={!!d().editing}
              onClick={() => patch({ side: "sell" })}
            >
              <span class="trd-tk-side-title">Sell</span>
              <span class="trd-tk-side-price">{q()?.bid != null ? fmtPrice(q()!.bid, tick()) : "No Data"}</span>
            </button>
            <button
              type="button"
              class="trd-tk-side is-buy"
              classList={{ "is-selected": d().side === "buy" }}
              disabled={!!d().editing}
              onClick={() => patch({ side: "buy" })}
            >
              <span class="trd-tk-side-title">Buy</span>
              <span class="trd-tk-side-price">{q()?.ask != null ? fmtPrice(q()!.ask, tick()) : "No Data"}</span>
            </button>
            <Show when={spread()}>
              <span class="trd-tk-spread">{spread()}</span>
            </Show>
          </div>

          <div class="trd-tk-types" role="tablist">
            <For each={TYPES}>
              {([t, title]) => (
                <button
                  type="button"
                  role="tab"
                  class="trd-tk-type"
                  classList={{ "is-selected": d().orderType === t }}
                  aria-selected={d().orderType === t}
                  disabled={!!d().editing && d().orderType !== t}
                  onClick={() => setType(t)}
                >
                  {title}
                </button>
              )}
            </For>
          </div>
          </Show>

          <Show when={!isPos()}>
          <div class="trd-tk-inputs" classList={{ "is-editing": !!d().editing }}>
            <Show when={d().orderType === "limit"}><PriceInput m={m} f="limitPrice" /></Show>
            <Show when={d().orderType === "stop"}><PriceInput m={m} f="stopPrice" /></Show>
            <Show when={d().orderType === "stopLimit"}>
              <PriceInput m={m} f="stopPrice" />
              <PriceInput m={m} f="limitPrice" />
            </Show>
            <QtyInput m={m} />
            <div class="trd-tk-row">
              <span>Tick value</span>
              <span class="trd-tk-row-value">
                {((qtyNum() ?? 0) * tick()).toFixed(dec())}
                <small> {ccy()}</small>
              </span>
            </div>
          </div>

          </Show>

          <ExitsSection>
            <ExitInput m={m} kind="tp" />
            <ExitInput m={m} kind="sl" />
            <Show when={rr()}>
              {(v) => (
                <div class="trd-tk-row">
                  <span>Risk / Reward</span>
                  <span class="trd-tk-row-value">{Number(v().toFixed(2))}</span>
                </div>
              )}
            </Show>
          </ExitsSection>
          <Show when={editingPos()}>
            {(pos) => (
              <div class="trd-tk-values">
                <div class="trd-tk-row">
                  <span>Trade value</span>
                  <span class="trd-tk-row-value">
                    {(pos().qty * pos().avgPrice).toFixed(dec())}
                    <small> {ccy()}</small>
                  </span>
                </div>
                <div class="trd-tk-row">
                  <span>Tick value</span>
                  <span class="trd-tk-row-value">
                    {(pos().qty * tick()).toFixed(dec())}
                    <small> {ccy()}</small>
                  </span>
                </div>
              </div>
            )}
          </Show>
        </div>

        <div class="trd-tk-footer">
          <Show when={errorText()}>
            <div class="trd-tk-error" role="alert">{errorText()}</div>
          </Show>
          <Show
            when={d().editing}
            fallback={
              <button
                type="button"
                class="trd-tk-place"
                classList={{ "is-buy": !tradingUi.sent() && d().side === "buy", "is-sell": !tradingUi.sent() && d().side === "sell", "is-idle": tradingUi.sent() }}
                disabled={!state().ok}
                onClick={submit}
              >
                <Show when={!tradingUi.sent()} fallback={<span class="trd-tk-place-title">Start creating order</span>}>
                  <span class="trd-tk-place-title">{d().side === "buy" ? "Buy" : "Sell"}</span>
                  <span class="trd-tk-place-sub">{describeTicket(r(), dec())}</span>
                </Show>
              </button>
            }
          >
            <div class="trd-tk-edit-btns">
              <button
                type="button"
                class="trd-tk-place"
                classList={{ "is-buy": changed() && d().side === "buy", "is-sell": changed() && d().side === "sell", "is-idle": !changed() }}
                disabled={!state().ok}
                onClick={() => changed() && submit()}
              >
                <span class="trd-tk-place-title">Confirm</span>
              </button>
              <button type="button" class="trd-tk-discard" onClick={() => tradingUi.setDraft({ ...d(), editing: null, paneId: null })}>
                Discard
              </button>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={qtyTip()}>{(t) => <FieldTip anchor={m.boxes.qty} text={t()} onClose={() => setQtyTip(null)} />}</Show>
      <Show when={slTip()}>{(t) => <FieldTip anchor={m.boxes.sl} text={t()} onClose={() => setSlTip(null)} />}</Show>
    </>
  );
  return (
    <Show
      when={props.floating}
      fallback={
        <aside class="trd-ticket" style={{ width: `${tradingUi.ticketWidth()}px` }} aria-label="Order panel" data-name="order-panel">
          <div class="trd-ticket-resize" onMouseDown={beginResize} />
          {content}
        </aside>
      }
    >
      <Portal>
        <div
          ref={(el) => {
            const ro = new ResizeObserver(() => setSize({ w: el.offsetWidth, h: el.offsetHeight }));
            ro.observe(el);
            onCleanup(() => ro.disconnect());
          }}
          class="trd-ticket is-floating"
          style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
          role="dialog"
          aria-label="Order panel"
          data-name="order-panel"
        >
          {content}
        </div>
      </Portal>
    </Show>
  );
}
