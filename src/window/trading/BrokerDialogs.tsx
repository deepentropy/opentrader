/*
 * "Trade with your broker" (broker cards) and the broker's connect dialog.
 *
 * The reference app logs in through the broker's web login; this app connects
 * to the user's own IB Gateway / TWS on this computer, so the connect dialog
 * asks where it listens (application, live / paper, host, port, client ID)
 * instead. Layout and sizes follow the reference dialogs
 * (.tmp/trading-panel/DESIGN.md §2).
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { broker, DEFAULT_CONFIG } from "../../data/broker-store";
import { tradingUi } from "../../data/trading-ui";
import { CloseIcon, IbkrMark, InfoIcon, SearchIcon } from "./icons";

type BrokerCard = { id: string; title: string; note: string };
const BROKERS: BrokerCard[] = [{ id: "ibkr", title: "Interactive Brokers", note: "Through IB Gateway or TWS" }];

function useEscape(onEscape: () => void) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onEscape();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
}

export function BrokerSelectDialog() {
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? BROKERS.filter((b) => b.title.toLowerCase().includes(q)) : BROKERS;
  });
  useEscape(() => tradingUi.closeDialog());
  let input: HTMLInputElement | undefined;

  return (
    <Portal>
      <div class="trd-dialog-layer">
        <div class="trd-select-dialog" data-name="select-broker-dialog" role="dialog" aria-label="Trade with your broker">
          <button type="button" class="trd-dialog-close" aria-label="Close" onClick={() => tradingUi.closeDialog()}>
            <CloseIcon />
          </button>
          <div class="trd-select-head">
            <h2 class="trd-select-title">Trade with your broker</h2>
            <Show
              when={searching()}
              fallback={
                <button
                  type="button"
                  class="trd-icon-btn trd-select-search-btn"
                  aria-label="Find broker"
                  onClick={() => {
                    setSearching(true);
                    queueMicrotask(() => input?.focus());
                  }}
                >
                  <SearchIcon />
                </button>
              }
            >
              <label class="trd-select-search">
                <span class="trd-select-search-icon"><SearchIcon /></span>
                <input ref={input} placeholder="Find broker" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
                <button
                  type="button"
                  class="trd-select-search-clear"
                  aria-label="Clear"
                  onClick={() => {
                    setQuery("");
                    setSearching(false);
                  }}
                >
                  <CloseIcon size={14} />
                </button>
              </label>
            </Show>
          </div>
          <div class="trd-select-grid">
            <For each={shown()} fallback={<div class="trd-select-empty">No brokers match your search</div>}>
              {(b) => (
                <button type="button" class="trd-broker-card" data-broker={b.id} onClick={() => tradingUi.openLogin()}>
                  <IbkrMark size={48} />
                  <span class="trd-broker-card-name">{b.title}</span>
                  <span class="trd-broker-card-note">{b.note}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Portal>
  );
}

type App = "gateway" | "tws";
type Mode = "live" | "paper";
const PORTS: Record<App, Record<Mode, number>> = { gateway: { live: 4001, paper: 4002 }, tws: { live: 7496, paper: 7497 } };

function presetOf(port: number): { app: App; mode: Mode } | null {
  for (const app of ["gateway", "tws"] as App[]) {
    for (const mode of ["live", "paper"] as Mode[]) if (PORTS[app][mode] === port) return { app, mode };
  }
  return null;
}

export function IbkrLoginDialog() {
  const cfg = broker.config();
  const [host, setHost] = createSignal(cfg.host);
  const [port, setPort] = createSignal(String(cfg.port));
  const [clientId, setClientId] = createSignal(String(cfg.clientId));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(broker.state().error);
  const preset = createMemo(() => presetOf(Number(port())));
  const pick = (app: App, mode: Mode) => setPort(String(PORTS[app][mode]));

  // Back to the broker list, as the reference login dialog's close.
  const close = () => (busy() ? undefined : tradingUi.openBrokerDialog());
  useEscape(close);

  async function connect(e?: Event) {
    e?.preventDefault();
    const p = Number(port());
    const id = Number(clientId());
    if (!host().trim()) return setError("Enter the host IB Gateway or TWS runs on");
    if (!Number.isInteger(p) || p <= 0 || p > 65535) return setError("Enter a valid port");
    if (!Number.isInteger(id)) return setError("Enter a whole number as client ID");
    setBusy(true);
    setError(null);
    try {
      await broker.connect({ host: host().trim(), port: p, clientId: id });
      tradingUi.closeDialog();
      tradingUi.setCollapsed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div class="trd-dialog-layer">
        <form class="trd-login-dialog" data-name="broker-login-dialog" role="dialog" aria-label="Interactive Brokers" onSubmit={connect}>
          <button type="button" class="trd-dialog-close" aria-label="Close" onClick={close}>
            <CloseIcon />
          </button>
          <div class="trd-login-broker">
            <IbkrMark size={48} radius={8} />
            <div class="trd-login-broker-text">
              <div class="trd-login-title">Interactive Brokers</div>
              <div class="trd-login-sub">Connects to IB Gateway or TWS on your computer</div>
            </div>
          </div>
          <div class="trd-login-body">
            <div class="trd-login-row">
              <span class="trd-login-label">Application</span>
              <div class="trd-seg" role="radiogroup">
                <For each={[["gateway", "IB Gateway"], ["tws", "TWS"]] as [App, string][]}>
                  {([app, label]) => (
                    <button type="button" role="radio" aria-checked={preset()?.app === app} classList={{ "is-on": preset()?.app === app }}
                      onClick={() => pick(app, preset()?.mode ?? "live")}>{label}</button>
                  )}
                </For>
              </div>
            </div>
            <div class="trd-login-row">
              <span class="trd-login-label">Account</span>
              <div class="trd-seg" role="radiogroup">
                <For each={[["live", "Live"], ["paper", "Paper"]] as [Mode, string][]}>
                  {([mode, label]) => (
                    <button type="button" role="radio" aria-checked={preset()?.mode === mode} classList={{ "is-on": preset()?.mode === mode }}
                      onClick={() => pick(preset()?.app ?? "gateway", mode)}>{label}</button>
                  )}
                </For>
              </div>
            </div>
            <div class="trd-login-fields">
              <label class="trd-field trd-field-host">
                <span>Host</span>
                <input value={host()} onInput={(e) => setHost(e.currentTarget.value)} placeholder={DEFAULT_CONFIG.host} spellcheck={false} />
              </label>
              <label class="trd-field">
                <span>Port</span>
                <input value={port()} inputmode="numeric" onInput={(e) => setPort(e.currentTarget.value.replace(/\D/g, ""))} />
              </label>
              <label class="trd-field">
                <span>Client ID</span>
                <input value={clientId()} inputmode="numeric" onInput={(e) => setClientId(e.currentTarget.value.replace(/[^\d-]/g, ""))} />
              </label>
            </div>
            <Show when={error()}>
              <div class="trd-login-error" role="alert">{error()}</div>
            </Show>
            <button type="submit" class="trd-primary-btn trd-login-connect" aria-label="Connect broker" disabled={busy()}>
              {busy() ? "Connecting…" : "Connect"}
            </button>
            <p class="trd-login-terms">
              By clicking "Connect" I confirm that orders sent from this app are executed by my broker and I accept all risks.
            </p>
            <div class="trd-login-notice">
              <span class="trd-login-notice-icon"><InfoIcon /></span>
              <span>
                <b>Notice!</b> Start IB Gateway or TWS and log in first. In TWS, enable the API in Global Configuration › API ›
                Settings ("Enable ActiveX and Socket Clients").
              </span>
            </div>
          </div>
        </form>
      </div>
    </Portal>
  );
}
