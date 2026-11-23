/*
 * Exit levels of the order ticket (#330), as in the reference: under Exits, "Protected size", "Risk / Reward" and one
 * row per level ("Level 1  50.00%" over "TP 1 @ 263.13  SL 1 @ 262.13", a delete button), "Add level"; the "Exit
 * levels" page edits them (the level open: its quantity, take profit and stop loss), Confirm / Discard.
 */
import { For, Show } from "solid-js";
import { Tooltip } from "../../components/Tooltip";
import { localNumber } from "../../i18n/format";
import { translatePlural, translateWith } from "../../i18n/translator";
import { fmtPrice, fmtQty, parsePositive, tickerOf } from "./format";
import { levelsRiskReward, protectedPct, type DraftLevel } from "./exit-levels";
import { orderSummary, positionSummary } from "../chart/trading-lines-model";
import { CloseIcon } from "./icons";
import type { TicketModel } from "./ticket-model";

const pct = (v: number | null) => (v == null ? "—" : localNumber(`${v.toFixed(2)}%`));

/** "Protected size" and "Risk / Reward" of the levels. */
function LevelTotals(p: { m: TicketModel; list: DraftLevel[] }) {
  const rr = () => levelsRiskReward(p.list, p.m.entry());
  return (
    <div class="trd-tk-levels-totals">
      <div class="trd-tk-row">
        <span>Protected size</span>
        <span class="trd-tk-row-value ot-value">{pct(protectedPct(p.list, p.m.qtyNum()))}</span>
      </div>
      <Show when={rr()}>
        {(v) => (
          <div class="trd-tk-row">
            <span>Risk / Reward</span>
            <span class="trd-tk-row-value ot-value">{localNumber(String(Number(v().toFixed(2))))}</span>
          </div>
        )}
      </Show>
    </div>
  );
}

/** "Level 2  50.00%": a level's number and its share of the quantity. */
function LevelHead(p: { m: TicketModel; i: number; l: DraftLevel; children?: unknown }) {
  const share = () => {
    const q = parsePositive(p.l.qty);
    const n = p.m.qtyNum();
    return q != null && n ? (q / n) * 100 : null;
  };
  return (
    <div class="trd-tk-level-head">
      <span>{translateWith("Level {0}", p.i + 1)}</span>
      <span class="ot-value">{pct(share())}</span>
      <span class="trd-tk-spacer" />
      {p.children as never}
    </div>
  );
}

/** A level's exits as one button: "TP 1 @ 263.13  SL 1 @ 262.13" (TP in the take profit colour, SL in the stop's). */
function LevelButton(p: { m: TicketModel; i: number; l: DraftLevel; onOpen: () => void; onRemove: () => void }) {
  const px = (v: string) => fmtPrice(parsePositive(v), p.m.tick());
  const qty = () => fmtQty(parsePositive(p.l.qty));
  return (
    <div class="trd-tk-level">
      <button type="button" class="trd-tk-level-btn" onClick={() => p.onOpen()}>
        <span class="trd-tk-level-leg">
          <span class="is-tp">TP</span> <span class="ot-value">{qty()}</span> <span class="ot-value">@ {px(p.l.tp)}</span>
        </span>
        <span class="trd-tk-level-leg">
          <span class="is-sl">SL</span> <span class="ot-value">{qty()}</span> <span class="ot-value">@ {px(p.l.sl)}</span>
        </span>
      </button>
      <Tooltip text={translateWith("Remove level {0}", p.i + 1)} side="top">
        <button type="button" class="trd-icon-btn trd-tk-level-del" aria-label={translateWith("Remove level {0}", p.i + 1)} onClick={() => p.onRemove()}>
          <CloseIcon />
        </button>
      </Tooltip>
    </div>
  );
}

/** "Add level", greyed with its tip once the broker's most levels are there. */
export function AddLevelButton(p: { m: TicketModel }) {
  const button = (
    <button type="button" class="trd-tk-add-level" disabled={p.m.levelsFull()} onClick={() => p.m.addLevel()}>
      Add level
    </button>
  );
  return (
    <Show when={p.m.levelsFull()} fallback={button}>
      <Tooltip text="You’ve added the maximum number of exit levels" side="top">
        {button}
      </Tooltip>
    </Show>
  );
}

/** The ticket's levels under Exits. */
export function LevelList(p: { m: TicketModel; list: DraftLevel[] }) {
  return (
    <div class="trd-tk-levels">
      <LevelTotals m={p.m} list={p.list} />
      <For each={p.list}>
        {(l, i) => (
          <div class="trd-tk-level-block">
            <LevelHead m={p.m} i={i()} l={l} />
            <LevelButton m={p.m} i={i()} l={l} onOpen={() => p.m.openLevel(i())} onRemove={() => p.m.removeLevel(i())} />
          </div>
        )}
      </For>
    </div>
  );
}

