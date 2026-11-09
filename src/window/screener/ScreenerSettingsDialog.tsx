/*
 * "Screener settings" (the reference app 3.5, opened by the gear at the
 * topbar's right): tabs General / Table / Charts / Heatmap on the left, the
 * tab's options on the right. A change applies at once; Cancel (or the close
 * button, Escape, a click outside) puts the settings of the opening back, Ok
 * keeps them. Same frame and controls as the chart Settings dialog.
 *
 * Left out: "Symbol type" (shows nothing on US stocks in the reference) and
 * the group-by-ISIN switch (hidden for US stocks there).
 */
import { For, Show, createSignal, type JSX } from "solid-js";
import { Icon } from "../../components/Icon";
import { CheckBox, SelectControl } from "../../components/form";
import {
  CURRENCIES,
  HEAT_SCHEMES,
  restoreScreenerSettings,
  screenerSettings,
  setScreenerSettings,
  type AutoRefresh,
  type Currency,
  type HeatScheme,
} from "../../data/screener-settings";
import { heatOption } from "../../data/screener-heatmap";
import { screenerStore } from "../../data/screener-store";
import { Dialog } from "../../components/Dialog";

type Tab = "general" | "table" | "charts" | "heatmap";
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "scr-tab-general" },
  { id: "table", label: "Table", icon: "scr-view-table" },
  { id: "charts", label: "Charts", icon: "scr-tab-charts" },
  { id: "heatmap", label: "Heatmap", icon: "scr-view-heatmap" },
];
const REFRESH_LABEL: Record<Exclude<AutoRefresh, "off">, string> = { "10s": "Every 10 seconds", "1min": "Every 1 minute" };

