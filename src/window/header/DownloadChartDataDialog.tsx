/*
 * "Download chart data" dialog (Manage layouts menu), as the reference app's
 * export dialog: a description, the Chart select (the charts of the layout,
 * the active one first selected; disabled with one chart) and the
 * "Time format (<zone>)" select (ISO time / UNIX timestamp, remembered,
 * UNIX by default). Download saves the chart's CSV (chart-export.ts).
 */
import { createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { SelectControl } from "./ChartPropertiesDialog";
import {
  buildChartCsv,
  exportableCharts,
  exportFileName,
  exportZoneLabel,
  type ExportTimeFormat,
} from "../chart/chart-export";
import * as kv from "../../data/kv";

const FORMAT_KEY = "ot:export-time-format";
const FORMAT_LABEL: Record<ExportTimeFormat, string> = { iso: "ISO time", unix: "UNIX timestamp" };

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function DownloadChartDataDialog(props: { onClose: () => void }) {
  const charts = exportableCharts();
  const [chartId, setChartId] = createSignal(
    String((charts.find((c) => c.source.active()) ?? charts[0])?.id ?? ""),
  );
  const [format, setFormat] = createSignal<ExportTimeFormat>(kv.getItem(FORMAT_KEY) === "iso" ? "iso" : "unix");
  const chart = () => charts.find((c) => String(c.id) === chartId()) ?? null;

  const submit = () => {
    const c = chart();
    if (!c) return;
    download(exportFileName(c.source), buildChartCsv(c.source, format()));
    props.onClose();
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      } else if (e.key === "Enter") {
        e.stopPropagation();
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  return (
    <Portal mount={document.body}>
      <div
        class="layout-name-backdrop"
        onPointerDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
      >
        <div
          class="ot-popover layout-name-dialog chart-export-dialog"
          role="dialog"
          aria-label="Download chart data"
          data-name="chart-export-dialog"
        >
          <div class="layout-name-titlebar">
            <div class="layout-name-title">Download chart data</div>
            <button type="button" class="layout-name-close" aria-label="Close" onClick={() => props.onClose()}>
              <svg viewBox="0 0 28 28" width="24" height="24">
                <path fill="currentColor" d="M19.78 8.22 14 14l5.78 5.78-1.06 1.06L13 15.06l-5.78 5.78-1.06-1.06L11.94 14 6.16 8.22l1.06-1.06L13 12.94l5.72-5.78 1.06 1.06Z" />
              </svg>
            </button>
          </div>
          <div class="chart-export-content">
            <div class="chart-export-description">
              All information from the selected chart, including the symbol &amp; indicators will be saved to a CSV file.
            </div>
            <div class="chart-export-row">
              <div class="chart-export-title">Chart</div>
              <SelectControl
                value={chartId()}
                options={charts.map((c) => String(c.id))}
                labelOf={(id) => charts.find((c) => String(c.id) === id)?.source.title() ?? id}
                width={360}
                disabled={charts.length < 2}
                onPick={setChartId}
              />
            </div>
            <div class="chart-export-row">
              <div class="chart-export-title">
                Time format ({exportZoneLabel(format(), chart()?.source.timeZone() ?? "UTC")})
              </div>
              <SelectControl
                value={format()}
                options={["iso", "unix"]}
                labelOf={(f) => FORMAT_LABEL[f as ExportTimeFormat]}
                width={360}
                onPick={(f) => {
                  setFormat(f as ExportTimeFormat);
                  kv.setItem(FORMAT_KEY, f);
                }}
              />
            </div>
          </div>
          <div class="layout-name-footer">
            <button type="button" class="layout-name-btn is-secondary" onClick={() => props.onClose()}>Cancel</button>
            <button
              type="button"
              class="layout-name-btn is-primary"
              data-name="download"
              disabled={!chart()}
              onClick={submit}
            >
              Download
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
