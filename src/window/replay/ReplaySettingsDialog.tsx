/*
 * "Trading on historical data {symbol}": the replay trading settings of the
 * focused chart (Trade menu "Replay settings…", Replay Trading menu
 * "Settings…").
 *
 * Initial capital + currency ("Same as chart" first, more currencies under
 * "Show more"), Commission + its type (Percent / Per contract / Fixed in the
 * account currency). Values apply at once (the account is rebuilt with them);
 * Cancel and Escape put back the values the dialog opened with, Ok and Enter
 * keep them. "Defaults": Reset settings / Save as default.
 */
import { For, Show, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { getTickerInfo } from "../../data/datafeed";
import type { CommissionType, ReplaySettings } from "../../data/trading/replay-account";
import { replayBroker } from "../../data/trading/replay-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import { NumberField } from "../header/ChartPropertiesDialog";

const PRIMARY = ["USD", "EUR", "AUD", "GBP", "NZD", "CAD", "CHF"];
const MORE = ["HKD", "JPY", "NOK", "RUB", "SEK", "SGD", "TRY", "ZAR", "BTC", "ETH", "MYR", "KRW", "USDT", "INR"];
const COMMISSION_TYPES: [CommissionType, string][] = [
  ["percent", "Percent"],
  ["cash_per_contract", "Per contract"],
  ["cash_per_order", "Fixed"],
];

const Caret = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M3.92 7.83 9 12.29l5.08-4.46-1-1.13L9 10.29l-4.09-3.6-.99 1.14Z" />
  </svg>
);

const CloseIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
  </svg>
);

function Info(props: { text: string }) {
  return (
    <Tooltip text={props.text} side="top">
      <span class="ind3-info" aria-label={props.text}>
        <Icon name="st-settings-info" size={18} />
      </span>
    </Tooltip>
  );
}

/** A select button with its menu under it (flipped above without room). The
 *  menu content gets a close function. */
function MenuButton(props: { display: string; width?: number; class?: string; label: string; children: (close: () => void) => JSX.Element }) {
  let btn: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const [rect, setRect] = createSignal<DOMRect | null>(null);
  const close = () => setRect(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        class={`cp3-select${props.class ? ` ${props.class}` : ""}${rect() ? " is-open" : ""}`}
        style={props.width ? { width: `${props.width}px` } : undefined}
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={!!rect()}
        onClick={() => setRect(rect() ? null : btn!.getBoundingClientRect())}
      >
        <span class="cp3-select-value">{props.display}</span>
        <span class="cp3-select-caret"><Caret /></span>
      </button>
      <Show when={rect()} keyed>
        {(r) => {
          const [top, setTop] = createSignal(r.bottom + 4);
          const onDown = (e: PointerEvent) => {
            if (menu?.contains(e.target as Node) || btn?.contains(e.target as Node)) return;
            close();
          };
          const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            // The menu closes, not the dialog.
            e.stopPropagation();
            close();
          };
          onMount(() => {
            const h = menu?.offsetHeight ?? 0;
            if (r.bottom + 4 + h > window.innerHeight - 4) setTop(Math.max(4, r.top - h - 4));
            document.addEventListener("pointerdown", onDown, true);
            window.addEventListener("keydown", onKey, true);
          });
          onCleanup(() => {
            document.removeEventListener("pointerdown", onDown, true);
            window.removeEventListener("keydown", onKey, true);
          });
          return (
            <Portal>
              <div ref={menu} class="cp3-menu rs-menu" role="listbox" style={{ left: `${r.left}px`, top: `${top()}px`, "min-width": `${r.width}px` }}>
                {props.children(close)}
              </div>
            </Portal>
          );
        }}
      </Show>
    </>
  );
}

function Item(props: { title: string; tag?: string; selected?: boolean; onClick: () => void }) {
  return (
    <div role="option" aria-selected={!!props.selected} class={`cp3-menu-item${props.selected ? " is-selected" : ""}`} onClick={() => props.onClick()}>
      <span class="cp3-menu-title">{props.title}</span>
      <Show when={props.tag}>
        <span class="cp3-menu-tag">{props.tag}</span>
      </Show>
    </div>
  );
}

export function ReplaySettingsDialog() {
  return (
    <Show when={tradingUi.settingsOpen()}>
      <SettingsDialog />
    </Show>
  );
}

