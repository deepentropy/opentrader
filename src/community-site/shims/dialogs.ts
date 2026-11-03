/*
 * Community website: stand-in for components/Dialogs (the app's dialogs pull in the chart settings). The browser's
 * own confirmation box is enough here.
 */
import type { ConfirmOptions } from "../../components/Dialogs";

export function showConfirm(opts: ConfirmOptions): void {
  if (window.confirm(`${opts.title ? opts.title + "\n\n" : ""}${opts.text}`)) opts.onConfirm();
  else opts.onCancel?.();
}
