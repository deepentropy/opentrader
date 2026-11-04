/*
 * Import trades: a CSV file read into the trade journal. The columns are
 * guessed from the header and can be changed; the preview shows the first
 * trades as they will be read, and the rows that cannot be.
 *
 * pickTradeFile opens the file picker (the panel's Import button, the tab
 * menu); ImportTradesHost, mounted with the footer panel, shows the dialog.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import {
  FIELDS,
  buildStrategyTesterTrades,
  buildTrades,
  detectDelimiter,
  effectiveOrder,
  guessMapping,
  isStrategyTesterExport,
  parseCsv,
  type DateOrder,
  type Field,
  type Mapping,
  type Stamp,
} from "../../data/trade-journal-csv";
import { tradeJournal } from "../../data/trade-journal";
import { showNotice } from "../../components/Dialogs";

type Props = {
  fileName: string;
  text: string;
  /** Symbol of every trade when the file has no symbol column (the active chart's). */
  defaultSymbol: string;
  chartTimeZone: { label: string; iana: string };
  onClose: () => void;
};

/** The file picked, waiting for the dialog. */
const [picked, setPicked] = createSignal<{ fileName: string; text: string } | null>(null);

/** Open the file picker; the file chosen opens the Import trades dialog. */
export function pickTradeFile(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,.tsv,.txt,text/csv";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (file) setPicked({ fileName: file.name, text: await file.text() });
  };
  input.click();
}

/** The Import trades dialog of the picked file. */
export function ImportTradesHost(props: { defaultSymbol: string; chartTimeZone: { label: string; iana: string } }) {
  return (
    <Show when={picked()}>
      {(f) => (
        <ImportTradesDialog
          fileName={f().fileName}
          text={f().text}
          defaultSymbol={props.defaultSymbol}
          chartTimeZone={props.chartTimeZone}
          onClose={() => setPicked(null)}
        />
      )}
    </Show>
  );
}

const ORDER_LABELS: Record<DateOrder, string> = { ymd: "Year-month-day", mdy: "Month/day/year", dmy: "Day/month/year" };
const PREVIEW_ROWS = 5;

const pad2 = (n: number) => String(n).padStart(2, "0");
function stampText(s: Stamp): string {
  if (s.kind === "utc") {
    const d = new Date(s.sec * 1000);
    return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
  }
  const date = `${pad2(s.d)}/${pad2(s.m + 1)}/${s.y}`;
  return s.dateOnly ? date : `${date} ${pad2(s.h)}:${pad2(s.mi)}`;
}

