/*
 * Report toolbar (the reference app 3.4.1): Metrics / Trades icon switch, testing
 * period pill, initial capital pill, Bar detalization pill, Script execution pill
 * (the number of executions checked; the reference app shows no other sign of
 * "On order fill", #182), divider, Settings.
 *
 * Not built: Add alert, the testing period choices other than the chart range.
 */
import { For, Show, createSignal } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { Popover, PopItem, PopSectionTitle } from "../screener/Popover";
import { strategyTester } from "../../data/strategy-tester-store";
import { DEFAULT_PROPERTIES, type BacktestReport, type StrategyProperties } from "../../backtester/types";
import { detalizationTicks } from "../../backtester/magnifier";
import { CheckBox } from "../header/ChartPropertiesDialog";
import { EXECUTION_PROPERTY, SYNTHETIC_STYLES, executionOptions } from "../chart/StrategyPropertiesTab";
import { compact, dateRange } from "./format";
import { cachedSymbolSessions } from "../../data/session";

type Props = {
  report: BacktestReport | null;
  properties: Record<string, unknown>;
  onPatchProperties: (patch: Record<string, unknown>) => void;
  onSettings: () => void;
  /** Charted symbol: the testing period shows in its exchange time zone. */
  symbol?: string;
  /** Chart interval (High detalization tick count) and chart type (synthetic types: no High, no history ticks). */
  interval?: string;
  chartStyle?: string;
  /** The script's strategy() properties before overrides (Script execution > Reset). */
  defaults?: StrategyProperties;
  /** The script has the "On history bar tick" option. */
  historyTicks?: boolean;
};

export function ReportToolbar(props: Props) {
  let capitalRef: HTMLButtonElement | undefined;
  const [capitalOpen, setCapitalOpen] = createSignal(false);
  let detalRef: HTMLButtonElement | undefined;
  let execRef: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal<"detal" | "exec" | null>(null);
  const effective = (): StrategyProperties =>
    props.report?.properties ?? ({ ...DEFAULT_PROPERTIES, ...props.defaults, ...props.properties } as StrategyProperties);
  const synthetic = () => SYNTHETIC_STYLES.includes(props.chartStyle ?? "");
  const executions = () => executionOptions(effective(), synthetic(), props.historyTicks !== false);
  const capital = () => props.report?.properties.initialCapital ?? (props.properties.initialCapital as number | undefined) ?? DEFAULT_PROPERTIES.initialCapital;
  const currency = () => props.report?.currency ?? "USD";
  const period = () => {
    const r = props.report;
    const zone = cachedSymbolSessions(props.symbol ?? "")?.timeZone;
    return r && zone ? dateRange(r.range.from, r.range.to, zone) : "";
  };

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
          {(
            <div class="st-pill st-pill-static" data-name="date-range-pill">
              <span class="st-pill-hover-tip">
                <span class="st-pill-tip-title">Testing period</span>
                <span class="st-pill-tip-range">{period()}</span>
              </span>
              <Icon name="st-pill-date-range-icon" size={28} />
              <span class="st-pill-text">{period()}</span>
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

        <button
          type="button"
          ref={detalRef}
          class="st-pill"
          classList={{ "is-open": open() === "detal" }}
          data-name="bar-detalization-pill"
          aria-label="Bar detalization"
          onClick={() => setOpen(open() === "detal" ? null : "detal")}
        >
          <Icon name="st-pill-detalization-icon" size={28} />
          <span class="st-pill-text">{effective().barMagnifier ? "High detalization" : "Default detalization"}</span>
          <span class="st-pill-chevron"><Icon name="st-pill-chevron-down" size={18} /></span>
        </button>

        <button
          type="button"
          ref={execRef}
          class="st-pill"
          classList={{ "is-open": open() === "exec" }}
          data-name="script-execution-pill"
          aria-label="Script execution"
          onClick={() => setOpen(open() === "exec" ? null : "exec")}
        >
          <Icon name="st-pill-script-execution-icon" size={28} />
          <span class="st-pill-text">Script execution</span>
          <span class="st-pill-counter">{executions().filter((o) => o.checked).length}</span>
          <span class="st-pill-chevron"><Icon name="st-pill-chevron-down" size={18} /></span>
        </button>

        <hr class="st-toolbar-divider" />

        <Tooltip text="Settings" side="bottom">
          <button type="button" class="st-icon-btn" aria-label="Settings" onClick={() => props.onSettings()}>
            <Icon name="st-toolbar-settings" size={28} />
          </button>
        </Tooltip>
      </div>

      <Show when={open() === "detal"}>
        <Popover anchor={detalRef} onClose={() => setOpen(null)} width={286} class="st-pill-popover">
          <PopSectionTitle title="Bar detalization" />
          <PopItem
            title="Default detalization"
            right={<span class="st-pill-option-note">4 ticks per bar</span>}
            selected={!effective().barMagnifier}
            onClick={() => {
              props.onPatchProperties({ barMagnifier: false });
              setOpen(null);
            }}
          />
          <PopItem
            title="High detalization"
            right={<span class="st-pill-option-note">~{detalizationTicks(props.interval ?? "1D")} ticks per bar</span>}
            selected={effective().barMagnifier}
            disabled={synthetic()}
            onClick={() => {
              props.onPatchProperties({ barMagnifier: true });
              setOpen(null);
            }}
          />
        </Popover>
      </Show>

      <Show when={open() === "exec"}>
        <Popover anchor={execRef} onClose={() => setOpen(null)} width={286} class="st-pill-popover">
          <div class="st-exec-head">
            <PopSectionTitle title="Script execution" />
            <button
              type="button"
              class="st-exec-reset"
              onClick={() => {
                const d = { ...DEFAULT_PROPERTIES, ...props.defaults };
                props.onPatchProperties({ calcOnOrderFills: d.calcOnOrderFills, calcOnEveryHistoryTick: d.calcOnEveryHistoryTick, calcOnEveryTick: d.calcOnEveryTick });
              }}
            >
              Reset
            </button>
          </div>
          <For each={executions()}>
            {(o) => (
              <div
                role="menuitemcheckbox"
                aria-checked={o.checked}
                aria-disabled={o.disabled || undefined}
                class="scr-item st-exec-item"
                classList={{ "is-disabled": !!o.disabled }}
                onClick={() => {
                  const key = EXECUTION_PROPERTY[o.id];
                  if (!o.disabled && key) props.onPatchProperties({ [key]: !o.checked });
                }}
              >
                <span class="st-exec-check"><CheckBox checked={o.checked} disabled={o.disabled} onToggle={() => {}} tabIndex={-1} /></span>
                <span class="scr-item-text"><span class="scr-item-title">{o.label}</span></span>
              </div>
            )}
          </For>
        </Popover>
      </Show>

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
