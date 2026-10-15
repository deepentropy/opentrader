/*
 * Header "Create alert": the reference opens the alert dialog on the selected
 * source (its invokeAlertEditorOnSelectedSource): a selected drawing that has
 * an alert opens that alert, one that can carry an alert gets a new one on
 * it; a selected study or compared symbol is the source of a new alert,
 * starting at its last value (no crosshair price, unlike Alt + A); with
 * nothing selected, the chart symbol.
 */
import { alertStore } from "../../data/alert-store";
import { drawingCanAlert, rulesOfDrawing } from "../../data/alert-condition";
import { activeChartProbe } from "../chart/active-chart";
import { selectedDrawingIds } from "../drawings/drawing-selection";
import { loadDrawings } from "../drawings/persistence";
import { setAlertDialog } from "./app-dialogs";

export function openCreateAlertOnSelection(symbol: string): void {
  const ids = selectedDrawingIds();
  if (ids.length === 1) {
    const d = loadDrawings(symbol).find((x) => x.id === ids[0]);
    if (d && drawingCanAlert(d.kind)) {
      const rule = rulesOfDrawing(alertStore.rules(), d.id)[0];
      setAlertDialog(rule ? { editId: rule.id } : { symbol, drawingId: d.id });
      return;
    }
  }
  const t = activeChartProbe()?.alertTarget?.() ?? {};
  setAlertDialog({
    symbol,
    ...(t.indicatorId ? { indicatorId: t.indicatorId } : {}),
    ...(t.compareSymbol ? { compareSymbol: t.compareSymbol } : {}),
  });
}
