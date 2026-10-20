/*
 * Order ticket: the order panel docked at the right of the charts
 * (.tmp/trading-panel/DESIGN.md §4).
 *
 * Header (broker mark, symbol, delayed badge, close), Sell (bid) | Buy (ask)
 * with the spread between, Market | Limit | Stop | Stop Limit, prices,
 * quantity, Exits (take profit / stop loss, new orders only), Extra settings
 * (time in force, outside regular hours), Order info, and the place button
 * ("Buy" over "1 AAPL @ 123.45 LIMIT"). On a working order: Confirm / Discard.
 * ArrowUp / ArrowDown step a price by the symbol's tick.
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { OrderType } from "../../bindings";
import { Tooltip } from "../../components/Tooltip";
import { broker } from "../../data/broker-store";
import { tradingUi, type TicketDraft } from "../../data/trading-ui";
import { fmtMoney, fmtPrice, parsePositive, tickDecimals, tickerOf } from "./format";
import { buildTicket, describeTicket, entryPrice, exitPrice, quotePrice as quoteOf } from "./ticket";
import { ChevronIcon, CloseIcon, IbkrMark } from "./icons";
import { tradingNotice } from "./TradingPanel";

const TYPES: [OrderType, string][] = [
  ["market", "Market"],
  ["limit", "Limit"],
  ["stop", "Stop"],
  ["stopLimit", "Stop Limit"],
];

export function OrderTicket() {
  const [sent, setSent] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [exitsOpen, setExitsOpen] = createSignal(true);
  const [extraOpen, setExtraOpen] = createSignal(true);
  const d = () => tradingUi.draft()!;
  const q = broker.quote;
  const tick = () => q()?.minTick ?? 0.01;
  const dec = () => Math.max(2, tickDecimals(tick()) ?? 2);
  const editing = createMemo(() => {
    const id = d()?.editing;
    return id ? broker.state().orders.find((o) => o.id === id) ?? null : null;
  });

  // The quote of the ticket's symbol, while the ticket is open.
  createEffect(
    on(
      () => tradingUi.draft()?.symbol,
      (sym) => void broker.watchQuote(sym ?? null),
    ),
  );
  onCleanup(() => void broker.watchQuote(null));

  // The edited order ended (filled / cancelled elsewhere): close the ticket.
  createEffect(() => {
    const id = d()?.editing;
    if (!id) return;
    const o = broker.state().orders.find((x) => x.id === id);
    if (!o || !(o.status === "working" || o.status === "inactive" || o.status === "placing")) tradingUi.closeTicket();
  });

  const patch = (p: Partial<TicketDraft>) => {
    tradingUi.patchDraft(p);
    setError(null);
  };

  const quotePrice = (side: "buy" | "sell") => quoteOf(q(), side);
  const entry = (): number | null => entryPrice(d(), q());
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

  const setExit = (kind: "tp" | "sl", on: boolean) => {
    const x = d();
    const v = exitPrice(x, q(), kind, tick(), dec());
    if (kind === "tp") patch({ tpOn: on, takeProfit: on && !x.takeProfit ? v : x.takeProfit });
    else patch({ slOn: on, stopLoss: on && !x.stopLoss ? v : x.stopLoss });
  };

  const stepKey = (e: KeyboardEvent, key: keyof TicketDraft) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cur = parsePositive(String(d()[key])) ?? quotePrice(d().side) ?? 0;
    const next = Math.max(tick(), cur + (e.key === "ArrowUp" ? tick() : -tick()));
    patch({ [key]: next.toFixed(dec()) } as Partial<TicketDraft>);
  };

  const describe = () => describeTicket(d(), dec());

  async function submit() {
    const t = buildTicket(d(), q());
    if (typeof t === "string") {
      setError(t);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const x = d();
      if (x.editing) {
        await broker.modifyOrder(x.editing, t);
        tradingUi.closeTicket();
      } else {
        await broker.placeOrder(t);
        tradingUi.savePrefs(x);
        setSent(true);
        setTimeout(() => setSent(false), 1000);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      tradingNotice(msg);
    } finally {
      setBusy(false);
    }
  }

  const value = () => {
    const qty = parsePositive(d().qty);
    const e = entry();
    return qty != null && e != null ? qty * e : null;
  };
  const rr = () => {
    const x = d();
    const e = entry();
    const tp = parsePositive(x.takeProfit);
    const sl = parsePositive(x.stopLoss);
    if (!x.tpOn || !x.slOn || e == null || tp == null || sl == null || sl === e) return null;
    return Math.abs(tp - e) / Math.abs(e - sl);
  };

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

  const priceInput = (label: string, key: "limitPrice" | "stopPrice" | "takeProfit" | "stopLoss", disabled = false) => (
    <label class="trd-tk-field" classList={{ "is-disabled": disabled }}>
      <span class="trd-tk-label">{label}</span>
      <input
        class="trd-tk-input"
        inputmode="decimal"
        disabled={disabled}
        value={String(d()[key])}
        onInput={(e) => patch({ [key]: e.currentTarget.value } as Partial<TicketDraft>)}
        onKeyDown={(e) => {
          stepKey(e, key);
          if (e.key === "Enter") void submit();
        }}
      />
    </label>
  );

  return (
    <Show when={tradingUi.draft()}>
      <aside class="trd-ticket" style={{ width: `${tradingUi.ticketWidth()}px` }} aria-label="Order panel" data-name="order-panel">
        <div class="trd-ticket-resize" onMouseDown={beginResize} />
        <div class="trd-tk-header">
          <Tooltip text="Interactive Brokers" side="bottom">
            <span class="trd-tk-mark"><IbkrMark size={24} radius={4} /></span>
          </Tooltip>
          <span class="trd-tk-title">
            {tickerOf(d().symbol)}
            <Show when={editing()}>{(o) => `, order ${o().orderId}`}</Show>
          </span>
          <Show when={q()?.delayed}>
            <Tooltip text="Quotes are delayed: the account has no real-time data for this symbol" side="bottom">
              <span class="trd-tk-delayed">D</span>
            </Tooltip>
          </Show>
          <span class="trd-tk-spacer" />
          <Tooltip text="Close" side="bottom">
            <button type="button" class="trd-icon-btn" aria-label="Close" onClick={() => tradingUi.closeTicket()}>
              <CloseIcon />
            </button>
          </Tooltip>
        </div>

        <div class="trd-tk-scroll">
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

          <div class="trd-tk-inputs">
            <Show when={d().orderType === "limit"}>{priceInput("Price", "limitPrice")}</Show>
            <Show when={d().orderType === "stop"}>{priceInput("Stop price", "stopPrice")}</Show>
            <Show when={d().orderType === "stopLimit"}>
              {priceInput("Stop price", "stopPrice")}
              {priceInput("Limit price", "limitPrice")}
            </Show>
            <label class="trd-tk-field">
              <span class="trd-tk-label">Shares</span>
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
                  if (e.key === "Enter") void submit();
                }}
              />
            </label>
          </div>

          <Show when={!d().editing}>
            <div class="trd-tk-section">
              <button type="button" class="trd-tk-section-head" onClick={() => setExitsOpen(!exitsOpen())} aria-expanded={exitsOpen()}>
                Exits <ChevronIcon open={exitsOpen()} />
              </button>
              <Show when={exitsOpen()}>
                <div class="trd-tk-exit">
                  {priceInput("Take profit price", "takeProfit", !d().tpOn)}
                  <Switch on={d().tpOn} label="Take profit" onChange={(v) => setExit("tp", v)} />
                </div>
                <div class="trd-tk-exit">
                  {priceInput("Stop loss price", "stopLoss", !d().slOn)}
                  <Switch on={d().slOn} label="Stop loss" onChange={(v) => setExit("sl", v)} />
                </div>
                <Show when={rr()}>
                  {(v) => <div class="trd-tk-rr">Risk / Reward {v().toFixed(2)}</div>}
                </Show>
              </Show>
            </div>
          </Show>

          <div class="trd-tk-section">
            <button type="button" class="trd-tk-section-head" onClick={() => setExtraOpen(!extraOpen())} aria-expanded={extraOpen()}>
              Extra settings <ChevronIcon open={extraOpen()} />
            </button>
            <Show when={extraOpen()}>
              <div class="trd-tk-extra">
                <select
                  class="trd-tk-select"
                  aria-label="Time in force"
                  value={d().duration}
                  onChange={(e) => patch({ duration: e.currentTarget.value as TicketDraft["duration"] })}
                >
                  <option value="day">Day</option>
                  <option value="gtc">Good Till Cancel</option>
                </select>
                <label class="trd-tk-check">
                  <input type="checkbox" checked={d().outsideRth} onChange={(e) => patch({ outsideRth: e.currentTarget.checked })} />
                  <span>Outside RTH</span>
                </label>
              </div>
            </Show>
          </div>

          <div class="trd-tk-info">
            <div class="trd-tk-info-title">Order info</div>
            <div class="trd-tk-info-row">
              <span>Trade value</span>
              <span>{value() != null ? `${d().orderType === "market" ? "≈ " : ""}${fmtMoney(value())}` : "—"}</span>
            </div>
            <div class="trd-tk-info-row">
              <span>Tick value</span>
              <span>{fmtMoney((parsePositive(d().qty) ?? 0) * tick())}</span>
            </div>
          </div>
        </div>

        <div class="trd-tk-footer">
          <Show when={error()}>
            <div class="trd-tk-error" role="alert">{error()}</div>
          </Show>
          <Show
            when={d().editing}
            fallback={
              <button
                type="button"
                class="trd-tk-place"
                classList={{ "is-buy": d().side === "buy", "is-sell": d().side === "sell" }}
                disabled={busy()}
                onClick={() => void submit()}
              >
                <Show when={!sent()} fallback={<span class="trd-tk-place-title">Order sent</span>}>
                  <span class="trd-tk-place-title">{d().side === "buy" ? "Buy" : "Sell"}</span>
                  <span class="trd-tk-place-sub">{describe()}</span>
                </Show>
              </button>
            }
          >
            <div class="trd-tk-edit-btns">
              <button type="button" class="trd-tk-discard" onClick={() => tradingUi.closeTicket()}>
                Discard
              </button>
              <button
                type="button"
                class="trd-tk-place"
                classList={{ "is-buy": d().side === "buy", "is-sell": d().side === "sell" }}
                disabled={busy()}
                onClick={() => void submit()}
              >
                <span class="trd-tk-place-title">Confirm</span>
              </button>
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  );
}

function Switch(p: { on: boolean; label: string; onChange: (v: boolean) => void }) {
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