export function ScreenerSettingsDialog(props: { onClose: () => void }) {
  const opening = { ...screenerSettings() };
  const [tab, setTab] = createSignal<Tab>("general");
  const s = screenerSettings;
  const cancel = () => {
    restoreScreenerSettings(opening);
    props.onClose();
  };

  const Section = (p: { title: string; first?: boolean }) => (
    <div class="cp3-section" classList={{ "is-first": !!p.first }}><span>{p.title}</span></div>
  );
  /** A check box row with an optional control on the right. */
  const Row = (p: { label: string; checked?: boolean; disabled?: boolean; onToggle?: () => void; children?: JSX.Element }) => (
    <>
      <div class="cp3-cell cp3-label" classList={{ "is-full": !p.children }}>
        <div class="cp3-label-inner">
          <Show when={p.onToggle}>
            <CheckBox checked={!!p.checked} disabled={p.disabled} onToggle={() => p.onToggle?.()} />
          </Show>
          <span class="cp3-title" classList={{ "is-disabled": !!p.disabled }} onClick={() => !p.disabled && p.onToggle?.()}>{p.label}</span>
        </div>
      </div>
      <Show when={p.children}>
        <div class="cp3-cell cp3-controls">{p.children}</div>
      </Show>
    </>
  );

  return (
    <Dialog
      look="settings"
      layerClass="settings-backdrop cp3-backdrop"
      backdrop="close"
      inline
      class="settings-dialog cp3-dialog scr-settings-dialog"
      data-name="screener-settings-dialog"
      title="Screener settings"
      onClose={cancel}
      // An open select takes Escape first.
      onEscape={() => (document.querySelector(".cp3-menu") ? false : cancel())}
    >
      <div class="cp3-body">
        <nav class="cp3-tabs" aria-label="Screener settings sections">
          <For each={TABS}>
            {(t) => (
              <button type="button" class="settings-tab" classList={{ "is-active": tab() === t.id }} aria-current={tab() === t.id} onClick={() => setTab(t.id)}>
                <Icon name={t.icon} size={28} class="settings-tab-icon" />
                <span class="settings-tab-label">{t.label}</span>
              </button>
            )}
          </For>
        </nav>
        <div class="cp3-content">
          <div class="cp3-grid">
            <Show when={tab() === "general"}>
              <Section title="Data" first />
              <Row label="Auto-refresh" checked={s().autoRefresh !== "off"} onToggle={() => setScreenerSettings({ autoRefresh: s().autoRefresh === "off" ? "1min" : "off" })}>
                <SelectControl
                  width={180}
                  value={s().autoRefresh === "off" ? "1min" : s().autoRefresh}
                  options={["10s", "1min"]}
                  labelOf={(o) => REFRESH_LABEL[o as "10s"]}
                  disabled={s().autoRefresh === "off"}
                  onPick={(v) => setScreenerSettings({ autoRefresh: v as AutoRefresh })}
                />
              </Row>
              <Row label="Convert financials" checked={s().currency !== null} onToggle={() => setScreenerSettings({ currency: s().currency === null ? "USD" : null })}>
                <SelectControl
                  width={180}
                  value={s().currency ?? "USD"}
                  options={[...CURRENCIES]}
                  disabled={s().currency === null}
                  onPick={(v) => setScreenerSettings({ currency: v as Currency })}
                />
              </Row>
            </Show>
            <Show when={tab() === "table"}>
              <Section title="Symbol column" first />
              {/* One of Symbol / Name stays checked: the only checked one is disabled. */}
              <Row label="Symbol" checked={s().showSymbol} disabled={s().showSymbol && !s().showName} onToggle={() => setScreenerSettings({ showSymbol: !s().showSymbol })} />
              <Row label="Name" checked={s().showName} disabled={s().showName && !s().showSymbol} onToggle={() => setScreenerSettings({ showName: !s().showName })} />
              <Row label="Logo" checked={s().showLogo} onToggle={() => setScreenerSettings({ showLogo: !s().showLogo })} />
              <Section title="Shown values" />
              <Row label="Currency" checked={s().showCurrency} onToggle={() => setScreenerSettings({ showCurrency: !s().showCurrency })} />
            </Show>
            <Show when={tab() === "charts"}>
              <Section title="Chart label" first />
              <Row label="Instrument name" checked={s().chartName} onToggle={() => setScreenerSettings({ chartName: !s().chartName })} />
            </Show>
            <Show when={tab() === "heatmap"}>
              <Section title="Tile" first />
              <Row label="Instrument logo" checked={s().heatLogo} onToggle={() => setScreenerSettings({ heatLogo: !s().heatLogo })} />
              <Row label="Title" checked={s().heatTitleOn} onToggle={() => setScreenerSettings({ heatTitleOn: !s().heatTitleOn })}>
                <SelectControl
                  width={180}
                  value={s().heatTitle}
                  options={["name", "symbol"]}
                  labelOf={(o) => (o === "name" ? "Instrument name" : "Symbol")}
                  disabled={!s().heatTitleOn}
                  onPick={(v) => setScreenerSettings({ heatTitle: v as "name" | "symbol" })}
                />
              </Row>
              <Row label="Value" checked={s().heatValueOn} onToggle={() => setScreenerSettings({ heatValueOn: !s().heatValueOn })}>
                <SelectControl
                  width={180}
                  value={s().heatValue}
                  options={["color", "size"]}
                  labelOf={(o) => (o === "size" ? heatOption("size", s().heatSize, screenerStore.type()) : heatOption("color", s().heatColor, screenerStore.type())).valueShort}
                  disabled={!s().heatValueOn}
                  onPick={(v) => setScreenerSettings({ heatValue: v as "color" | "size" })}
                />
              </Row>
              <Section title="Color" />
              <Row label="Color scheme">
                <SelectControl
                  width={180}
                  value={s().heatScheme}
                  options={HEAT_SCHEMES.map((x) => x.id)}
                  labelOf={(o) => HEAT_SCHEMES.find((x) => x.id === o)?.label ?? o}
                  onPick={(v) => setScreenerSettings({ heatScheme: v as HeatScheme })}
                />
              </Row>
            </Show>
          </div>
        </div>
      </div>
      <footer class="cp3-footer">
        <div class="cp3-footer-actions">
          <button type="button" class="cp3-btn" onClick={cancel}>Cancel</button>
          <button type="button" class="cp3-btn is-primary" data-qa-id="submit-button" onClick={() => props.onClose()}>Ok</button>
        </div>
      </footer>
    </Dialog>
  );
}
