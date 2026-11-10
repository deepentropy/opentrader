/*
 * The alert dialog's state, grouped by what it edits, so the dialog
 * (AlertDialog.tsx) mostly renders:
 *  - the condition editor's fields: what a condition (or a new alert) puts in
 *    them, as plain values the dialog keeps in one store;
 *  - the settings: the trigger and the expiration;
 *  - the message view and the notifications view: each edits a copy of the
 *    alert's values, written back on Apply.
 */
import { createSignal } from "solid-js";
import type { AlertCondition, AlertFrequency, AlertOperator, AlertRule, AlertSchedule, Operand } from "../../data/alert-store";
import { choiceOf } from "../../data/alert-operands";
import { isBandOperator, isMovingOperator, isPercentOperator } from "../../data/alert-condition";
import { ISO_WEEKDAYS, PRESET_SEGMENTS, localTimeZone, schedulePreset, type SchedulePreset } from "../../data/alert-schedule";
import { sectionOf } from "../chart/custom-intervals";
import { isValidWebhookUrl, type ConditionFields, type SideKind } from "./alert-form";

// ── Condition editor ──

/** The condition editor's fields and what it remembers about them. */
export type EditorFields = ConditionFields & {
  /** The study's own condition chosen (its id). */
  leftCond: string | null;
  /** The value, the bounds: typed by the user (else they follow the source's current value). */
  valueEdited: boolean;
  boundsEdited: boolean;
  /** "in N bars" of a moving condition, as typed. */
  bars: string;
  /** The interval read, and the group of the Interval menu it was picked in ("same-as-chart", a section). */
  resolution: string;
  intervalOrigin: string;
};

/** How saved numbers are written in the fields, and the chart's interval (none on ticks or ranges). */
export type EditorContext = { savedText: (v: number) => string; chartInterval?: string };

/** A channel bound's select: "value", "price", "ind:<study id>" or "sym:<symbol>". */
export const boundSel = (o: Operand | undefined): string =>
  !o ? "value" : o.kind === "price" ? "price" : o.kind === "indicator" ? `ind:${o.indicatorId}` : o.kind === "symbol" ? `sym:${o.symbol.toUpperCase()}` : "value";

const sideKind = (o: Operand | undefined): SideKind =>
  o?.kind === "drawing" ? "drawing" : o?.kind === "indicator" ? "indicator" : o?.kind === "price" ? "price" : o?.kind === "symbol" ? "symbol" : "value";

/** The fields of condition `c` (null: a new condition, the price crossing its current value). */
export function conditionFields(c: AlertCondition | null, ctx: EditorContext): EditorFields {
  const l = c?.left;
  const r = c?.right;
  const r2 = c?.right2;
  const value = c && r?.kind === "value" && !isMovingOperator(c.op) && !isBandOperator(c.op) ? ctx.savedText(r.value) : "";
  const band = !!c && isBandOperator(c.op) && r?.kind !== "drawing";
  const resolution = c?.resolution ?? ctx.chartInterval ?? "1";
  return {
    leftKind: l?.kind === "indicator" ? "indicator" : l?.kind === "symbol" ? "symbol" : "price",
    leftSymbol: l?.kind === "symbol" ? l.symbol.toUpperCase() : "",
    leftIndicator: l?.kind === "indicator" ? l.indicatorId : "",
    leftPlot: choiceOf(l),
    leftCond: c?.op === "alert_condition" && l?.kind === "indicator" ? (l.condition?.id ?? null) : null,
    op: c?.op ?? "crossing",
    rightKind: sideKind(r),
    rightSymbol: r?.kind === "symbol" ? r.symbol.toUpperCase() : "",
    rightValue: value,
    valueEdited: value !== "",
    rightDrawing: r?.kind === "drawing" ? r.drawingId : "",
    rightIndicator: r?.kind === "indicator" ? r.indicatorId : "",
    rightPlot: choiceOf(r),
    rightLevel: r?.kind === "drawing" && r.level != null ? r.level : 0.5,
    rightLevel2: r?.kind === "drawing" && r.level2 != null ? r.level2 : null,
    rightVwapPlot: r?.kind === "drawing" ? (r.plot ?? 0) : 0,
    pct: c && isMovingOperator(c.op) && r?.kind === "value" ? (isPercentOperator(c.op) ? r.value.toFixed(2) : ctx.savedText(r.value)) : "1.00",
    bars: c?.bars != null ? String(c.bars) : "",
    upperSel: band ? boundSel(r) : "value",
    lowerSel: band ? boundSel(r2) : "value",
    upperValue: band && r?.kind === "value" ? ctx.savedText(r.value) : "",
    lowerValue: band && r2?.kind === "value" ? ctx.savedText(r2.value) : "",
    upperPlot: band ? choiceOf(r) : 0,
    lowerPlot: band ? choiceOf(r2) : 0,
    boundsEdited: band,
    resolution,
    intervalOrigin: !c && ctx.chartInterval ? "same-as-chart" : (sectionOf(resolution) ?? ""),
  };
}