export function ImportTradesDialog(props: Props) {
  const delimiter = detectDelimiter(props.text);
  const rows = parseCsv(props.text, delimiter);
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  const stExport = isStrategyTesterExport(headers);

  const [mapping, setMapping] = createSignal<Mapping>(guessMapping(headers));
  const [name, setName] = createSignal(props.fileName.replace(/\.[^.]+$/, "") || "Trades");
  const [dest, setDest] = createSignal<string>("new");
  const [symbol, setSymbol] = createSignal(props.defaultSymbol.split(":").pop() ?? "");
  const [order, setOrder] = createSignal<DateOrder | "auto">("auto");
  const [zone, setZone] = createSignal<string>("exchange");
  const [decimalComma, setDecimalComma] = createSignal(delimiter === ";");
  const [busy, setBusy] = createSignal(false);

  const detected = createMemo(() => effectiveOrder(body, mapping(), null));
  const result = createMemo(() =>
    stExport
      ? buildStrategyTesterTrades(headers, body, symbol())
      : buildTrades(body, mapping(), { order: order() === "auto" ? null : (order() as DateOrder), symbol: symbol(), decimalComma: decimalComma() }),
  );
  const needsSymbol = () => stExport || mapping().symbol === undefined;
  const missing = createMemo(() => {
    if (headers.length === 0) return "The file is empty.";
    if (stExport) return symbol().trim() ? null : "Enter the symbol of these trades.";
    const m = mapping();
    if (m.entry === undefined) return "Choose the entry date column.";
    if (m.exit === undefined) return "Choose the exit date column.";
    if (m.symbol === undefined && !symbol().trim()) return "Choose the symbol column or enter a symbol.";
    return null;
  });
  const canImport = () => !busy() && !missing() && result().trades.length > 0;

  const setField = (f: Field, v: string) => {
    const next = { ...mapping() };
    if (v === "") delete next[f];
    else next[f] = Number(v);
    setMapping(next);
  };

  async function submit() {
    if (!canImport()) return;
    setBusy(true);
    try {
      const into = dest() === "new" ? undefined : dest();
      const r = await tradeJournal.importTrades(result().trades, { name: name().trim() || "Trades", zone: zone(), into });
      props.onClose();
      const notes: string[] = [];
      if (r.unknown.length) notes.push(`Unknown symbols, kept without values: ${r.unknown.join(", ")}.`);
      if (r.dropped) notes.push(`${r.dropped} trade(s) left out: exit before entry.`);
      if (result().errors.length) notes.push(`${result().errors.length} row(s) could not be read.`);
      if (notes.length) showNotice({ title: `${r.added} trades imported`, text: notes.join(" ") });
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
        <div class="ot-dlg tj-import" role="dialog" aria-label="Import trades">
          <div class="ot-dlg-title">Import trades</div>
          <button type="button" class="ot-dlg-close" aria-label="close" onClick={props.onClose}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
              <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
            </svg>
          </button>
          <div class="ot-dlg-content tj-import-body">
            <div class="tj-form">
              <label class="tj-form-label">Add to</label>
              <select class="tj-select" value={dest()} onChange={(e) => setDest(e.currentTarget.value)}>
                <option value="new">New journal</option>
                <For each={tradeJournal.journals()}>{(j) => <option value={j.id}>{j.name}</option>}</For>
              </select>
              <Show when={dest() === "new"}>
                <label class="tj-form-label">Name</label>
                <input class="tj-input" type="text" value={name()} maxLength={64} onInput={(e) => setName(e.currentTarget.value)} />
              </Show>
              <Show when={needsSymbol()}>
                <label class="tj-form-label">{stExport ? "Symbol" : "Symbol of every trade"}</label>
                <input class="tj-input" type="text" value={symbol()} onInput={(e) => setSymbol(e.currentTarget.value.toUpperCase())} />
              </Show>
              <label class="tj-form-label">Times are in</label>
              <select class="tj-select" value={zone()} onChange={(e) => setZone(e.currentTarget.value)}>
                <option value="exchange">Exchange time zone</option>
                <option value="UTC">UTC</option>
                <Show when={props.chartTimeZone.iana !== "UTC"}>
                  <option value={props.chartTimeZone.iana}>Chart time zone ({props.chartTimeZone.label})</option>
                </Show>
              </select>
              <Show when={!stExport}>
                <label class="tj-form-label">Dates</label>
                <select class="tj-select" value={order()} onChange={(e) => setOrder(e.currentTarget.value as DateOrder | "auto")}>
                  <option value="auto">Detect ({ORDER_LABELS[detected()]})</option>
                  <For each={Object.keys(ORDER_LABELS) as DateOrder[]}>{(o) => <option value={o}>{ORDER_LABELS[o]}</option>}</For>
                </select>
                <label class="tj-form-label">Decimal separator</label>
                <select class="tj-select" value={decimalComma() ? "," : "."} onChange={(e) => setDecimalComma(e.currentTarget.value === ",")}>
                  <option value=".">Point (1234.50)</option>
                  <option value=",">Comma (1234,50)</option>
                </select>
              </Show>
            </div>

            <Show
              when={!stExport}
              fallback={<div class="tj-import-note">Strategy Tester list of trades: entries and exits are paired by trade number.</div>}
            >
              <div class="tj-section-title">Columns</div>
              <div class="tj-mapping">
                <For each={FIELDS}>
                  {(f) => (
                    <>
                      <label class="tj-form-label">
                        {f.label}
                        <Show when={f.required}>
                          <span class="tj-required">*</span>
                        </Show>
                      </label>
                      <select class="tj-select" value={mapping()[f.id] ?? ""} onChange={(e) => setField(f.id, e.currentTarget.value)}>
                        <option value="">—</option>
                        <For each={headers}>{(h, i) => <option value={i()}>{h || `Column ${i() + 1}`}</option>}</For>
                      </select>
                    </>
                  )}
                </For>
              </div>
            </Show>

            <div class="tj-section-title">
              Preview <span class="tj-muted">{result().trades.length} trades</span>
            </div>
            <div class="tj-preview">
              <div class="tj-preview-row tj-preview-head">
                <span>Symbol</span>
                <span>Side</span>
                <span>Entry</span>
                <span>Exit</span>
                <span class="is-end">Qty</span>
                <span class="is-end">Entry price</span>
                <span class="is-end">Exit price</span>
              </div>
              <For each={result().trades.slice(0, PREVIEW_ROWS)}>
                {(t) => (
                  <div class="tj-preview-row">
                    <span>{t.symbol}</span>
                    <span class={t.side === "long" ? "st-side-long" : "st-side-short"}>{t.side === "long" ? "Long" : "Short"}</span>
                    <span>{stampText(t.entry)}</span>
                    <span>{stampText(t.exit)}</span>
                    <span class="is-end">{t.qty ?? "—"}</span>
                    <span class="is-end">{t.entryPrice ?? "—"}</span>
                    <span class="is-end">{t.exitPrice ?? "—"}</span>
                  </div>
                )}
              </For>
            </div>
            <Show when={result().errors.length > 0}>
              <div class="tj-import-errors">
                {result().errors.length} row(s) will be left out:{" "}
                {result()
                  .errors.slice(0, 3)
                  .map((e) => (e.row ? `row ${e.row}: ${e.message}` : e.message))
                  .join("; ")}
                {result().errors.length > 3 ? "…" : ""}
              </div>
            </Show>
            <Show when={missing()}>
              <div class="tj-import-errors">{missing()}</div>
            </Show>
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
