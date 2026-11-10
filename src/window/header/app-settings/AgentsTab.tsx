/*
 * Settings > Coding agents: the local MCP endpoint (src-tauri/src/agent.rs, src/agent/), off by default.
 */
import { createSignal, For, onCleanup, Show } from "solid-js";
import { CheckField } from "../../../components/form";
import type { AgentServerStatus } from "../../../bindings";
import { agentServer, type AgentServerResult } from "./io";
import { ConfirmButton, Section } from "./parts";

export function AgentsTab() {
  const [st, setSt] = createSignal<AgentServerStatus | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [shown, setShown] = createSignal(false);
  const [copied, setCopied] = createSignal<string | null>(null);
  const [port, setPort] = createSignal("");
  const take = (p: Promise<AgentServerResult>) =>
    void p.then((r) => {
      if (r.status === "ok") {
        setSt(r.data);
        setPort(String(r.data.port));
        setError(null);
      } else setError(r.error);
    });
  void agentServer.status().then((s) => {
    setSt(s);
    setPort(String(s.port));
  });
  let copyTimer: number | undefined;
  onCleanup(() => window.clearTimeout(copyTimer));
  const copy = (what: string, text: string) =>
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => setCopied(null), 2000);
    });
  const applyPort = () => {
    const n = Number(port());
    if (st() && n !== st()!.port) take(agentServer.setPort(n));
  };
  const setups = (s: AgentServerStatus) => [
    { id: "claude", label: "Claude Code (terminal)", command: `claude mcp add --transport http opentrader ${s.url} --header "Authorization: Bearer ${s.token}"` },
    { id: "codex", label: "Codex (~/.codex/config.toml)", command: `[mcp_servers.opentrader]
url = "${s.url}"
http_headers = { "Authorization" = "Bearer ${s.token}" }` },
    { id: "json", label: "Other agents (MCP JSON config)", command: JSON.stringify({ mcpServers: { opentrader: { type: "http", url: s.url, headers: { Authorization: `Bearer ${s.token}` } } } }, null, 2) },
  ];
  return (
    <div class="app-settings-network app-settings-agents">
      <Show when={st()}>
        {(s) => (
          <>
            <Section label="CODING AGENTS">
              <CheckField variant="settings" label="Allow coding agents to use OpenTrader" checked={s().enabled} onChange={() => take(agentServer.setEnabled(!s().enabled))} />
              <div class="app-settings-note">
                An agent such as Claude Code or Codex can then read your charts, add indicators, write and test scripts, run strategies and draw, on this
                computer only. It cannot place orders. Anyone with the token below can do the same while OpenTrader runs.
              </div>
            </Section>
            <Show when={s().error ?? error()}>
              {(e) => <span class="app-settings-field-error">{e()}</span>}
            </Show>
            <label class="app-settings-field">
              <span class="app-settings-field-label">Port</span>
              <input
                class="app-settings-input"
                type="text"
                inputmode="numeric"
                value={port()}
                onInput={(e) => {
                  e.currentTarget.value = e.currentTarget.value.replace(/\D/g, "").slice(0, 5);
                  setPort(e.currentTarget.value);
                }}
                onBlur={applyPort}
                onKeyDown={(e) => { if (e.key === "Enter") applyPort(); }}
              />
            </label>
            <label class="app-settings-field">
              <span class="app-settings-field-label">Token</span>
              <span class="app-settings-password">
                <input class="app-settings-input" type={shown() ? "text" : "password"} readOnly value={s().token} />
                <button type="button" class="app-settings-eye" aria-label={shown() ? "Hide token" : "Show token"} onClick={(e) => { e.preventDefault(); setShown(!shown()); }}>
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
                    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
                    <circle cx="12" cy="12" r="3" />
                    <Show when={shown()}><path d="M4 20 20 4" /></Show>
                  </svg>
                </button>
              </span>
            </label>
            <div class="app-settings-agents-row">
              <ConfirmButton label="New token" confirmLabel="Agents set up before stop working" onConfirm={() => take(agentServer.newToken())} />
            </div>
            <Section label="SET UP AN AGENT">
              <For each={setups(s())}>
                {(x) => (
                  <div class="app-settings-agents-setup">
                    <div class="app-settings-agents-setup-head">
                      <span class="app-settings-field-label">{x.label}</span>
                      <button type="button" class="app-settings-btn" onClick={() => copy(x.id, x.command)}>{copied() === x.id ? "Copied" : "Copy"}</button>
                    </div>
                    <pre class="app-settings-code" data-no-translate>{shown() ? x.command : x.command.split(s().token).join("•".repeat(12))}</pre>
                  </div>
                )}
              </For>
            </Section>
          </>
        )}
      </Show>
    </div>
  );
}
