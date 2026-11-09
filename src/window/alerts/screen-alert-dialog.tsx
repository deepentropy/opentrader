/*
 * Alert on a saved stock screen (created from the screener's screen menu, edited from the Alerts panel): the
 * condition (a symbol enters / leaves the screen), the alert name, the sound and the notification. The alert
 * runs on the screener's market table (data/screen-alerts.ts) and is listed with the other alerts.
 */
import { createSignal } from "solid-js";
import { showConfirm } from "../../components/Dialogs";
import { alertStore, type AlertOperator } from "../../data/alert-store";
import { OPERATOR_LABELS } from "../../data/alert-condition";
import { ensureNotificationPermission } from "../../data/alert-delivery";
import { CheckBox, SelectControl } from "../header/ChartPropertiesDialog";

const OPS: AlertOperator[] = ["screen_enter", "screen_exit"];

/** Create an alert on a screen (`screen`), or edit one (`editId`). */
export function openScreenAlertDialog(args: { screen: { id: string; title: string } } | { editId: string }): void {
  const existing = "editId" in args ? alertStore.rules().find((r) => r.id === args.editId) : undefined;
  if ("editId" in args && (!existing || existing.left.kind !== "screen")) return;
  const screen = existing && existing.left.kind === "screen" ? { id: existing.left.screenId, title: existing.left.title } : (args as { screen: { id: string; title: string } }).screen;
  const [op, setOp] = createSignal<AlertOperator>(existing?.op ?? "screen_enter");
  const [name, setName] = createSignal(existing?.name ?? "");
  const [sound, setSound] = createSignal(existing ? existing.sound !== "" : true);
  const [popup, setPopup] = createSignal(existing?.popup ?? true);
  showConfirm({
    title: existing ? "Edit alert on screen" : "Create alert on screen",
    text: `Screen: ${screen.title}`,
    mainText: existing ? "Save" : "Create",
    cancelText: "Cancel",
    intent: "neutral",
    body: () => (
      <div class="screen-alert-form">
        <label class="screen-alert-row">
          <span class="screen-alert-label">Condition</span>
          <SelectControl value={op()} options={OPS} width={240} labelOf={(o) => OPERATOR_LABELS[o as AlertOperator]} onPick={(v) => setOp(v as AlertOperator)} />
        </label>
        <label class="screen-alert-row">
          <span class="screen-alert-label">Alert name</span>
          <input class="ot-dlg-input screen-alert-name" value={name()} maxLength={80} placeholder={screen.title} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <div class="screen-alert-row">
          <CheckBox checked={sound()} onToggle={() => setSound(!sound())} />
          <span onClick={() => setSound(!sound())}>Play sound</span>
        </div>
        <div class="screen-alert-row">
          <CheckBox checked={popup()} onToggle={() => setPopup(!popup())} />
          <span onClick={() => setPopup(!popup())}>Show pop-up</span>
        </div>
      </div>
    ),
    onConfirm: () => {
      if (popup()) ensureNotificationPermission();
      const fields = {
        op: op(),
        name: name().trim(),
        sound: sound() ? existing?.sound || "fired" : "",
        popup: popup(),
      };
      if (existing) {
        alertStore.update(existing.id, { ...fields, enabled: true });
        return;
      }
      alertStore.add({
        symbol: "",
        resolution: "",
        left: { kind: "screen", screenId: screen.id, title: screen.title },
        right: { kind: "value", value: 0 },
        frequency: "every_time",
        message: "",
        expiresAt: null,
        ...fields,
      });
    },
  });
}
