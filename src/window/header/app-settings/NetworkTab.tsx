/*
 * Settings > Network: the desktop app's proxy server.
 */
import { createSignal, onCleanup, Show } from "solid-js";
import { SelectControl, CheckField } from "../../../components/form";
import type { ProxyProtocol, ProxySettings } from "../../../bindings";
import { loadProxySettings, saveProxySettings } from "./io";
import { Section } from "./parts";

/** Waits this long after the last change before applying the proxy (typing a server name). */
const PROXY_APPLY_DELAY_MS = 500;

export function NetworkTab() {
  const [proxy, setProxy] = createSignal<ProxySettings>({ enabled: false, protocol: "http", host: "", port: "", username: "", password: "" });
  const [shown, setShown] = createSignal(false);
  // The password couldn't be stored: it lasts until the app closes.
  const [notStored, setNotStored] = createSignal(false);
  void loadProxySettings().then(setProxy);
  let timer: number | undefined;
  const apply = () => {
    timer = undefined;
    void saveProxySettings(proxy()).then((r) => setNotStored(r.notStored));
  };
  const change = (patch: Partial<ProxySettings>) => {
    setProxy({ ...proxy(), ...patch });
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(apply, PROXY_APPLY_DELAY_MS);
  };
  onCleanup(() => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      apply();
    }
  });
  const off = () => !proxy().enabled;
  return (
    <div class="app-settings-network">
      <Section label="PROXY SETTINGS">
        <CheckField variant="settings" label="Use a proxy server" checked={!!proxy().enabled} onChange={() => change({ enabled: !proxy().enabled })} />
      </Section>
      <Section label="PROXY PROTOCOL">
        <SelectControl
          value={proxy().protocol ?? "http"}
          options={["http", "socks5"]}
          labelOf={(o) => o.toUpperCase()}
          width={467}
          disabled={off()}
          onPick={(o) => change({ protocol: o as ProxyProtocol })}
        />
      </Section>
      <label class="app-settings-field">
        <span class="app-settings-field-label">Server IP address or domain name*</span>
        <input class="app-settings-input" type="text" placeholder="127.0.0.1" disabled={off()} value={proxy().host} onInput={(e) => change({ host: e.currentTarget.value })} />
      </label>
      <label class="app-settings-field">
        <span class="app-settings-field-label">Port*</span>
        <input
          class="app-settings-input"
          type="text"
          inputmode="numeric"
          placeholder="3128"
          disabled={off()}
          value={proxy().port}
          onInput={(e) => {
            e.currentTarget.value = e.currentTarget.value.replace(/\D/g, "");
            change({ port: e.currentTarget.value });
          }}
        />
      </label>
      <label class="app-settings-field">
        <span class="app-settings-field-label">Username</span>
        <input class="app-settings-input" type="text" autocomplete="off" disabled={off()} value={proxy().username} onInput={(e) => change({ username: e.currentTarget.value })} />
      </label>
      <label class="app-settings-field">
        <span class="app-settings-field-label">Password</span>
        <span class="app-settings-password">
          <input class="app-settings-input" type={shown() ? "text" : "password"} autocomplete="off" disabled={off()} value={proxy().password} onInput={(e) => change({ password: e.currentTarget.value })} />
          <button type="button" class="app-settings-eye" aria-label={shown() ? "Hide password" : "Show password"} disabled={off()} onClick={(e) => { e.preventDefault(); setShown(!shown()); }}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
              <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
              <circle cx="12" cy="12" r="3" />
              <Show when={shown()}><path d="M4 20 20 4" /></Show>
            </svg>
          </button>
        </span>
        <Show when={notStored()}>
          <span class="app-settings-field-error">The password can't be stored securely on this system. Enter it again after a restart.</span>
        </Show>
      </label>
    </div>
  );
}
