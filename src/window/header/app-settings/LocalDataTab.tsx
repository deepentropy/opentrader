import { numberText } from "../../../i18n/format";
/*
 * Settings > Local data (#267): folders whose CSV files stay imported series (data/local-folders).
 */
import { createSignal, For, Show } from "solid-js";
import { CheckField, SelectControl } from "../../../components/form";
import {
  addLocalFolder,
  localFolderProgress,
  localFolders,
  removeLocalFolder,
  setLocalFolderOptions,
  syncLocalFolder,
  type LocalFolder,
} from "../../../data/local-folders";
import { TIMEZONES } from "../../../data/timezones";
import { pickFolder } from "./io";
import { Section } from "./parts";
import { translate, translatePlural, translateWith } from "../../../i18n/translator";

/** Zones a folder's times may be in: UTC and the chart's cities, one row per zone. */
const FOLDER_ZONES = TIMEZONES.filter((z) => z.label !== "Exchange").filter((z, i, all) => all.findIndex((y) => y.iana === z.iana) === i);
const zoneLabel = (iana: string) => FOLDER_ZONES.find((z) => z.iana === iana)?.label ?? iana;

/** "09/11/2026 14:05". */
function syncTime(ms: number): string {
  const d = new Date(ms);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const thousands = (v: number) => numberText(v);

export function LocalDataTab() {
  const [zone, setZone] = createSignal("UTC");
  const [error, setError] = createSignal<string | null>(null);
  const add = async () => {
    setError(null);
    const r = await pickFolder();
    if ("error" in r) return setError(r.error);
    if (!r.path) return;
    if (!addLocalFolder(r.path, zone())) return setError(`${r.path} is synced already.`);
    void syncLocalFolder(r.path).catch((e) => setError(String(e)));
  };
  return (
    <div class="app-settings-network app-settings-local-data">
      <Section label="LOCAL DATA FOLDERS">
        <div class="app-settings-note app-settings-local-note">
          The CSV files at the top of a folder are imported series, LOCAL:&lt;file name&gt;, with the descriptions of its symbol_info JSON. When the app
          starts and every 5 minutes, new and changed files are imported again; unchanged files are not read.
        </div>
      </Section>
      <For each={localFolders()}>{(f) => <LocalFolderCard folder={f} />}</For>
      <div class="app-settings-local-add">
        <span class="app-settings-field-label">Times without an offset are in</span>
        <SelectControl value={zone()} options={FOLDER_ZONES.map((z) => z.iana)} labelOf={zoneLabel} width={200} onPick={setZone} />
        <button type="button" class="app-settings-btn" data-name="add-local-folder" onClick={() => void add()}>
          Add folder…
        </button>
      </div>
      <Show when={error()}>{(e) => <span class="app-settings-field-error">{e()}</span>}</Show>
    </div>
  );
}

/** Errors listed under a folder; the others are counted. */
const SHOWN_ERRORS = 50;

function LocalFolderCard(props: { folder: LocalFolder }) {
  const f = () => props.folder;
  const progress = () => {
    const p = localFolderProgress();
    return p && p.path === f().path ? p : null;
  };
  const statusText = () => {
    const s = f().status;
    if (!s) return translate("Not synced yet.");
    if (s.failed) return translateWith("Last sync {0}: {1}", syncTime(s.at), s.failed);
    const parts = [
      translatePlural(s.scanned, { one: "{0} file", other: "{0} files" }, thousands(s.scanned)),
      translateWith("{0} imported ({1} bars)", thousands(s.imported), thousands(s.bars)),
      translateWith("{0} unchanged", thousands(s.unchanged)),
    ];
    if (f().removeDeleted) parts.push(translateWith("{0} removed", thousands(s.removed)));
    parts.push(translateWith("{0} not imported", thousands(s.errors.length)));
    return translateWith("Last sync {0}: {1}.", syncTime(s.at), parts.join(", "));
  };
  const errors = () => f().status?.errors ?? [];
  return (
    <section class="app-settings-local-folder" data-name="local-folder">
      <div class="app-settings-local-head">
        <span class="app-settings-local-path" title={f().path}>
          {f().path}
        </span>
        <button type="button" class="app-settings-btn" data-name="sync-local-folder" disabled={!!progress()} onClick={() => void syncLocalFolder(f().path).catch(() => {})}>
          Sync now
        </button>
        <button type="button" class="app-settings-btn" title="Its series stay" onClick={() => removeLocalFolder(f().path)}>
          Remove
        </button>
      </div>
      <div class="app-settings-local-row">
        <span class="app-settings-field-label">Times without an offset are in</span>
        <SelectControl
          value={f().timeZone}
          options={FOLDER_ZONES.map((z) => z.iana)}
          labelOf={zoneLabel}
          width={240}
          onPick={(z) => setLocalFolderOptions(f().path, { timeZone: z })}
        />
      </div>
      <CheckField variant="settings"
        label="Remove a series when its file is deleted from the folder"
        checked={f().removeDeleted}
        onChange={() => setLocalFolderOptions(f().path, { removeDeleted: !f().removeDeleted })}
      />
      <div class="app-settings-local-status" data-name="local-folder-status">
        <Show when={progress()} fallback={statusText()}>
          {(p) => `Syncing: ${thousands(p().done)} of ${thousands(p().total)} files…`}
        </Show>
      </div>
      <Show when={!progress() && errors().length > 0}>
        <div class="app-settings-local-errors">
          <For each={errors().slice(0, SHOWN_ERRORS)}>
            {(e) => (
              <div class="app-settings-local-error">
                <span class="app-settings-local-error-file" title={e.file}>
                  {e.file}
                </span>
                <span>{e.message}</span>
              </div>
            )}
          </For>
          <Show when={errors().length > SHOWN_ERRORS}>
            <div class="app-settings-local-error">{translateWith("and {0} more", thousands(errors().length - SHOWN_ERRORS))}</div>
          </Show>
        </div>
      </Show>
    </section>
  );
}
