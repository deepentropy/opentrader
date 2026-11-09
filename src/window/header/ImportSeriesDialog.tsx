/*
 * Import CSV (#266): bar files read into imported series ("LOCAL:<NAME>"
 * symbols, see data/local-series). Opened from the Local tab of the symbol
 * search, for picked files or the files at the top of a folder (#267); a Pine
 * Seeds `symbol_info` JSON among them gives their descriptions and price grids.
 *
 * A few files are read at once and each shows what it holds (bars, bar size,
 * dates) in the chosen time zone, under a name and description the user can
 * change; a file that holds no bars, or one the user skips, is left out. More
 * files take their names from the file names and are read one at a time while
 * importing (read, parse, store), so thousands of files never sit in memory
 * together. A summary lists the files that could not be imported, and why.
 *
 * In the desktop app a folder can be kept in sync (data/local-folders).
 *
 * pickSeriesFiles / pickSeriesFolder open the pickers; ImportSeriesHost shows the dialog.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { commands, type LocalSource } from "../../bindings";
import { parseBarsCsv, parseSeedSymbolInfo, ROW, SERIES_NAME, seriesNameFromFile, type ParsedBars } from "../../data/local-series-csv";
import { importLocalSeries, localSeriesChanged, localSeriesList } from "../../data/local-series";
import { addLocalFolder, syncLocalFolder } from "../../data/local-folders";
import { TIMEZONES } from "../../data/timezones";
import { showNotice } from "../../components/Dialogs";
import { isTauri } from "../shell/window-bridge";

type SeedInfo = ReturnType<typeof parseSeedSymbolInfo>;
/** A bar file to import: its text is read when needed. `text` is set for the
 *  few files previewed at once. */
type PickedFile = { fileName: string; read: () => Promise<string>; text?: string; readError?: string; source?: LocalSource };
type Picked = { files: PickedFile[]; info: SeedInfo; folder?: string };

/** Up to this many files, each is previewed and can be renamed. */
const PREVIEW_MAX = 20;

/** The files picked, waiting for the dialog. */
const [picked, setPicked] = createSignal<Picked | null>(null);

const isInfoFile = (name: string) => /\.json$/i.test(name);
const isBarFile = (name: string) => /\.(csv|tsv|txt)$/i.test(name);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Read the symbol_info files, then open the dialog (the files' texts read
 *  first when they are few). */
async function open(bars: PickedFile[], infos: { fileName: string; read: () => Promise<string> }[], folder?: string): Promise<void> {
  const info: SeedInfo = new Map();
  for (const f of infos) {
    try {
      for (const [k, v] of parseSeedSymbolInfo(await f.read())) info.set(k, v);
    } catch {
      showNotice({ title: "Import CSV", text: `${f.fileName} is not a symbol_info file.` });
    }
  }
  if (bars.length === 0) {
    showNotice({ title: "Import CSV", text: folder !== undefined ? "The folder has no CSV file." : "Pick the CSV files of the bars (with their symbol_info JSON, if any)." });
    return;
  }
  if (bars.length <= PREVIEW_MAX) {
    for (const f of bars) {
      try {
        f.text = await f.read();
      } catch (e) {
        f.readError = message(e);
      }
    }
  }
  setPicked({ files: bars, info, folder });
}

/** Open the file picker (CSV files, and a Pine Seeds symbol_info JSON);
 *  the files chosen open the Import CSV dialog. */
export function pickSeriesFiles(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".csv,.tsv,.txt,.json,text/csv,application/json";
  input.onchange = () => {
    const all = [...(input.files ?? [])].map((f) => ({ fileName: f.name, read: () => f.text() }));
    if (all.length === 0) return;
    void open(all.filter((f) => !isInfoFile(f.fileName)), all.filter((f) => isInfoFile(f.fileName)));
  };
  input.click();
}

/** Open a folder: its CSV files (not those of its subfolders) and its
 *  symbol_info JSON. The desktop app remembers where each file comes from, so
 *  the folder can be kept in sync. */
