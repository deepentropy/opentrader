/*
 * The order ticket's ⋯ menu (dock / undock, Trading settings, DOM and risk options), its field tips and the
 * Exits section.
 */
import { Show, createSignal, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Tooltip } from "../../components/Tooltip";
import { CheckMarkBox } from "../../components/form";
import { emitAppEvent } from "../../data/app-events";
import { tradingUi } from "../../data/trading/trading-ui";
import { ChevronIcon } from "./icons";
import { Popup } from "./TicketMenus";

const DotsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <circle cx="4" cy="9" r="1.5" />
    <circle cx="9" cy="9" r="1.5" />
    <circle cx="14" cy="9" r="1.5" />
  </svg>
);
const SettingsIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <path d="M14 6.5l6.5 3.75v7.5L14 21.5l-6.5-3.75v-7.5z" stroke-linejoin="round" />
    <circle cx="14" cy="14" r="2.5" />
  </svg>
);

/** Undock: a window leaving the panel; dock: the panel at the right. */
const UndockIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <rect x="6.5" y="9.5" width="12" height="12" rx="1.5" />
    <path d="M13 7.5h7.5v7.5M20.5 7.5 14 14" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
const DockIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <rect x="6.5" y="7.5" width="15" height="13" rx="1.5" />
    <path d="M16.5 7.5v13" />
  </svg>
);

/** ⋯ (tooltip "Settings"): Undock order ticket / Dock to right, Trading settings… (the chart Settings dialog on
 *  its Trading tab) and "SL enables quantity in risk". */
export function TicketSettingsMenu() {
  const [open, setOpen] = createSignal(false);
  const prices = tradingUi.domPrices;
  const docked = () => tradingUi.ticketMode() === "panel";
  /** The menu of the docked DOM (not of an order dialog over it). */
  const domTab = () => docked() && tradingUi.ticketTab() === "dom" && !tradingUi.orderDialog();
  let btn!: HTMLButtonElement;
  const button = (
    <button type="button" ref={btn} class="trd-icon-btn" classList={{ "is-active": open() }} aria-label="Settings" aria-haspopup="menu" aria-expanded={open()} onClick={() => setOpen(!open())}>
      <DotsIcon />
    </button>
  );
  return (
    <>
      <Tooltip text="Settings" side="bottom">
        {button}
      </Tooltip>
      <Show when={open()}>
        <Popup anchor={btn} alignEnd onClose={() => setOpen(false)} class="trd-menu-settings" label="Settings">
          <Show when={!tradingUi.orderDialog() && !domTab()}>
            <button
              type="button"
              class="trd-menu-row"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                tradingUi.setTicketMode(docked() ? "popup" : "panel");
              }}
            >
              <Show when={docked()} fallback={<DockIcon />}>
                <UndockIcon />
              </Show>
              <span class="trd-menu-title">{docked() ? "Undock order ticket" : "Dock to right"}</span>
            </button>
          </Show>
          <Show when={domTab()}>
            <div class="trd-menu-section">DOM panel settings</div>
            <CheckRow label="Show zero trade volume prices" on={prices().zeroVolume} onToggle={() => tradingUi.setDomPrices({ ...prices(), zeroVolume: !prices().zeroVolume })} />
            <CheckRow label="Show prices between the best bid/ask" on={prices().spread} onToggle={() => tradingUi.setDomPrices({ ...prices(), spread: !prices().spread })} />
            <div class="trd-menu-divider" />
          </Show>
          <button
            type="button"
            class="trd-menu-row"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              emitAppEvent("chart-open-settings", { tab: "trading" });
            }}
          >
            <SettingsIcon />
            <span class="trd-menu-title">Trading settings…</span>
          </button>
          <Show when={!domTab()}>
            <div class="trd-menu-divider" />
            <CheckRow label="SL enables quantity in risk" on={tradingUi.slEnablesRisk()} onToggle={() => tradingUi.setSlEnablesRisk(!tradingUi.slEnablesRisk())} />
          </Show>
        </Popup>
      </Show>
    </>
  );
}

/** A tip under a ticket field (reference app: the tooltip under the field,
 *  as wide as the field less 12 px), until the next press anywhere. */
export function FieldTip(p: { anchor: HTMLElement | undefined; text: string; onClose: () => void }) {
  const [rect, setRect] = createSignal(p.anchor?.getBoundingClientRect() ?? null);
  const onDown = () => p.onClose();
  const t = window.setTimeout(() => document.addEventListener("mousedown", onDown, true), 0);
  const raf = { id: 0 };
  const track = () => {
    if (p.anchor) setRect(p.anchor.getBoundingClientRect());
    raf.id = requestAnimationFrame(track);
  };
  track();
  onCleanup(() => {
    clearTimeout(t);
    cancelAnimationFrame(raf.id);
    document.removeEventListener("mousedown", onDown, true);
  });
  return (
    <Show when={rect()}>
      {(r) => (
        <Portal mount={document.body}>
          <div role="tooltip" class="ot-tooltip ot-tooltip-bottom ot-tooltip-normal" style={{ left: `${r().left + r().width / 2}px`, top: `${r().bottom + 4}px`, "max-width": "none" }}>
            <span class="ot-tooltip-label" style={{ display: "block", width: `${Math.max(0, r().width - 12)}px`, "white-space": "normal" }}>
              {p.text}
            </span>
          </div>
        </Portal>
      )}
    </Show>
  );
}

/** A checkbox row of the ⋯ menu. */
function CheckRow(p: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" class="trd-menu-row" role="menuitemcheckbox" aria-checked={p.on} onClick={() => p.onToggle()}>
      <CheckMarkBox variant="ticket" checked={p.on} />
      <span class="trd-menu-title">{p.label}</span>
    </button>
  );
}

export function ExitsSection(props: { children: JSX.Element }) {
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
