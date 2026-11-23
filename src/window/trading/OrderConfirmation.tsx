/*
 * The order ticket's confirmation page (#139), as in the reference: a broker that previews orders shows the order, the
 * quotes and what the broker says of it (commission, margin…) before Send Order.
 */
import { For, Show } from "solid-js";
import { ORDER_LABEL } from "../../data/trading/types";
import { fmtPrice, fmtQty, tickerOf } from "./format";
import type { TicketModel } from "./ticket-model";

/** A label / value row; `currency` in small letters after the value. */
function InfoRow(p: { title: string; value: string; currency?: string; side?: "buy" | "sell"; noTranslate?: boolean }) {
  return (
    <div class="trd-tk-info-row">
      <span class="trd-tk-info-title" data-no-translate={p.noTranslate ? "" : undefined}>
        {p.title}
      </span>
      <span class="trd-tk-info-value ot-value" classList={{ "is-buy": p.side === "buy", "is-sell": p.side === "sell" }} data-no-translate={p.noTranslate ? "" : undefined}>
        {p.value}
        <Show when={p.currency}>
          <small data-no-translate> {p.currency}</small>
        </Show>
      </span>
    </div>
  );
}

/** The confirmation page: warnings and errors, the quotes, the order, the broker's own tables; Send Order / Cancel. */
export function OrderConfirmation(props: { m: TicketModel }) {
  const m = props.m;
  const p = () => m.preview()!;
  const req = () => p().req;
  const px = (v: number | null) => fmtPrice(v, m.tick());
  /** The broker's money figures leave the take profit / stop loss out (reference). */
  const withExits = () => req().takeProfit !== null || req().stopLoss !== null || !!req().exitLevels?.length;
  const errors = () => p().data?.errors ?? [];
  return (
    <>
      <div class="trd-tk-scroll trd-tk-confirm">
        <Show when={!p().data}>
          <div class="trd-tk-confirm-loading">
            {/* The app's small spinner (app-settings.css). */}
            <svg class="update-app-spinner" width="24" height="24" viewBox="0 0 24 24" role="progressbar" aria-label="Loading">
              <circle class="update-app-spinner-bg" cx="12" cy="12" r="11" />
              <circle class="update-app-spinner-fg" cx="12" cy="12" r="11" />
            </svg>
          </div>
        </Show>
        <Show when={p().data}>
          <For each={errors()}>
            {(e) => (
              <div class="trd-tk-informer is-danger" role="alert" data-no-translate>
                {e}
              </div>
            )}
          </For>
          <Show when={withExits()}>
            <div class="trd-tk-informer is-warning">Estimated money impact is for main order only.</div>
          </Show>
          <For each={p().data?.warnings ?? []}>
            {(w) => (
              <div class="trd-tk-informer is-warning" data-no-translate>
                {w}
              </div>
            )}
          </For>
          <div class="trd-tk-info-table">
            <InfoRow title="Symbol" value={tickerOf(req().symbol)} noTranslate />
            <InfoRow title="Ask" value={px(m.q()?.ask ?? null)} />
            <InfoRow title="Bid" value={px(m.q()?.bid ?? null)} />
            <Show when={m.q()?.last != null}>
              <InfoRow title="Last" value={px(m.q()?.last ?? null)} />
            </Show>
          </div>
          <div class="trd-tk-info-table">
            <InfoRow title="Type" value={ORDER_LABEL[req().type]} />
            <InfoRow title="Side" value={req().side === "buy" ? "Buy" : "Sell"} side={req().side} />
            <InfoRow title="Quantity" value={fmtQty(req().qty)} />
            <Show when={req().type === "limit" || req().type === "stop"}>
              <InfoRow title="Price" value={px(req().type === "stop" ? req().stopPrice : req().limitPrice)} />
            </Show>
            <Show when={req().type === "stopLimit"}>
              <InfoRow title="Stop price" value={px(req().stopPrice)} />
              <InfoRow title="Limit price" value={px(req().limitPrice)} />
            </Show>
            <Show when={req().stopLoss !== null}>
              <InfoRow title="Stop Loss" value={px(req().stopLoss)} />
            </Show>
            <Show when={req().takeProfit !== null}>
              <InfoRow title="Take Profit" value={px(req().takeProfit)} />
            </Show>
          </div>
          {/* The broker's own tables, in its words. */}
          <For each={p().data?.sections ?? []}>
            {(s) => (
              <div class="trd-tk-info-table">
                <Show when={s.title}>
                  <div class="trd-tk-info-head" data-no-translate>
                    {s.title}
                  </div>
                </Show>
                <For each={s.rows ?? []}>{(r) => <InfoRow title={r.label ?? ""} value={r.value ?? ""} currency={r.currency ?? undefined} noTranslate />}</For>
              </div>
            )}
          </For>
        </Show>
      </div>
      <div class="trd-tk-footer">
        <div class="trd-tk-edit-btns">
          <button
            type="button"
            class="trd-tk-place"
            classList={{ "is-buy": req().side === "buy", "is-sell": req().side === "sell" }}
            disabled={!p().data || errors().length > 0}
            onClick={() => m.sendPreviewed()}
          >
            <span class="trd-tk-place-title">Send Order</span>
          </button>
          <button type="button" class="trd-tk-discard" onClick={() => m.closePreview()}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
