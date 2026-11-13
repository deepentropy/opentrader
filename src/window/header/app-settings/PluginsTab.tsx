/*
 * Settings > Plugins (#313): the plugins installed on this computer (from the catalog or a file), their settings, the
 * files their installation copies into another application, and the local Plugin API they connect to
 * (src-tauri/src/plugins, plugins/PROTOCOL.md).
 */
import { createSignal, For, onCleanup, Show } from "solid-js";
import { CheckField, SelectControl } from "../../../components/form";
import type { CatalogEntry, InstallStep, PackagePreview, PluginInfo, PluginsStatus, SettingField } from "../../../bindings";
import { translate, translateWith } from "../../../i18n/translator";
import { openLink, plugins, type Result } from "./io";
import { ConfirmButton, Section } from "./parts";

const PROTOCOL = "https://github.com/deepentropy/opentrader/blob/main/plugins/PROTOCOL.md";
const capabilityLabel = (c: string) => (c === "broker" ? translate("Broker") : translate("Data"));

export function PluginsTab() {
  const [st, setSt] = createSignal<PluginsStatus | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [port, setPort] = createSignal("");
  const [catalog, setCatalog] = createSignal<CatalogEntry[] | null>(null);
  const [preview, setPreview] = createSignal<PackagePreview | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);

  const refresh = () =>
    void plugins.status().then((s) => {
      setSt(s);
      if (document.activeElement?.getAttribute("data-name") !== "plugins-port") setPort(String(s.port));
    });
  refresh();
  let unlisten: (() => void) | undefined;
  void plugins.onChange(refresh).then((u) => (unlisten = u));
  onCleanup(() => unlisten?.());

  /** Runs a call that answers the new status; `what` marks the button busy meanwhile. */
  const take = async (what: string, p: Promise<Result<PluginsStatus>>) => {
    setBusy(what);
    setError(null);
    const r = await p;
    setBusy(null);
    if (r.status === "ok") setSt(r.data);
    else setError(r.error);
    return r.status === "ok";
  };
  const applyPort = () => {
    const n = Number(port());
    if (st() && n !== st()!.port) void take("port", plugins.setPort(n));
  };
  const loadCatalog = async () => {
    setBusy("catalog");
    setError(null);
    const r = await plugins.catalog();
    setBusy(null);
    if (r.status === "ok") setCatalog(r.data);
    else setError(r.error);
  };
  const pickFile = async () => {
    setError(null);
    const r = await plugins.pickFile();
    if (r.status === "error") setError(r.error);
    else setPreview(r.data);
  };
  const installed = (id: string) => st()?.plugins.find((p) => p.manifest.id === id);

  return (
    <div class="app-settings-network app-settings-plugins">
      <Section label="PLUGINS">
        <div class="app-settings-note app-settings-local-note">
          Plugins connect OpenTrader to other applications on this computer: a data plugin adds the symbols it supplies, a broker plugin shows your
          account and trades on it. A plugin runs with your rights: install only the ones you trust. OpenTrader keeps no password of theirs.
        </div>
      </Section>
      <Show when={st()}>
        {(s) => (
          <>
            <For each={s().plugins} fallback={<div class="app-settings-note app-settings-local-note">No plugin installed.</div>}>
              {(p) => <PluginCard plugin={p} busy={busy()} take={take} />}
            </For>
            <div class="app-settings-local-add">
              <button type="button" class="app-settings-btn" data-name="plugins-catalog" disabled={busy() === "catalog"} onClick={() => void loadCatalog()}>
                {catalog() ? "Refresh catalog" : "Browse catalog"}
              </button>
              <button type="button" class="app-settings-btn" data-name="plugins-install-file" onClick={() => void pickFile()}>
                Install from file…
              </button>
            </div>
            <Show when={preview()}>
              {(pv) => (
                <section class="app-settings-local-folder app-settings-plugin-preview" data-name="plugin-preview">
                  <div class="app-settings-local-head">
                    <span class="app-settings-local-path" data-no-translate>
                      {pv().manifest.name} {pv().manifest.version}
                    </span>
                    <Capabilities list={pv().manifest.provides} />
                  </div>
                  <Show when={pv().manifest.description}>
                    <div class="app-settings-local-status" data-no-translate>{pv().manifest.description}</div>
                  </Show>
                  <Show when={pv().replaces}>
                    {(v) => <div class="app-settings-local-status">{translateWith("Replaces the installed version {0}.", v())}</div>}
                  </Show>
                  <Show when={!pv().verified}>
                    <div class="app-settings-field-error">
                      This package is not signed by OpenTrader. Install it only if you trust where it comes from: a plugin runs on your computer with your
                      rights.
                    </div>
                  </Show>
                  <div class="app-settings-local-head">
                    <button
                      type="button"
                      class="app-settings-btn"
                      data-name="plugin-preview-install"
                      disabled={busy() === "file"}
                      onClick={() => void take("file", plugins.installFile(pv().path)).then((ok) => ok && setPreview(null))}
                    >
                      {pv().verified ? translate("Install") : translate("Install anyway")}
                    </button>
                    <button type="button" class="app-settings-btn" onClick={() => setPreview(null)}>
                      Cancel
                    </button>
                  </div>
                </section>
              )}
            </Show>
            <Show when={catalog()}>
              {(list) => (
                <Section label="CATALOG">
                  <For each={list()} fallback={<div class="app-settings-note app-settings-local-note">The catalog is empty.</div>}>
                    {(e) => {
                      const have = () => installed(e.id);
                      const action = () => (!have() ? translate("Install") : have()!.manifest.version !== e.version ? translate("Update") : null);
                      return (
                        <div class="app-settings-plugin-entry" data-name="plugin-catalog-entry">
                          <div class="app-settings-plugin-entry-text">
                            <span class="app-settings-plugin-name" data-no-translate>
                              {e.name} {e.version}
                            </span>
                            <Capabilities list={e.provides} />
                            <Show when={e.description}>
                              <span class="app-settings-local-status" data-no-translate>{e.description}</span>
                            </Show>
                          </div>
                          <Show when={action()} fallback={<span class="app-settings-local-status">Installed</span>}>
                            {(a) => (
                              <button type="button" class="app-settings-btn" disabled={busy() === `catalog:${e.id}`} onClick={() => void take(`catalog:${e.id}`, plugins.installCatalog(e.id))}>
                                {a()}
                              </button>
                            )}
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </Section>
              )}
            </Show>
            <Show when={error()}>{(e) => <span class="app-settings-field-error">{e()}</span>}</Show>
            <Section label="PLUGIN API">
              <div class="app-settings-note app-settings-local-note">
                {s().listening
                  ? translateWith("Listening on 127.0.0.1:{0}, for the enabled plugins only.", String(s().port))
                  : translate("Listens while a plugin is enabled.")}
              </div>
            </Section>
            <Show when={s().error}>{(e) => <span class="app-settings-field-error">{e()}</span>}</Show>
            <label class="app-settings-field">
              <span class="app-settings-field-label">Port</span>
              <input
                class="app-settings-input"
                type="text"
                inputmode="numeric"
                data-name="plugins-port"
                value={port()}
                onInput={(e) => {
                  e.currentTarget.value = e.currentTarget.value.replace(/\D/g, "").slice(0, 5);
                  setPort(e.currentTarget.value);
                }}
                onBlur={applyPort}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyPort();
                }}
              />
            </label>
            <div class="app-settings-note app-settings-local-note">
              Developers: the protocol is described in{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); openLink(PROTOCOL, "plugin protocol"); }} data-no-translate>
                {PROTOCOL.split("/main/")[1]}
              </a>
              .
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

function Capabilities(props: { list: string[] }) {
  return (
    <span class="app-settings-plugin-badges">
      <For each={props.list}>{(c) => <span class="app-settings-plugin-badge">{capabilityLabel(c)}</span>}</For>
    </span>
  );
}

function PluginCard(props: { plugin: PluginInfo; busy: string | null; take: (what: string, p: Promise<Result<PluginsStatus>>) => Promise<boolean> }) {
  const p = () => props.plugin;
  const m = () => p().manifest;
  const [open, setOpen] = createSignal<"settings" | "logs" | null>(null);
  const [logs, setLogs] = createSignal<string[]>([]);
  const stateText = () => {
    if (!p().supported) return translate("Does not run on this computer");
    if (!p().enabled) return translate("Disabled");
    if (p().connected) return p().connectedVersion ? translateWith("Connected (version {0})", p().connectedVersion!) : translate("Connected");
    if (m().runtime.type === "process") return p().running ? translate("Starting…") : translate("Not running");
    return translate("Waiting for the plugin to connect");
  };
  let timer: number | undefined;
  const showLogs = () => {
    window.clearInterval(timer);
    if (open() === "logs") return setOpen(null);
    setOpen("logs");
    const load = () => void plugins.logs(m().id).then(setLogs);
    load();
    timer = window.setInterval(load, 2000);
  };
  onCleanup(() => window.clearInterval(timer));
  return (
    <section class="app-settings-local-folder app-settings-plugin" data-name="plugin">
      <div class="app-settings-local-head">
        <span class={`app-settings-plugin-dot${p().connected ? " is-on" : p().enabled ? " is-waiting" : ""}`} />
        <span class="app-settings-local-path" data-no-translate title={m().id}>
          {m().name} {m().version}
        </span>
        <Capabilities list={m().provides} />
        <Show when={!p().verified}>
          <span class="app-settings-plugin-badge is-warning" title={translate("Not signed by OpenTrader")}>
            Unverified
          </span>
        </Show>
      </div>
      <div class="app-settings-local-status" data-name="plugin-state">
        {stateText()}
        <Show when={m().publisher}>
          {" · "}
          <span data-no-translate>{m().publisher}</span>
        </Show>
      </div>
      <Show when={m().description}>
        <div class="app-settings-local-status" data-no-translate>{m().description}</div>
      </Show>
      <CheckField
        variant="settings"
        label={translate("Enabled")}
        disabled={!p().supported}
        checked={p().enabled}
        onChange={(on) => void props.take(`enable:${m().id}`, plugins.setEnabled(m().id, on))}
      />
      <For each={m().install ?? []}>{(step, i) => <InstallStepRow plugin={p()} step={step} index={i()} take={props.take} />}</For>
      <Show when={m().setup}>
        <div class="app-settings-plugin-setup" data-no-translate>{m().setup}</div>
      </Show>
      <div class="app-settings-local-head">
        <Show when={(m().settings ?? []).length > 0}>
          <button type="button" class="app-settings-btn" onClick={() => setOpen(open() === "settings" ? null : "settings")}>
            Settings
          </button>
        </Show>
        <button type="button" class="app-settings-btn" onClick={showLogs}>
          Log
        </button>
        <Show when={m().homepage}>
          {(url) => (
            <button type="button" class="app-settings-btn" onClick={() => openLink(url(), "plugin homepage")}>
              Website
            </button>
          )}
        </Show>
        <ConfirmButton label="New token" confirmLabel="The plugin connects again" onConfirm={() => void props.take(`token:${m().id}`, plugins.newToken(m().id))} />
        <ConfirmButton label="Remove" confirmLabel="Remove the plugin" onConfirm={() => void props.take(`remove:${m().id}`, plugins.remove(m().id))} />
      </div>
      <Show when={open() === "settings"}>
        <PluginSettings plugin={p()} take={props.take} />
      </Show>
      <Show when={open() === "logs"}>
        <pre class="app-settings-code app-settings-plugin-log" data-no-translate>{logs().join("\n") || "—"}</pre>
      </Show>
    </section>
  );
}

/** An installation step: copy one file of the plugin into folders the user picks (suggested ones checked). */
function InstallStepRow(props: { plugin: PluginInfo; step: InstallStep; index: number; take: (what: string, p: Promise<Result<PluginsStatus>>) => Promise<boolean> }) {
  const id = () => props.plugin.manifest.id;
  const [folders, setFolders] = createSignal<string[]>([]);
  const [chosen, setChosen] = createSignal<Set<string>>(new Set());
  const [error, setError] = createSignal<string | null>(null);
  void plugins.folderCandidates(id(), props.index).then((r) => {
    if (r.status !== "ok") return;
    setFolders(r.data);
    setChosen(new Set(r.data));
  });
  const fileName = () => props.step.copy.split(/[\\/]/).pop() ?? props.step.copy;
  const isCopied = (folder: string) => props.plugin.copied.some((c) => c.toLowerCase().startsWith(folder.toLowerCase()) && c.toLowerCase().endsWith(fileName().toLowerCase()));
  const browse = async () => {
    const r = await plugins.pickFolder(props.step.to.title);
    if (r.status === "error") return setError(r.error);
    if (!r.data) return;
    const f = r.data;
    setFolders((l) => (l.includes(f) ? l : [...l, f]));
    setChosen((s) => new Set([...s, f]));
  };
  const copy = async () => {
    setError(null);
    const ok = await props.take(`copy:${id()}`, plugins.copyFiles(id(), props.index, [...chosen()]));
    if (!ok) setError(translate("The file was not copied."));
  };
  return (
    <div class="app-settings-plugin-step" data-name="plugin-install-step">
      <span class="app-settings-field-label" data-no-translate>{props.step.to.title}</span>
      <For each={folders()} fallback={<span class="app-settings-local-status">No folder found: choose it.</span>}>
        {(f) => (
          <div class="app-settings-plugin-folder">
            <CheckField
              variant="settings"
              checked={chosen().has(f)}
              onChange={(on) =>
                setChosen((s) => {
                  const n = new Set(s);
                  if (on) n.add(f);
                  else n.delete(f);
                  return n;
                })
              }
            />
            <span class="app-settings-plugin-folder-path" data-no-translate title={f}>{f}</span>
            <Show when={isCopied(f)}>
              <span class="app-settings-local-status">Copied</span>
            </Show>
          </div>
        )}
      </For>
      <div class="app-settings-local-head">
        <button type="button" class="app-settings-btn" onClick={() => void browse()}>
          Choose folder…
        </button>
        <button type="button" class="app-settings-btn" data-name="plugin-copy" disabled={chosen().size === 0} onClick={() => void copy()}>
          {translateWith("Copy {0}", fileName())}
        </button>
      </div>
      <Show when={error()}>{(e) => <span class="app-settings-field-error">{e()}</span>}</Show>
    </div>
  );
}

/** The plugin's own settings form (its manifest's fields); saved and sent to the plugin with Apply. */
function PluginSettings(props: { plugin: PluginInfo; take: (what: string, p: Promise<Result<PluginsStatus>>) => Promise<boolean> }) {
  const m = () => props.plugin.manifest;
  const initial = () => {
    const v: Record<string, string> = {};
    for (const f of m().settings ?? []) v[f.key] = props.plugin.settings[f.key] ?? f.default ?? "";
    return v;
  };
  const [values, setValues] = createSignal<Record<string, string>>(initial());
  const set = (k: string, v: string) => setValues((o) => ({ ...o, [k]: v }));
  const field = (f: SettingField) => {
    switch (f.type) {
      case "bool":
        return <CheckField variant="settings" label={f.label} checked={values()[f.key] === "true"} onChange={(on) => set(f.key, on ? "true" : "false")} />;
      case "select":
        return (
          <label class="app-settings-field">
            <span class="app-settings-field-label" data-no-translate>{f.label}</span>
            <SelectControl
              value={values()[f.key]}
              options={(f.options ?? []).map((o) => o.value)}
              labelOf={(v) => (f.options ?? []).find((o) => o.value === v)?.label ?? v}
              width={240}
              onPick={(v) => set(f.key, v)}
            />
          </label>
        );
      default:
        return (
          <label class="app-settings-field">
            <span class="app-settings-field-label" data-no-translate>{f.label}</span>
            <input
              class="app-settings-input"
              type="text"
              inputmode={f.type === "number" ? "decimal" : undefined}
              value={values()[f.key]}
              onInput={(e) => set(f.key, e.currentTarget.value)}
            />
          </label>
        );
    }
  };
  return (
    <div class="app-settings-plugin-settings" data-name="plugin-settings" data-no-translate>
      <For each={m().settings ?? []}>
        {(f) => (
          <>
            {field(f)}
            <Show when={f.help}>
              <div class="app-settings-local-status">{f.help}</div>
            </Show>
          </>
        )}
      </For>
      <div class="app-settings-local-head">
        <button type="button" class="app-settings-btn" data-name="plugin-settings-apply" onClick={() => void props.take(`settings:${m().id}`, plugins.setSettings(m().id, values()))}>
          {translate("Apply")}
        </button>
      </div>
    </div>
  );
}
