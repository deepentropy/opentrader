/*
 * "Download data" of the account manager (#140), as the reference app's: a tab to export ("All tabs" first, the
 * default), Download saves it as CSV, one file per tab: "<broker>-<tab>-<yyyy-mm-dd>.csv". A table's file holds
 * its shown columns in its order and sort.
 */
import { createSignal } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { SelectControl } from "../../components/form";
import { translate } from "../../i18n/translator";
import { downloadText } from "../screener/screener-csv";
import { tradingCsvName } from "./account-table-model";

export type ExportTab = { id: string; title: () => string; csv: () => string };

export function DownloadTradingDataDialog(props: { broker: string; tabs: ExportTab[]; onClose: () => void }) {
  const [tab, setTab] = createSignal("all");
  const submit = () => {
    const chosen = tab() === "all" ? props.tabs : props.tabs.filter((t) => t.id === tab());
    for (const t of chosen) downloadText(tradingCsvName(props.broker, t.title(), new Date()), t.csv());
    props.onClose();
  };
  return (
    <Dialog
      look="prompt"
      layerClass="ot-dlg-layer"
      backdrop="block"
      class="ot-dlg"
      data-name="data-export-dialog"
      label={translate("Download data")}
      title="Download data"
      onClose={props.onClose}
      onEnter={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div class="ot-dlg-content ot-dlg-text trd-export">
        <div>Select a trading tab to export. It'll be saved to a CSV file.</div>
        <SelectControl
          value={tab()}
          options={["all", ...props.tabs.map((t) => t.id)]}
          labelOf={(id) => (id === "all" ? translate("All tabs") : props.tabs.find((t) => t.id === id)?.title() ?? id)}
          width={400}
          onPick={setTab}
        />
      </div>
      <div class="ot-dlg-footer">
        <button type="button" class="ot-dlg-btn is-secondary" onClick={() => props.onClose()}>
          Cancel
        </button>
        <button type="button" class="ot-dlg-btn is-main is-neutral" data-name="download" onClick={submit}>
          Download
        </button>
      </div>
    </Dialog>
  );
}
