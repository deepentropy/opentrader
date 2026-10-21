/*
 * Order ticket: the order panel docked at the right of the charts, trading
 * through the replay broker (paper trading in Bar Replay).
 *
 * Header (broker mark, ticker, close), Sell (bid) | Buy (ask) with the spread
 * between, Market | Limit | Stop | Stop Limit, prices (distance to the market
 * in ticks), units (money at risk), tick value, Exits (take profit / stop
 * loss, 75 / 25 ticks from the entry by default, risk / reward), and the place
 * button ("Buy" over "1 QQQ MARKET"). Once an order is sent the button reads
 * "Start creating order" until the form is used again. On a working order
 * (reference app): "QQQ, order 3" over "Buy Limit 1 @ 690.00", no side or type
 * choice, Confirm (grey until something changed, then the side colour) over
 * Discard. "Protect position" (position line menu) opens it on the position:
 * "Long 1 @ 644.33", its take profit / stop loss, the trade and tick values,
 * Confirm / Discard. ArrowUp / ArrowDown step a price by the symbol's tick.
 * Off replay (or before a start point) the form gives way to "Launch replay
 * to start".
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { replayBroker } from "../../data/trading/replay-broker";
import { tradingUi, type TicketDraft } from "../../data/trading/trading-ui";
import type { OrderType } from "../../data/trading/types";
import { replayActivePane, replayStartSeq } from "../../data/replay";
import { fmtPrice, parsePositive, tickDecimals, tickerOf } from "./format";
import { buildTicket, describeTicket, exitPrice, exitTicks, marketHint, quotePrice as quoteOf, riskReward, riskValue } from "./ticket";
import { ChevronIcon, CloseIcon } from "./icons";
import { orderSummary, positionSummary } from "../chart/trading-lines-model";
import { POSITION_EDIT } from "../../data/trading/trading-ui";

const TYPES: [OrderType, string][] = [
  ["market", "Market"],
  ["limit", "Limit"],
  ["stop", "Stop"],
  ["stopLimit", "Stop Limit"],
];

export function OrderTicket() {
  return (
    <Show when={tradingUi.ticketOpen() && tradingUi.draft()}>
      <TicketBody />
    </Show>
  );
}

function TicketBody() {
  const d = () => tradingUi.draft()!;
  const q = replayBroker.quote;
  const tick = () => q()?.minTick ?? 0.01;
  const dec = () => Math.max(2, tickDecimals(tick()) ?? 2);
  const ccy = () => replayBroker.currency();
  const state = replayBroker.tradability;
  /** The ticket edits the brackets of the position (Protect position). */
  const isPos = () => tradingUi.draft()?.editing === POSITION_EDIT;
  const editing = createMemo(() => {
    const x = tradingUi.draft();
    if (!x?.editing || x.paneId === null || isPos()) return null;
    return replayBroker.orders(x.paneId).find((o) => o.id === x.editing) ?? null;
  });
  const editingPos = createMemo(() => {
    const x = tradingUi.draft();
    return x && isPos() && x.paneId !== null ? replayBroker.position(x.paneId) : null;
  });
  const [errorText, setErrorText] = createSignal<string | null>(null);

  // The ticket follows the focused chart; a new chart or start point starts
  // a new order (the button waits for the user: "Start creating order").
  createEffect(
    on([replayActivePane, replayStartSeq, () => replayBroker.symbol()], () => {
      const x = tradingUi.draft();
      const sym = replayBroker.symbol();
      if (!x || x.editing || !sym || sym === x.symbol) return;
      tradingUi.setDraft({ ...x, symbol: sym, limitPrice: "", stopPrice: "", takeProfit: "", stopLoss: "", tpOn: false, slOn: false });
      tradingUi.setSent(true);
    }, { defer: false }),
  );

  // The modified order ended (filled / cancelled): back to a new order.
  createEffect(() => {
    const x = tradingUi.draft();
    if (x?.editing && !(isPos() ? editingPos() : editing())) tradingUi.setDraft({ ...x, editing: null, paneId: null });
  });

  const patch = (p: Partial<TicketDraft>) => {
    tradingUi.patchDraft(p);
    setErrorText(null);
  };

  const quotePrice = (side: "buy" | "sell") => quoteOf(q(), side);
  const spread = () => {
    const b = q()?.bid;
    const a = q()?.ask;
    return b != null && a != null ? (a - b).toFixed(dec()) : null;
  };

  const setType = (t: OrderType) => {
    const x = d();
    const ref = quotePrice(x.side);
    const px = ref != null ? ref.toFixed(dec()) : "";
    patch({
      orderType: t,
      limitPrice: (t === "limit" || t === "stopLimit") && !x.limitPrice ? px : x.limitPrice,
      stopPrice: (t === "stop" || t === "stopLimit") && !x.stopPrice ? px : x.stopPrice,
    });
  };

  /** The exit price shown: the typed one, or the default while off. */
  const exitValue = (kind: "tp" | "sl") => {
    const x = d();
    if (kind === "tp" ? x.tpOn : x.slOn) return kind === "tp" ? x.takeProfit : x.stopLoss;
    return exitPrice(x, q(), kind, tick(), dec());
  };
  const setExit = (kind: "tp" | "sl", on: boolean) => {
    const v = exitPrice(d(), q(), kind, tick(), dec());
    if (kind === "tp") patch({ tpOn: on, takeProfit: on ? d().takeProfit || v : "" });
    else patch({ slOn: on, stopLoss: on ? d().stopLoss || v : "" });
  };

  const stepKey = (e: KeyboardEvent, key: keyof TicketDraft) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cur = parsePositive(String(d()[key])) ?? quotePrice(d().side) ?? 0;
    const next = Math.max(tick(), cur + (e.key === "ArrowUp" ? tick() : -tick()));
    patch({ [key]: next.toFixed(dec()) } as Partial<TicketDraft>);
  };

  function submit() {
    if (tradingUi.sent()) {
      tradingUi.setSent(false);
      return;
    }
    const t = buildTicket(d(), q());
    if (typeof t === "string") {
      setErrorText(t);
      return;
    }
    const x = d();
    if (isPos()) {
      replayBroker.setPositionBrackets(t.takeProfit, t.stopLoss, x.paneId ?? undefined);
      tradingUi.setDraft({ ...x, editing: null, paneId: null });
      tradingUi.setSent(true);
      return;
    }
    if (x.editing) {
      replayBroker.modify(x.editing, t, x.paneId ?? undefined);
      tradingUi.setDraft({ ...x, editing: null, paneId: null });
      tradingUi.setSent(true);
      return;
    }
    if (replayBroker.place(t) === null && !state().ok) return;
    tradingUi.savePrefs(x);
    tradingUi.setSent(true);
  }

  /** The modified order differs from the working one. */
  const changed = createMemo(() => {
    const o = editing();
    const t = buildTicket(d(), q());
    const pos = editingPos();
    if (pos && typeof t !== "string") return t.takeProfit !== pos.takeProfit || t.stopLoss !== pos.stopLoss;
    if (!o || typeof t === "string") return false;
    return t.qty !== o.qty || t.limitPrice !== o.limitPrice || t.stopPrice !== o.stopPrice || t.takeProfit !== o.takeProfit || t.stopLoss !== o.stopLoss;
  });

  const risk = () => riskValue(d(), q());
  const rr = () => riskReward(d(), q());

  // Resize from the left edge.
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
  onCleanup(() => (document.body.style.cursor = ""));

  const priceInput = (label: string, key: "limitPrice" | "stopPrice", hint: () => string) => (
    <label class="trd-tk-field">
      <span class="trd-tk-label">{label}</span>
      <span class="trd-tk-box">
        <input
          class="trd-tk-input"
          inputmode="decimal"
          value={String(d()[key])}
          onInput={(e) => patch({ [key]: e.currentTarget.value } as Partial<TicketDraft>)}
          onKeyDown={(e) => {
            stepKey(e, key);
            if (e.key === "Enter") submit();
          }}
        />
        <span class="trd-tk-hint">{hint()}</span>
      </span>
    </label>
  );

  const exitInput = (kind: "tp" | "sl") => {
    const on = () => (kind === "tp" ? d().tpOn : d().slOn);
    const key = kind === "tp" ? "takeProfit" : "stopLoss";
    const ticks = () => exitTicks(d(), q(), exitValue(kind), tick());
    return (
      <div class="trd-tk-exit" classList={{ "is-disabled": !on() }}>
        <div class="trd-tk-exit-head">
          <span class="trd-tk-label">{kind === "tp" ? "Take profit price" : "Stop loss price"}</span>
          <ToggleSwitch on={on()} label={kind === "tp" ? "Take profit" : "Stop loss"} onChange={(v) => setExit(kind, v)} />
        </div>
        <span class="trd-tk-box">
          <input
            class="trd-tk-input"
            inputmode="decimal"
            disabled={!on()}
            value={exitValue(kind)}
            onInput={(e) => patch({ [key]: e.currentTarget.value } as Partial<TicketDraft>)}
            onKeyDown={(e) => {
              stepKey(e, key);
              if (e.key === "Enter") submit();
            }}
          />
          <span class="trd-tk-hint">{ticks() != null ? `${ticks()} ticks` : ""}</span>
        </span>
      </div>
    );
  };

  return (
    <aside class="trd-ticket" style={{ width: `${tradingUi.ticketWidth()}px` }} aria-label="Order panel" data-name="order-panel">
      <div class="trd-ticket-resize" onMouseDown={beginResize} />
      <div class="trd-tk-header">
        <Tooltip text="Replay Broker" side="bottom">
          <span class="trd-tk-mark">
            <Icon name="replay-status" size={18} />
          </span>
        </Tooltip>
        <span class="trd-tk-title">
          {tickerOf(d().symbol)}
          {d().editing && !isPos() ? `, order ${d().editing}` : ""}
        </span>
        <span class="trd-tk-spacer" />
        <Tooltip text="Close" side="bottom">
          <button type="button" class="trd-icon-btn" aria-label="Close" onClick={() => tradingUi.closeTicket()}>
            <CloseIcon />
          </button>
        </Tooltip>
      </div>
      <Show when={editing()}>{(o) => <div class="trd-tk-sub">{orderSummary(o(), tick())}</div>}</Show>
      <Show when={editingPos()}>{(pos) => <div class="trd-tk-sub">{positionSummary(pos(), tick())}</div>}</Show>

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
            <Show when={d().orderType === "limit"}>{priceInput("Price", "limitPrice", () => marketHint(d(), q(), d().limitPrice, tick()))}</Show>
            <Show when={d().orderType === "stop"}>{priceInput("Stop price", "stopPrice", () => marketHint(d(), q(), d().stopPrice, tick()))}</Show>
            <Show when={d().orderType === "stopLimit"}>
              {priceInput("Stop price", "stopPrice", () => marketHint(d(), q(), d().stopPrice, tick()))}
              {priceInput("Limit price", "limitPrice", () => marketHint(d(), q(), d().limitPrice, tick()))}
            </Show>
            <label class="trd-tk-field">
              <span class="trd-tk-label">Units</span>
              <span class="trd-tk-box">
                <input
                  class="trd-tk-input"
                  inputmode="decimal"
                  value={d().qty}
                  onInput={(e) => patch({ qty: e.currentTarget.value })}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                      e.preventDefault();
                      const v = parsePositive(d().qty) ?? 0;
                      patch({ qty: String(Math.max(1, Math.round(v) + (e.key === "ArrowUp" ? 1 : -1))) });
                    }
                    if (e.key === "Enter") submit();
                  }}
                />
                <span class="trd-tk-hint">
                  {risk() != null ? `${risk()!.toFixed(2)} ` : "⌀ "}
                  <small>{ccy()} risk</small>
                </span>
              </span>
            </label>
            <div class="trd-tk-row">
              <span>Tick value</span>
              <span class="trd-tk-row-value">
                {((parsePositive(d().qty) ?? 0) * tick()).toFixed(dec())}
                <small> {ccy()}</small>
              </span>
            </div>
          </div>

          </Show>

          <ExitsSection>
            {exitInput("tp")}
            {exitInput("sl")}
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
                  <span class="trd-tk-place-sub">{describeTicket(d(), dec())}</span>
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
    </aside>
  );
}

function ExitsSection(props: { children: JSX.Element }) {
  const [open, setOpen] = createSignal(true);
  return (
    <div class="trd-tk-section">
      <button type="button" class="trd-tk-section-head" onClick={() => setOpen(!open())} aria-expanded={open()}>
        Exits <ChevronIcon open={open()} />
      </button>
      <Show when={open()}>{props.children}</Show>
    </div>
  );
}

function ToggleSwitch(p: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={p.on}
      aria-label={p.label}
      class="trd-switch"
      classList={{ "is-on": p.on }}
      onClick={() => p.onChange(!p.on)}
    >
      <span class="trd-switch-knob" />
    </button>
  );
}