/** What a new alert was opened on (a study and its condition, a compared symbol, a drawing, a price), and the
 *  condition chosen for it. */
export type OpenedOn = { indicatorId?: string; compareSymbol?: string; drawingId?: string; price?: number; op: AlertOperator; leftCond?: string };

/** The fields the dialog opens with. An alert being edited (`first`: its first condition): that condition, its number
 *  kept in the value field whatever its condition (a moving amount, a bound). A new alert: what it was opened on. */
export function openingFields(existing: AlertRule | undefined, first: AlertCondition | undefined, opened: OpenedOn, ctx: EditorContext): EditorFields {
  const price = opened.price != null ? String(opened.price) : "";
  if (existing && first) {
    const value = existing.right.kind === "value" ? ctx.savedText(existing.right.value) : price;
    return { ...conditionFields(first, ctx), rightValue: value, valueEdited: value !== "" };
  }
  return {
    ...conditionFields(null, ctx),
    leftKind: opened.indicatorId ? "indicator" : opened.compareSymbol ? "symbol" : "price",
    leftSymbol: (opened.compareSymbol ?? "").toUpperCase(),
    leftIndicator: opened.indicatorId ?? "",
    leftCond: opened.leftCond ?? null,
    op: opened.op,
    rightKind: opened.drawingId ? "drawing" : "value",
    rightValue: price,
    valueEdited: price !== "",
    rightDrawing: opened.drawingId ?? "",
  };
}

// ── Settings: trigger and expiration ──

export type ExpiryKey = "open" | "eod" | "1w" | "1m" | "custom";

/** Expiry time of a choice, from `now` (epoch ms; null = open-ended). */
export function expiryTime(key: ExpiryKey, customMs: number | null, now = Date.now()): number | null {
  const d = new Date(now);
  if (key === "eod") {
    d.setHours(23, 59, 0, 0);
    return d.getTime();
  }
  if (key === "1w") return d.getTime() + 7 * 86_400_000;
  if (key === "1m") {
    d.setMonth(d.getMonth() + 1);
    return d.getTime();
  }
  if (key === "custom") return customMs;
  return null;
}

/** The trigger and the expiration. A rule that already expires opens on "Custom date" with its time. */
export function createSettingsState(existing: AlertRule | undefined) {
  const [frequency, setFrequency] = createSignal<AlertFrequency>(existing?.frequency ?? "only_once");
  const [expiry, setExpiry] = createSignal<ExpiryKey>(existing?.expiresAt == null ? "open" : "custom");
  const [customExpiry, setCustomExpiry] = createSignal<number | null>(existing?.expiresAt ?? null);
  return {
    frequency,
    setFrequency,
    expiry,
    customExpiry,
    setCustomExpiry,
    /** An expiration choice; "Custom date" starts a week from now when no date is set. */
    pickExpiry(key: ExpiryKey) {
      setExpiry(key);
      if (key === "custom" && customExpiry() == null) setCustomExpiry(expiryTime("1w", null));
    },
    /** The expiration time the alert is saved with. */
    expiresAt: () => expiryTime(expiry(), customExpiry()),
  };
}

// ── Message view ──

export type MessageValues = { name: string; message: string };

/** The alert's name and message, and the copy the message view edits. An alert keeps no message of its own while
 *  its message is the default one (`preview`: the condition as it is set), so it follows the condition; with a
 *  script's alert() calls (`callsOnly`) the calls give the messages and only the name is edited. */