function SettingsDialog() {
  const paneId = replayBroker.activePane();
  const initial: ReplaySettings = { ...replayBroker.settings(paneId) };
  const s = () => replayBroker.settings(paneId);
  const set = (patch: Partial<ReplaySettings>) => replayBroker.setSettings({ ...s(), ...patch }, paneId);
  const symbol = replayBroker.symbol() ?? tradingUi.activeSymbol();
  const ticker = symbol.includes(":") ? symbol.slice(symbol.indexOf(":") + 1) : symbol;
  // "Same as chart": the currency the symbol trades in.
  const [chartCurrency] = createResource(
    () => symbol,
    (sym) =>
      getTickerInfo(sym)
        .then((i) => (i?.currency ?? "").toUpperCase() || "USD")
        .catch(() => "USD"),
  );
  const chartCur = () => chartCurrency() ?? (initial.currency === "NONE" ? replayBroker.currency(paneId) : "USD");
  const accountCur = () => (s().currency === "NONE" ? chartCur() : s().currency);
  const [more, setMore] = createSignal(MORE.includes(initial.currency));

  const ok = () => tradingUi.closeReplaySettings();
  const cancel = () => {
    replayBroker.setSettings(initial, paneId);
    tradingUi.closeReplaySettings();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      // A typed value commits on blur: blur first.
      (document.activeElement as HTMLElement | null)?.blur?.();
      ok();
    }
  };
  let box: HTMLDivElement | undefined;
  const onOutside = (e: PointerEvent) => {
    const t = e.target as HTMLElement;
    if (box?.contains(t) || t.closest?.(".rs-menu")) return;
    ok();
  };
  onMount(() => {
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside, true);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKey);
    document.removeEventListener("pointerdown", onOutside, true);
  });

  const num = (v: string): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  return (
    <Portal>
      <div class="ot-dlg-layer rs-layer">
        <div ref={box} class="rs-dialog" role="dialog" aria-label="Replay settings" data-name="replay-settings-dialog">
          <div class="rs-header">
            <div class="rs-title">Trading on historical data {ticker}</div>
            <button type="button" class="rs-close" aria-label="Close" onClick={cancel}>
              <CloseIcon />
            </button>
          </div>
          <div class="rs-body">
            <div class="rs-row">
              <span class="rs-label">Initial capital</span>
              <NumberField
                value={String(s().initialCapital)}
                width={126}
                num={{ min: 0, max: 1.79e308, step: 1 }}
                noSpin
                grouping
                onChange={(v) => {
                  const n = num(v);
                  if (n !== null) set({ initialCapital: n });
                }}
              />
              <MenuButton display={accountCur()} width={126} label="Base currency">
                {(close) => (
                  <>
                    <Item title="Same as chart" tag={chartCur()} selected={s().currency === "NONE"} onClick={() => { set({ currency: "NONE" }); close(); }} />
                    <For each={more() ? [...PRIMARY, ...MORE] : PRIMARY}>
                      {(c) => <Item title={c} selected={s().currency === c} onClick={() => { set({ currency: c }); close(); }} />}
                    </For>
                    <Show when={!more()}>
                      <button type="button" class="rs-more" onClick={() => setMore(true)}>
                        <span>Show more</span>
                        <Caret />
                      </button>
                    </Show>
                  </>
                )}
              </MenuButton>
              <Info text="The amount of funds initially available for the strategy to trade" />
            </div>
            <div class="rs-row">
              <span class="rs-label">Commission</span>
              <NumberField
                value={String(s().commissionValue)}
                width={126}
                num={{ min: 0, max: 1.79e308, step: 1 }}
                noSpin
                onChange={(v) => {
                  const n = num(v);
                  if (n !== null) set({ commissionValue: n });
                }}
              />
              <MenuButton display={COMMISSION_TYPES.find(([t]) => t === s().commissionType)?.[1] ?? "Percent"} width={126} label="Commission type">
                {(close) => (
                  <For each={COMMISSION_TYPES}>
                    {([t, title]) => (
                      <Item
                        title={title}
                        tag={t === "cash_per_order" ? accountCur() : undefined}
                        selected={s().commissionType === t}
                        onClick={() => {
                          set({ commissionType: t });
                          close();
                        }}
                      />
                    )}
                  </For>
                )}
              </MenuButton>
              <Info text="Fees paid for each entry and exit" />
            </div>
          </div>
          <div class="rs-footer">
            <MenuButton display="Defaults" class="rs-defaults" label="Defaults">
              {(close) => (
                <>
                  <Item
                    title="Reset settings"
                    onClick={() => {
                      set(replayBroker.factoryDefaults());
                      close();
                    }}
                  />
                  <Item
                    title="Save as default"
                    onClick={() => {
                      replayBroker.saveDefaults({ ...s() });
                      close();
                    }}
                  />
                </>
              )}
            </MenuButton>
            <span class="rs-spacer" />
            <button type="button" class="ot-dlg-btn is-secondary" onClick={cancel}>
              Cancel
            </button>
            <button type="button" class="ot-dlg-btn is-neutral" onClick={ok}>
              Ok
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
