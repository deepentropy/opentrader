/*
 * Import CSV (#266): bar files read into imported series ("LOCAL:<NAME>"
 * symbols, see data/local-series). Opened from the Local tab of the symbol
 * search. Several files at once; a Pine Seeds `symbol_info` JSON picked with
 * them gives their descriptions and price grids. The dialog shows what each
 * file holds (bars, bar size, dates) in the chosen time zone before importing.
 *
 * pickSeriesFiles opens the file picker; ImportSeriesHost shows the dialog.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { parseBarsCsv, parseSeedSymbolInfo, ROW, SERIES_NAME, seriesNameFromFile, type ParsedBars } from "../../data/local-series-csv";
import { importLocalSeries, localSeriesList } from "../../data/local-series";
import { TIMEZONES } from "../../data/timezones";
import { showNotice } from "../../components/Dialogs";

type SeedInfo = ReturnType<typeof parseSeedSymbolInfo>;
type Picked = { files: { fileName: string; text: string }[]; info: SeedInfo };

/** The files picked, waiting for the dialog. */
const [picked, setPicked] = createSignal<Picked | null>(null);

/** Open the file picker (CSV files, and a Pine Seeds symbol_info JSON);
 *  the files chosen open the Import CSV dialog. */
export function pickSeriesFiles(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".csv,.tsv,.txt,.json,text/csv,application/json";
  input.onchange = async () => {
    const all = [...(input.files ?? [])];
    const files: Picked["files"] = [];
    const info: SeedInfo = new Map();
    for (const f of all) {
      const text = await f.text();
      if (/\.json$/i.test(f.name)) {
        try {
          for (const [k, v] of parseSeedSymbolInfo(text)) info.set(k, v);
        } catch {
          showNotice({ title: "Import CSV", text: `${f.name} is not a symbol_info file.` });
        }
      } else files.push({ fileName: f.name, text });
    }
    if (files.length > 0) setPicked({ files, info });
    else if (all.length > 0) showNotice({ title: "Import CSV", text: "Pick the CSV files of the bars (with their symbol_info JSON, if any)." });
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

type Entry = { fileName: string; text: string; name: () => string; setName: (v: string) => void; description: () => string; setDescription: (v: string) => void; pricescale?: number };

function ImportSeriesDialog(props: { picked: Picked; onClose: () => void }) {
  const [zone, setZone] = createSignal("UTC");
  const [busy, setBusy] = createSignal(false);
  const entries: Entry[] = props.picked.files.map((f) => {
    const guess = seriesNameFromFile(f.fileName);
    const seed = props.picked.info.get(guess);
    const [name, setName] = createSignal(guess);
    const [description, setDescription] = createSignal(seed?.description ?? "");
    return { ...f, name, setName, description, setDescription, pricescale: seed?.pricescale };
  });

  /** Each file read in the chosen zone: its bars, or why it holds none. */
  const parsed = createMemo(() =>
    entries.map((e): ParsedBars | string => {
      try {
        return parseBarsCsv(e.text, zone());
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }),
  );
  const existing = () => new Set(localSeriesList().map((s) => s.name));
  const problem = (i: number): string | null => {
    const name = entries[i].name().trim().toUpperCase();
    if (!SERIES_NAME.test(name)) return "A name is 1 to 42 characters: A-Z, 0-9, '.', '_' or '-'.";
    if (entries.some((e, j) => j !== i && e.name().trim().toUpperCase() === name)) return "Two files have this name.";
    const p = parsed()[i];
    return typeof p === "string" ? p : null;
  };
  const canImport = () => !busy() && entries.every((_, i) => problem(i) === null);

  const summary = (p: ParsedBars): string => {
    const n = p.rows.length / ROW;
    const first = dateText(p.rows[0], zone());
    const last = dateText(p.rows[(n - 1) * ROW], zone());
    return `${n.toLocaleString("en-US")} bars of ${baseText(p.base)}, ${first} to ${last}${p.hasVolume ? "" : ", no volume"}`;
  };

  async function submit() {
    if (!canImport()) return;
    setBusy(true);
    const notes: string[] = [];
    try {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const r = await importLocalSeries({
          name: e.name(),
          csv: parsed()[i] as ParsedBars,
          timeZone: zone(),
          description: e.description(),
          pricescale: e.pricescale,
        });
        if (r.skipped) notes.push(`${r.series.name}: ${r.skipped} line(s) were not bars and were left out.`);
      }
      props.onClose();
      if (notes.length) showNotice({ title: "Series imported", text: notes.join(" ") });
    } catch (err) {
      showNotice({ title: "Import CSV", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
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

  return (
    <Portal mount={document.body}>
      <div class="ot-dlg-layer" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <div class="ot-dlg tj-import ls-import" role="dialog" aria-label="Import CSV" data-name="import-series-dialog">
          <div class="ot-dlg-title">Import CSV</div>
          <button type="button" class="ot-dlg-close" aria-label="close" onClick={props.onClose}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
              <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
            </svg>
          </button>
          <div class="ot-dlg-content tj-import-body">
            <div class="tj-form">
              <label class="tj-form-label">Times without an offset are in</label>
              <select class="tj-select" value={zone()} onChange={(e) => setZone(e.currentTarget.value)}>
                <For each={ZONES}>{(z) => <option value={z.iana}>{z.label}</option>}</For>
              </select>
            </div>
            <div class="tj-import-note">
              Columns: time, open, high, low, close and volume (or one value). A header line is optional; dates, ISO times and UNIX times are read.
              The series opens as LOCAL:&lt;name&gt; and has no live data.
            </div>
            <For each={entries}>
              {(e, i) => (
                <div class="ls-import-file">
                  <div class="tj-section-title">{e.fileName}</div>
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
                        <Show when={existing().has(e.name().trim().toUpperCase())}>
                          <span class="tj-muted"> (replaces the series of this name)</span>
                        </Show>
                      </div>
                    }
                  >
                    {(msg) => <div class="tj-import-errors">{msg()}</div>}
                  </Show>
                </div>
              )}
            </For>
          </div>
          <div class="ot-dlg-footer">
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
              {busy() ? "Importing…" : "Import"}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