export function createMessageState(existing: AlertRule | undefined) {
  const [values, setValues] = createSignal<MessageValues>({ name: existing?.name ?? "", message: existing?.message ?? "" });
  const [draft, setDraft] = createSignal<MessageValues>({ name: "", message: "" });
  return {
    values,
    draft,
    edit: (patch: Partial<MessageValues>) => setDraft({ ...draft(), ...patch }),
    /** Open the view: the name (with alert() calls, the condition until it is named) and the message shown. */
    open(preview: string, callsOnly: boolean) {
      const v = values();
      setDraft({ name: callsOnly ? v.name || preview : v.name, message: v.message || preview });
    },
    /** Apply: a text left as the default one is not kept. */
    apply(preview: string, callsOnly: boolean) {
      const d = draft();
      if (callsOnly) setValues({ ...values(), name: d.name.trim() === preview ? "" : d.name });
      else setValues({ name: d.name, message: d.message === preview ? "" : d.message });
    },
    /** What the alert is saved with. */
    saved(preview: string, callsOnly: boolean): MessageValues {
      const v = values();
      return { name: callsOnly && v.name.trim() === preview ? "" : v.name.trim(), message: callsOnly ? "" : v.message.trim() };
    },
  };
}

// ── Notifications view ──

export type NotificationValues = {
  popup: boolean;
  toast: boolean;
  schedule: AlertSchedule | null;
  webhookOn: boolean;
  webhookUrl: string;
  /** The sound ("" for none) and how long it plays. */
  sound: string;
  soundDuration: number;
};
/** The view's copy: the sound chosen stays while "Play sound" is off. */
export type NotificationDraft = NotificationValues & { soundOn: boolean };
/** The "Custom schedule" editor's days (ISO weekdays) and hours. */
export type CustomSchedule = { days: number[]; from: string; to: string };

/** How the alert notifies, and the copy the notifications view edits. `webhook`: the alert's webhook URL (kept per
 *  rule by the alert store). */
export function createNotificationsState(existing: AlertRule | undefined, webhook: string | null) {
  const [values, setValues] = createSignal<NotificationValues>({
    popup: existing?.popup ?? true,
    toast: existing?.toast !== false,
    schedule: existing?.schedule ?? null,
    webhookOn: webhook != null,
    webhookUrl: webhook ?? "",
    sound: existing?.sound ?? "fired",
    soundDuration: existing?.soundDuration ?? 0,
  });
  const [draft, setDraft] = createSignal<NotificationDraft>({ ...values(), soundOn: true });
  const [customSchedule, setCustomSchedule] = createSignal<CustomSchedule | null>(null);
  const draftWebhookValid = () => !draft().webhookOn || isValidWebhookUrl(draft().webhookUrl);
  return {
    values,
    draft,
    edit: (patch: Partial<NotificationDraft>) => setDraft({ ...draft(), ...patch }),
    /** The webhook only saves (and the dialog only closes) with an http(s) URL: any other string would never deliver. */
    webhookValid: () => !values().webhookOn || isValidWebhookUrl(values().webhookUrl),
    draftWebhookValid,
    open() {
      const v = values();
      setDraft({ ...v, soundOn: !!v.sound, sound: v.sound || "fired" });
      setCustomSchedule(null);
    },
    /** Apply the view (not with an invalid webhook URL); false when it was not applied. */
    apply(): boolean {
      if (!draftWebhookValid()) return false;
      const { soundOn, ...d } = draft();
      setValues({ ...d, sound: soundOn ? d.sound : "" });
      return true;
    },
    customSchedule,
    setCustomSchedule,
    /** A schedule choice. "Custom" opens its editor on the custom schedule set, else on the standard working hours
     *  (a preset does not change it). */
    pickSchedule(k: SchedulePreset) {
      if (k === "custom") {
        const cur = draft().schedule;
        setCustomSchedule(cur && schedulePreset(cur) === "custom" ? { days: cur.days, from: cur.from, to: cur.to } : { days: [...ISO_WEEKDAYS], from: "09:00", to: "18:00" });
        return;
      }
      setDraft({ ...draft(), schedule: k === "24/7" ? null : { ...PRESET_SEGMENTS[k], timeZone: localTimeZone() } });
    },
    /** "Set schedule": the custom schedule becomes the view's. */
    setCustom() {
      const c = customSchedule();
      if (!c) return;
      setDraft({ ...draft(), schedule: { ...c, timeZone: localTimeZone() } });
      setCustomSchedule(null);
    },
  };
}
