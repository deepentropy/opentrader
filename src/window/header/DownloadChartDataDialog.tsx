/*
 * "Download chart data" dialog (Manage layouts menu), as the reference app's
 * export dialog: a description, the Chart select (the charts of the layout,
 * the active one first selected; disabled with one chart) and the
 * "Time format (<zone>)" select (ISO time / UNIX timestamp, remembered,
 * UNIX by default). Download saves the chart's CSV (chart-export.ts).
 */
import { createSignal } from "solid-js";
import { SelectControl } from "../../components/form";
import {
  buildChartCsv,
  exportableCharts,
  exportFileName,
  exportZoneLabel,
  type ExportTimeFormat,
} from "../chart/chart-export";
import * as kv from "../../data/kv";
import { Dialog } from "../../components/Dialog";

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


  return (
    <Dialog
      look="form"
      layerClass="layout-name-backdrop"
      backdrop="close-self"
      class="ot-popover layout-name-dialog chart-export-dialog"
      data-name="chart-export-dialog"
      title="Download chart data"
      onClose={props.onClose}
      onEnter={(e) => { e.preventDefault(); submit(); }}
    >
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
    </Dialog>
  );
}
