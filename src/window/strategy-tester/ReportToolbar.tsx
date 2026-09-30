/*
 * Report toolbar (the reference app 3.4.1): Metrics / Trades icon switch, testing
 * period pill, initial capital pill, divider, Settings.
 *
 * Not built (engine has no counterpart yet, see the design doc): the Bar
 * detalization and Script execution pills, Add alert, the testing period
 * choices other than the chart range.
 */
import { Show, createSignal } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { Popover, PopSectionTitle } from "../screener/Popover";
import { strategyTester } from "../../data/strategy-tester-store";
import { DEFAULT_PROPERTIES, type BacktestReport } from "../../backtester/types";
import { compact, dateRange } from "./format";

type Props = {
  report: BacktestReport | null;
  properties: Record<string, unknown>;
  onPatchProperties: (patch: Record<string, unknown>) => void;
  onSettings: () => void;
};

export function ReportToolbar(props: Props) {
  let capitalRef: HTMLButtonElement | undefined;
  const [capitalOpen, setCapitalOpen] = createSignal(false);
  const capital = () => props.report?.properties.initialCapital ?? (props.properties.initialCapital as number | undefined) ?? DEFAULT_PROPERTIES.initialCapital;
  const currency = () => props.report?.currency ?? "USD";

  return (
    <div class="st-toolbar">
      <div class="st-toolbar-start">
        <div class="st-light-tabs" data-name="light-tabs-buttons" role="tablist">
          <Tooltip text="Metrics" side="bottom">
            <button
              type="button"
              class="st-light-tab"
              classList={{ "is-selected": strategyTester.view() === "metrics" }}
              data-name="light-tab-0"
              aria-label="Metrics"
              onClick={() => strategyTester.setView("metrics")}
            >
              <Icon name="st-toolbar-tab-metrics" size={18} />
            </button>
          </Tooltip>
          <Tooltip text="Trades" side="bottom">
            <button
              type="button"
              class="st-light-tab"
              classList={{ "is-selected": strategyTester.view() === "trades" }}
              data-name="light-tab-1"
              aria-label="Trades"
              onClick={() => strategyTester.setView("trades")}
            >
              <Icon name={strategyTester.view() === "trades" ? "st-toolbar-tab-trades-selected" : "st-toolbar-tab-trades"} size={18} />
            </button>
          </Tooltip>
        </div>

        <Show when={props.report}>
          {(r) => (
            <div class="st-pill st-pill-static" data-name="date-range-pill">
              <span class="st-pill-hover-tip">
                <span class="st-pill-tip-title">Testing period</span>
                <span class="st-pill-tip-range">{dateRange(r().range.from, r().range.to)}</span>
              </span>
              <Icon name="st-pill-date-range-icon" size={28} />
              <span class="st-pill-text">{dateRange(r().range.from, r().range.to)}</span>
            </div>
          )}
        </Show>

        <button
          type="button"
          ref={capitalRef}
          class="st-pill"
          classList={{ "is-open": capitalOpen() }}
          data-name="initial-capital-pill"
          onClick={() => setCapitalOpen(!capitalOpen())}
        >
          <Icon name="st-pill-capital-icon" size={28} />
          <span class="st-pill-text">{compact(capital())}</span>
          <span class="st-pill-currency">{currency()}</span>
          <span class="st-pill-chevron"><Icon name="st-pill-chevron-down" size={18} /></span>
        </button>

        <hr class="st-toolbar-divider" />

        <Tooltip text="Settings" side="bottom">
          <button type="button" class="st-icon-btn" aria-label="Settings" onClick={() => props.onSettings()}>
            <Icon name="st-toolbar-settings" size={28} />
          </button>
        </Tooltip>
      </div>

      <Show when={capitalOpen()}>
        <Popover anchor={capitalRef} onClose={() => setCapitalOpen(false)} width={290} class="st-pill-popover">
          <PopSectionTitle title="Initial capital" />
          <CapitalInput
            value={capital()}
            currency={currency()}
            onCommit={(v) => props.onPatchProperties({ initialCapital: v })}
          />
        </Popover>
      </Show>
    </div>
  );
}

const fmtInput = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function CapitalInput(props: { value: number; currency: string; onCommit: (v: number) => void }) {
  const [text, setText] = createSignal(fmtInput.format(props.value));
  const commit = () => {
    const v = Number(text().replace(/[,\s]/g, ""));
    if (Number.isFinite(v) && v > 0 && v !== props.value) props.onCommit(v);
    else setText(fmtInput.format(props.value));
  };
  return (
    <div class="st-capital-row">
      <input
        class="st-capital-input"
        inputmode="decimal"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <span class="st-capital-currency">{props.currency}</span>
    </div>
  );
}