export async function pickSeriesFolder(): Promise<void> {
  if (isTauri()) {
    const r = await commands.localFolderPick();
    if (r.status === "error") return void showNotice({ title: "Import folder", text: r.error });
    const folder = r.data;
    if (!folder) return;
    const scan = await commands.localFolderScan(folder);
    if (scan.status === "error") return void showNotice({ title: "Import folder", text: scan.error });
    const read = (file: string) => async () => {
      const t = await commands.localFolderRead(folder, file);
      if (t.status === "error") throw new Error(t.error);
      return t.data;
    };
    const files = scan.data.map((f) => ({ fileName: f.file, read: read(f.file), source: { folder, file: f.file, mtime: f.mtime, size: f.size } }));
    await open(files.filter((f) => !isInfoFile(f.fileName)), files.filter((f) => isInfoFile(f.fileName)), folder);
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.webkitdirectory = true;
  input.onchange = () => {
    // The top of the folder: "folder/file.csv".
    const top = [...(input.files ?? [])].filter((f) => f.webkitRelativePath.split("/").length === 2);
    const files = top.map((f) => ({ fileName: f.name, read: () => f.text() }));
    void open(files.filter((f) => isBarFile(f.fileName)), files.filter((f) => isInfoFile(f.fileName)), "");
  };
  input.click();
}

export function ImportSeriesHost() {
  return <Show when={picked()}>{(p) => <ImportSeriesDialog picked={p()} onClose={() => setPicked(null)} />}</Show>;
}

/** The time zones offered: UTC and the cities of the chart's list. */
const ZONES = TIMEZONES.filter((z) => z.label !== "Exchange");

/** "5 minutes", "1 day", "30 seconds". */
function baseText(base: string): string {
  const m = /^(\d+)([SD]?)$/.exec(base);
  if (!m) return base;
  const n = Number(m[1]);
  const unit = m[2] === "S" ? "second" : m[2] === "D" ? "day" : "minute";
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function dateText(sec: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(sec * 1000));
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

type Entry = PickedFile & {
  name: () => string;
  setName: (v: string) => void;
  description: () => string;
  setDescription: (v: string) => void;
  pricescale?: number;
  skip: () => boolean;
  setSkip: (v: boolean) => void;
};

type Result = { imported: number; failed: { file: string; message: string }[]; notes: string[]; stopped: boolean };

function ImportSeriesDialog(props: { picked: Picked; onClose: () => void }) {
  const [zone, setZone] = createSignal("UTC");
  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal(0);
  const [result, setResult] = createSignal<Result | null>(null);
  const [keepInSync, setKeepInSync] = createSignal(false);
  const preview = props.picked.files.length <= PREVIEW_MAX;
  const entries: Entry[] = props.picked.files.map((f) => {
    const guess = seriesNameFromFile(f.fileName);
    const seed = props.picked.info.get(guess);
    const [name, setName] = createSignal(guess);
    const [description, setDescription] = createSignal(seed?.description ?? "");
    const [skip, setSkip] = createSignal(false);
    return { ...f, name, setName, description, setDescription, pricescale: seed?.pricescale, skip, setSkip };
  });
  const total = entries.length;
  let closed = false;
  onCleanup(() => (closed = true));

  /** Each previewed file read in the chosen zone: its bars, or why it holds none. */
  const parsed = createMemo(() =>
    preview
      ? entries.map((e): ParsedBars | string => {
          if (e.text === undefined) return e.readError ?? "The file could not be read.";
          try {
            return parseBarsCsv(e.text, zone());
          } catch (err) {
            return message(err);
          }
        })
      : [],
  );
  const existing = createMemo(() => new Set(localSeriesList().map((s) => s.name)));
  const nameOf = (e: Entry) => e.name().trim().toUpperCase();
  const problem = (i: number): string | null => {
    const name = nameOf(entries[i]);
    if (!SERIES_NAME.test(name)) return "A name is 1 to 42 characters: A-Z, 0-9, '.', '_' or '-'.";
    if (entries.some((e, j) => j !== i && !e.skip() && nameOf(e) === name)) return "Two files have this name.";
    const p = parsed()[i];
    return typeof p === "string" ? p : null;
  };
  /** The files to import: not skipped and, previewed, holding bars. */
  const chosen = () => entries.filter((e, i) => !e.skip() && (!preview || problem(i) === null));
  const canImport = () => !busy() && chosen().length > 0;

  const summary = (p: ParsedBars): string => {
    const n = p.rows.length / ROW;
    const first = dateText(p.rows[0], zone());
    const last = dateText(p.rows[(n - 1) * ROW], zone());
    return `${n.toLocaleString("en-US")} bars of ${baseText(p.base)}, ${first} to ${last}${p.hasVolume ? "" : ", no volume"}`;
  };

  async function submit() {
    if (!canImport()) return;
    setBusy(true);
    const files = chosen();
    const r: Result = { imported: 0, failed: [], notes: [], stopped: false };
    const names: string[] = [];
    const taken = new Set<string>();
    for (let i = 0; i < files.length; i++) {
      if (closed) {
        r.stopped = true;
        break;
      }
      setDone(i);
      const e = files[i];
      const name = nameOf(e);
      if (taken.has(name)) {
        r.failed.push({ file: e.fileName, message: `Another file is LOCAL:${name}.` });
        continue;
      }
      taken.add(name);
      try {
        const index = entries.indexOf(e);
        const csv = preview ? (parsed()[index] as ParsedBars) : await e.read();
        const out = await importLocalSeries({
          name,
          csv,
          timeZone: zone(),
          description: e.description(),
          pricescale: e.pricescale,
          source: e.source ?? null,
          deferRefresh: true,
        });
        r.imported++;
        names.push(out.series.name);
        if (out.skipped) r.notes.push(`${out.series.name}: ${count(out.skipped, "line")} were not bars and were left out.`);
      } catch (err) {
        r.failed.push({ file: e.fileName, message: message(err) });
      }
    }
    setDone(files.length);
    await localSeriesChanged(names).catch(() => {});
    const folder = props.picked.folder;
    if (keepInSync() && folder && !r.stopped) {
      // The files just imported are unchanged for the folder's first sync.
      addLocalFolder(folder, zone());
      void syncLocalFolder(folder).catch(() => {});
    }
    setBusy(false);
    if (closed) return;
    if (r.failed.length || r.notes.length) setResult(r);
    else props.onClose();
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const title = props.picked.folder !== undefined ? "Import folder" : "Import CSV";
  return (
    <Portal mount={document.body}>
      <div class="ot-dlg-layer" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <div class="ot-dlg tj-import ls-import" role="dialog" aria-label={title} data-name="import-series-dialog">
          <div class="ot-dlg-title">{title}</div>
          <button type="button" class="ot-dlg-close" aria-label="close" onClick={props.onClose}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
              <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
            </svg>
          </button>
          <Show
            when={result()}
            fallback={
              <div class="ot-dlg-content tj-import-body">
                <Show when={props.picked.folder}>{(f) => <div class="ls-import-folder">{f()}</div>}</Show>
                <div class="tj-form">
                  <label class="tj-form-label">Times without an offset are in</label>
                  <select class="tj-select" value={zone()} disabled={busy()} onChange={(e) => setZone(e.currentTarget.value)}>
                    <For each={ZONES}>{(z) => <option value={z.iana}>{z.label}</option>}</For>
                  </select>
                </div>
                <Show when={isTauri() && props.picked.folder}>
                  <label class="ls-import-sync">
                    <input type="checkbox" checked={keepInSync()} disabled={busy()} onChange={(e) => setKeepInSync(e.currentTarget.checked)} />
                    Keep this folder in sync: new and changed files are imported again (Settings &gt; Local data)
                  </label>
                </Show>
                <div class="tj-import-note">
                  Columns: time, open, high, low, close and volume (or one value). A header line is optional; dates, ISO times and UNIX times are read.
                  The series opens as LOCAL:&lt;name&gt; and has no live data.
                  <Show when={!preview}> Each file's series is named after the file.</Show>
                </div>
                <Show
                  when={preview}
                  fallback={
                    <>
                      <div class="tj-section-title">{count(total, "file")}</div>
                      <div class="ls-import-list" data-name="import-series-list">
                        <For each={entries}>
                          {(e) => (
                            <div class="ls-import-list-row">
                              <span class="ls-import-list-file" title={e.fileName}>{e.fileName}</span>
                              <span>
                                LOCAL:{e.name()}
                                <Show when={existing().has(e.name())}>
                                  <span class="tj-muted"> (replaces)</span>
                                </Show>
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </>
                  }
                >
                  <For each={entries}>
                    {(e, i) => (
                      <div class={`ls-import-file${e.skip() ? " is-skipped" : ""}`}>
                        <div class="ls-import-file-head">
                          <span class="tj-section-title">{e.fileName}</span>
                          <button type="button" class="ls-import-skip" data-name="skip-file" disabled={busy()} onClick={() => e.setSkip(!e.skip())}>
                            {e.skip() ? "Include" : "Skip"}
                          </button>
                        </div>
                        <Show when={!e.skip()} fallback={<div class="tj-muted">Skipped</div>}>
                          <div class="tj-form">
                            <label class="tj-form-label">Symbol</label>
                            <div class="ls-import-symbol">
                              <span class="tj-muted">LOCAL:</span>
                              <input class="tj-input" type="text" value={e.name()} maxLength={42} onInput={(ev) => e.setName(ev.currentTarget.value.toUpperCase())} />
                            </div>
                            <label class="tj-form-label">Description</label>
                            <input class="tj-input" type="text" value={e.description()} maxLength={128} onInput={(ev) => e.setDescription(ev.currentTarget.value)} />
                          </div>
                          <Show
                            when={problem(i())}
                            fallback={
                              <div class="ls-import-summary">
                                {summary(parsed()[i()] as ParsedBars)}
                                <Show when={existing().has(nameOf(e))}>
                                  <span class="tj-muted"> (replaces the series of this name)</span>
                                </Show>
                              </div>
                            }
                          >
                            {(msg) => <div class="tj-import-errors">{msg()} The file is left out.</div>}
                          </Show>
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            }
          >
            {(r) => (
              <div class="ot-dlg-content tj-import-body" data-name="import-series-result">
                <div class="ls-import-result-head">
                  {count(r().imported, "series", "series")} imported
                  <Show when={r().failed.length}>, {count(r().failed.length, "file")} not imported</Show>.
                </div>
                <Show when={r().failed.length}>
                  <div class="ls-import-list">
                    <For each={r().failed}>
                      {(f) => (
                        <div class="ls-import-list-row">
                          <span class="ls-import-list-file" title={f.file}>{f.file}</span>
                          <span class="tj-import-errors">{f.message}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <For each={r().notes}>{(n) => <div class="tj-import-note">{n}</div>}</For>
              </div>
            )}
          </Show>
          <div class="ot-dlg-footer">
            <Show
              when={!result()}
              fallback={
                <button type="button" class="ot-dlg-btn is-main is-neutral" onClick={props.onClose}>
                  Close
                </button>
              }
            >
              <Show when={busy() && !preview}>
                <span class="ls-import-progress" data-name="import-progress">
                  Importing {done().toLocaleString("en-US")} of {chosen().length.toLocaleString("en-US")}…
                </span>
              </Show>
              <button type="button" class="ot-dlg-btn is-secondary" onClick={props.onClose}>
                Cancel
              </button>
              <button
                type="button"
                class="ot-dlg-btn is-main is-neutral"
                data-name="submit-button"
                aria-disabled={!canImport()}
                disabled={!canImport()}
                onClick={() => void submit()}
              >
                {busy() ? "Importing…" : chosen().length === total ? "Import" : `Import ${chosen().length} of ${total}`}
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