/** A field of the level open: its label, the value typed and a hint on the right. */
function LevelField(p: { label: string; value: string; hint: string; step: number; onInput: (v: string) => void }) {
  return (
    <div class="trd-tk-field">
      <span class="trd-tk-label">{p.label}</span>
      <span class="trd-tk-box">
        <input
          class="trd-tk-input"
          inputmode="decimal"
          value={p.value}
          onInput={(e) => p.onInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            const v = parsePositive(p.value) ?? 0;
            const next = Math.max(p.step, v + (e.key === "ArrowUp" ? p.step : -p.step));
            const dec = String(p.step).split(".")[1]?.length ?? 0;
            p.onInput(next.toFixed(dec));
          }}
        />
        <span class="trd-tk-hint ot-value">{p.hint}</span>
      </span>
    </div>
  );
}

/** The "Exit levels" page, in place of the form: the order, the totals, each level (the open one as fields), "Add
 *  level", Confirm / Discard. */
export function ExitLevelsPage(p: { m: TicketModel }) {
  const m = p.m;
  const page = () => m.levelPage()!;
  const ticks = (v: string) => {
    const e = m.entry();
    const x = parsePositive(v);
    if (e == null || x == null) return "";
    const n = Math.round(Math.abs(x - e) / m.tick());
    return translatePlural(n, { one: "{0} tick", other: "{0} ticks" });
  };
  const summary = () => {
    const pos = m.editingPos();
    if (pos) return positionSummary(pos, m.tick());
    const r = m.r();
    const price = r.orderType === "stop" || r.orderType === "stopLimit" ? parsePositive(r.stopPrice) : r.orderType === "limit" ? parsePositive(r.limitPrice) : null;
    return orderSummary(
      { id: "", symbol: r.symbol, side: r.side, type: r.orderType, qty: m.qtyNum() ?? 0, limitPrice: price, stopPrice: price, kind: "order", parentId: null, takeProfit: null, stopLoss: null },
      m.tick(),
    );
  };
  return (
    <>
      <div class="trd-tk-scroll trd-tk-levels-page">
        <div class="trd-tk-levels-order">
          <div class="trd-tk-levels-symbol" data-no-translate>
            {tickerOf(m.d().symbol)}
          </div>
          <div class="trd-tk-levels-summary">{summary()}</div>
        </div>
        <LevelTotals m={m} list={page().list} />
        <For each={page().list}>
          {(l, i) => (
            <Show
              when={i() === page().edit}
              fallback={
                <div class="trd-tk-level-block">
                  <LevelHead m={m} i={i()} l={l} />
                  <LevelButton m={m} i={i()} l={l} onOpen={() => m.setPageEdit(i())} onRemove={() => m.removePageLevel(i())} />
                </div>
              }
            >
              <div class="trd-tk-level-block is-open">
                <LevelHead m={m} i={i()} l={l}>
                  <Tooltip text={translateWith("Remove level {0}", i() + 1)} side="top">
                    <button type="button" class="trd-icon-btn trd-tk-level-del" aria-label={translateWith("Remove level {0}", i() + 1)} onClick={() => m.removePageLevel(i())}>
                      <CloseIcon />
                    </button>
                  </Tooltip>
                </LevelHead>
                <div class="trd-tk-level-fields">
                  <LevelField
                    label="Units"
                    value={l.qty}
                    hint={(() => {
                      const q = parsePositive(l.qty);
                      const n = m.qtyNum();
                      return q != null && n ? pct((q / n) * 100) : "";
                    })()}
                    step={m.inst().qtyStep ?? 1}
                    onInput={(v) => m.setPageLevel(i(), { qty: v })}
                  />
                  <LevelField label="Take profit price" value={l.tp} hint={ticks(l.tp)} step={m.tick()} onInput={(v) => m.setPageLevel(i(), { tp: v })} />
                  <LevelField label="Stop loss price" value={l.sl} hint={ticks(l.sl)} step={m.tick()} onInput={(v) => m.setPageLevel(i(), { sl: v })} />
                </div>
              </div>
            </Show>
          )}
        </For>
        <AddLevelButton m={m} />
      </div>
      <div class="trd-tk-footer">
        <Show when={m.errorText()}>
          <div class="trd-tk-error" role="alert">
            {m.errorText()}
          </div>
        </Show>
        <div class="trd-tk-edit-btns">
          <button type="button" class="trd-tk-place" classList={{ "is-buy": m.d().side === "buy", "is-sell": m.d().side === "sell" }} onClick={() => m.confirmLevels()}>
            <span class="trd-tk-place-title">Confirm</span>
          </button>
          <button type="button" class="trd-tk-discard" onClick={() => m.discardLevels()}>
            Discard
          </button>
        </div>
      </div>
    </>
  );
}
