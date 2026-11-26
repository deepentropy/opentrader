/*
 * The question before an alert is deleted (reference rule: the list's rows and menu, the chart's label and its menu
 * ask).
 */
import { confirmDelete } from "../../components/Dialogs";
import { translateWith } from "../../i18n/translator";
import type { AlertRule } from "../../data/alert-store";
import { defaultAlertMessage } from "../../data/alert-condition";

/** Alert texts can be long: the question shows this much of one. */
const NAME_MAX = 100;

export function confirmDeleteAlert(name: string, onConfirm: () => void): void {
  const shown = name.length > NAME_MAX ? name.slice(0, NAME_MAX).trimEnd() + "…" : name;
  confirmDelete({
    title: "Delete alert?",
    text: translateWith("The alert \"{0}\" will be deleted. This cannot be undone.", shown),
    onConfirm,
  });
}

/** What the question calls an alert: its name, else its message. */
export const alertDeleteName = (rule: AlertRule): string => rule.name || rule.message || defaultAlertMessage(rule);
