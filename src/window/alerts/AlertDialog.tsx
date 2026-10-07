/*
 * AlertDialog — create or edit a single alert rule.
 *
 * A real, condition-based alert (the per-symbol counterpart to the watchlist's
 * list-level AddAlertDialog). A (left · operator · right) condition over
 * price / drawing / indicator operands, plus trigger, expiration, message and
 * notifications. Saving writes to alert-store; the engine evaluates it live.
 *
 * Layout: 480 px, header "Create alert on <symbol>" (the symbol is a button
 * that turns into a field), the Condition block (label column 131 px, 34 px
 * controls stacked 8 px apart), a divider, then Trigger / Expiration /
 * Message / Notifications as one text row each. Trigger and Expiration open
 * a menu; Message and Notifications open their own view (back arrow, Cancel
 * / Apply). Footer: Cancel and Create.
 *
 * Opened from the header "Create alert" button and the chart context menu
 * (prefilled with the clicked symbol + price), or with an `editId` to edit.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import {
  alertStore,
  type AlertFrequency,
  type AlertOperator,
  type Operand,
} from "../../data/alert-store";
import {
  OPERATOR_LABELS,
  bandOperatorLabel,
  isBandOperator,
  shapeOperators,
  describeCondition,
  isPercentOperator,
  priceableDrawings,
} from "../../data/alert-condition";
import { indicatorLegendFor } from "../../data/chart-state-registry";
import { getIndicatorEntry } from "../chart/indicators/registry";
import { isFullSymbol, toFullSymbol } from "../../data/datafeed";
import { SOUND_OPTIONS, playAlertSound } from "../../data/alert-sounds";
import { alertSettings } from "../../data/alert-settings";
import {
  alertWebhook,
  ensureNotificationPermission,
  resetRuleEvalState,
  setAlertWebhook,
} from "../../data/alert-engine";

type Props = {
  /** When set, edit this existing rule instead of creating one. */
  editId?: string;
  /** Prefill symbol (full name "EXCHANGE:TICKER") for new rules. */
  symbol?: string;
  /** Prefill the right-hand value (e.g. the clicked chart price). */
  price?: number;
  /** New alert on a study (chart menu in a study pane): the left operand. */
  indicatorId?: string;
  /** New alert on a drawing (its "Add alert" button): the right operand. */
  drawingId?: string;
  /** Chart interval to stamp onto the rule as its resolution. */
  interval: string;
  onClose: () => void;
};

const OPERATORS: AlertOperator[] = [
  "crossing",
  "crossing_up",
  "crossing_down",
  "greater",
  "less",
  "moving_up_pct",
  "moving_down_pct",
];

/** Trigger choices. A condition on price offers the first two; one that
 *  reads an indicator adds the per-bar ones. */
const FREQUENCIES: { key: AlertFrequency; label: string; desc: string }[] = [
  { key: "only_once", label: "Once only", desc: "Triggers once when condition is met" },
  { key: "every_time", label: "Every time", desc: "Triggers once per minute while condition remains met" },
  { key: "once_per_bar", label: "Once per bar", desc: "Triggers once per bar when condition is met" },
  { key: "once_per_bar_close", label: "Once per bar close", desc: "Triggers when a bar closes with the condition met" },
];

type ExpiryKey = "open" | "eod" | "1w" | "1m" | "custom";

/** "Oct 7, 23:59" */
function shortDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Expiry time of a choice, from now (null = open-ended). */
function expiryTime(key: ExpiryKey, customMs: number | null): number | null {
  const d = new Date();
  if (key === "eod") { d.setHours(23, 59, 0, 0); return d.getTime(); }
  if (key === "1w") return d.getTime() + 7 * 86_400_000;
  if (key === "1m") { d.setMonth(d.getMonth() + 1); return d.getTime(); }
  if (key === "custom") return customMs;
  return null;
}

/** datetime-local value of a time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

type MenuOption = { value: string; label: string; desc?: string; right?: string; disabled?: boolean; icon?: string };

/** Condition icons: stroked 18 x 18 paths. A level is a horizontal line, a
 *  channel two of them; the arrow or the dot is the price. */
const OPERATOR_ICONS: Record<AlertOperator, string> = {
  crossing: "M3 13.5 15 4.5M11.5 4.5H15V8M3 4.5l12 9",
  crossing_up: "M2.5 11.5h13M5 15.5l8-11M9.5 4.5H13V8",
  crossing_down: "M2.5 6.5h13M5 2.5l8 11M9.5 13.5H13V10",
  greater: "M2.5 13.5h13M9 10.5v-7M6 6.5l3-3 3 3",
  less: "M2.5 4.5h13M9 7.5v7M6 11.5l3 3 3-3",
  moving_up_pct: "M2.5 13.5l4.5-4.5 3 3 5-6.5M11.5 5.5H15V9",
  moving_down_pct: "M2.5 4.5 7 9l3-3 5 6.5M11.5 12.5H15V9",
  entering: "M2.5 5h13M2.5 12.5h13M9 16.5V8.5M6.5 11 9 8.5l2.5 2.5",
  exiting: "M2.5 5h13M2.5 12.5h13M9 8.5v8M6.5 14 9 16.5l2.5-2.5",
  inside: "M2.5 4.5h13M2.5 13.5h13M9 7.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z",
  outside: "M2.5 7h13M2.5 15.5h13M9 2.1a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z",
  hits_level: "M2.5 4h4M11.5 4h4M2.5 9h13M2.5 14h4M11.5 14h4M9 2.5v13",
};

/** Dropdown of the dialog. `box`: a 34 px bordered control showing the value;
 *  `inline`: the value as text with a chevron (Trigger, Expiration). `more`:
 *  the options after this count sit behind a "Show more" row. */
function AdMenu(props: { variant: "box" | "inline"; value: string; options: MenuOption[]; onPick: (v: string) => void; more?: number; label?: string; placeholder?: string }) {
  const [open, setOpen] = createSignal(false);
  const [all, setAll] = createSignal(false);
  let el: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: PointerEvent) => { if (el && !el.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onDown, true));
  });
  const current = () => props.options.find((o) => o.value === props.value);
  const cut = () => (props.more !== undefined && !all() && props.options.findIndex((o) => o.value === props.value) < props.more ? props.more : props.options.length);
  const menuIcon = (d: string) => (
    <svg class="ad-option-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" d={d} />
    </svg>
  );
  const row = (o: MenuOption) => (
    <button
      type="button"
      role="option"
      aria-selected={o.value === props.value}
      disabled={o.disabled}
      class="ad-option"
      classList={{ "is-selected": o.value === props.value, "has-desc": !!o.desc }}
      onClick={() => { props.onPick(o.value); setOpen(false); }}
    >
      <Show when={o.icon}>{menuIcon(o.icon!)}</Show>
      <span class="ad-option-main">
        <span class="ad-option-label">{o.label}</span>
        <Show when={o.desc}><span class="ad-option-desc">{o.desc}</span></Show>
      </span>
      <Show when={o.right}><span class="ad-option-right">{o.right}</span></Show>
    </button>
  );
  return (
    <div class={`ad-menu ad-menu--${props.variant}`} ref={el}>
      <button type="button" class="ad-menu-btn" aria-label={props.label} aria-expanded={open()} onClick={() => { setAll(false); setOpen(!open()); }}>
        <Show when={current()?.icon}>{menuIcon(current()!.icon!)}</Show>
        <span class="ad-menu-value">{current()?.label ?? props.placeholder ?? ""}</span>
        <svg class="ad-chevron" classList={{ "is-open": open() }} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          <path fill="none" stroke="currentColor" stroke-width="1.2" d="m4.5 7 4.5 4 4.5-4" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="ad-menu-list" role="listbox">
          <For each={props.options.slice(0, cut())}>{row}</For>
          <Show when={cut() < props.options.length}>
            <button type="button" class="ad-option ad-option-more" onClick={() => setAll(true)}>
              <span class="ad-option-label">Show more</span>
              <svg class="ad-chevron" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                <path fill="none" stroke="currentColor" stroke-width="1.2" d="m4.5 7 4.5 4 4.5-4" />
              </svg>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

type SideKind = "value" | "drawing" | "indicator";

/** A deliverable webhook target: parses as a URL with an http(s) scheme. */
function isValidWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function AlertDialog(props: Props) {
  const existing = props.editId ? alertStore.rule(props.editId) : undefined;

  const [symbol, setSymbol] = createSignal((existing?.symbol ?? props.symbol ?? "").toUpperCase());

  // The set of indicators / priceable drawings available for the symbol comes
  // from the charted symbol; captured once at open (the dialog is short-lived).
  const indicators = () => indicatorLegendFor(symbol());
  const drawings = () => priceableDrawings(symbol());

  // Include the rule's *existing* operands as options even when the symbol
  // isn't currently charted (or the study/drawing is gone), so editing never
  // silently drops or mis-displays an indicator/drawing operand.
  const indicatorOptions = createMemo(() => {
    const opts = indicators().map((r) => ({ id: r.id, label: r.title }));
    const ids = new Set(opts.map((o) => o.id));
    for (const o of [existing?.left, existing?.right]) {
      if (o && o.kind === "indicator" && !ids.has(o.indicatorId)) {
        opts.push({ id: o.indicatorId, label: o.label ?? "indicator" });
        ids.add(o.indicatorId);
      }
    }
    return opts;
  });
  const drawingOptions = createMemo(() => {
    const opts = drawings();
    const r = existing?.right;
    if (r && r.kind === "drawing" && !opts.some((o) => o.id === r.drawingId)) {
      return [...opts, { id: r.drawingId, label: r.label ?? "drawing", band: r.band ?? null }];
    }
    return opts;
  });


  // ── Left operand ── price or an indicator plot.
  const [leftKind, setLeftKind] = createSignal<"price" | "indicator">(
    existing?.left.kind === "indicator" || (!existing && props.indicatorId) ? "indicator" : "price",
  );
  const [leftIndicator, setLeftIndicator] = createSignal(
    existing?.left.kind === "indicator" ? existing.left.indicatorId : (!existing && props.indicatorId) || "",
  );
  const [leftPlot, setLeftPlot] = createSignal(existing?.left.kind === "indicator" ? (existing.left.plot ?? 0) : 0);

  const [op, setOp] = createSignal<AlertOperator>(existing?.op ?? "crossing");

  // ── Right operand ── a value, a drawing level, or an indicator plot.
  const [rightKind, setRightKind] = createSignal<SideKind>(
    existing?.right.kind === "drawing" || (!existing && props.drawingId)
      ? "drawing"
      : existing?.right.kind === "indicator"
        ? "indicator"
        : "value",
  );
  const defaultValue =
    existing?.right.kind === "value"
      ? String(existing.right.value)
      : props.price != null
        ? String(props.price)
        : "";
  const [rightValue, setRightValue] = createSignal(defaultValue);
  const [rightDrawing, setRightDrawing] = createSignal(
    existing?.right.kind === "drawing" ? existing.right.drawingId : (!existing && props.drawingId) || "",
  );
  const [rightIndicator, setRightIndicator] = createSignal(
    existing?.right.kind === "indicator" ? existing.right.indicatorId : "",
  );
  const [rightPlot, setRightPlot] = createSignal(existing?.right.kind === "indicator" ? (existing.right.plot ?? 0) : 0);
  /** Plots of an indicator (title per plotConfig index), for the plot select
   *  shown next to a study with 2 or more plots. */
  const plotsOf = (indicatorId: string) =>
    (getIndicatorEntry(indicatorId)?.plotConfig ?? []).map((p, i) => ({ index: i, title: p.title || p.id }));

  // ── % threshold (for moving_up_pct / moving_down_pct) ──
  const [pct, setPct] = createSignal(
    isPercentOperator(existing?.op ?? "crossing") && existing?.right.kind === "value"
      ? String(existing.right.value)
      : "5",
  );
  // "in N bars" of the Moving % operators (1-300; 2 minimum on a study).
  const [bars, setBars] = createSignal(String(existing?.bars ?? 1));
  const barsValue = () => {
    const n = Math.round(Number(bars()));
    const min = leftKind() === "indicator" ? 2 : 1;
    return Number.isFinite(n) ? Math.max(min, Math.min(300, n)) : min;
  };

  const [frequency, setFrequency] = createSignal<AlertFrequency>(existing?.frequency ?? "only_once");
  const [name, setName] = createSignal(existing?.name ?? "");
  const [message, setMessage] = createSignal(existing?.message ?? "");
  const [sound, setSound] = createSignal(existing?.sound ?? "fired");
  const [popup, setPopup] = createSignal(existing?.popup ?? true);
  // Webhook — persisted per-rule beside the store (see alert-engine's kv map).
  const existingWebhook = existing ? alertWebhook(existing.id) : null;
  const [webhookOn, setWebhookOn] = createSignal(existingWebhook != null);
  const [webhookUrl, setWebhookUrl] = createSignal(existingWebhook ?? "");
  // Expiration: a rule that already expires opens on "Custom date" with it.
  const [expiry, setExpiry] = createSignal<ExpiryKey>(existing?.expiresAt == null ? "open" : "custom");
  const [customExpiry, setCustomExpiry] = createSignal<number | null>(existing?.expiresAt ?? null);
  const expiryOptions = (): MenuOption[] => [
    { value: "open", label: "Open-ended", right: "Won't expire" },
    { value: "eod", label: "End of day", right: shortDateTime(expiryTime("eod", null)!) },
    { value: "1w", label: "1 week", right: shortDateTime(expiryTime("1w", null)!) },
    { value: "1m", label: "1 month", right: shortDateTime(expiryTime("1m", null)!) },
    { value: "custom", label: "Custom date", right: customExpiry() != null ? shortDateTime(customExpiry()!) : "" },
  ];

  // Which view of the dialog shows; the two sub-views edit a copy and write
  // it back on Apply.
  const [view, setView] = createSignal<"main" | "message" | "notifications">("main");
  const [draftName, setDraftName] = createSignal("");
  const [draftMessage, setDraftMessage] = createSignal("");
  const [draftPopup, setDraftPopup] = createSignal(true);
  const [draftWebhookOn, setDraftWebhookOn] = createSignal(false);
  const [draftWebhookUrl, setDraftWebhookUrl] = createSignal("");
  const [draftSound, setDraftSound] = createSignal("");
  const [draftSoundOn, setDraftSoundOn] = createSignal(true);
  const [symbolEdit, setSymbolEdit] = createSignal(!((existing?.symbol ?? props.symbol ?? "").trim()));

  const isPct = () => isPercentOperator(op());

  // The drawing chosen as the level sets the conditions: a channel or a
  // rectangle has entering / exiting / inside / outside, a vertical line
  // only "Crossing" (once, so no trigger choice), a position its one fixed
  // condition; a fib tool adds the choice of its level.
  const drawingOption = () => (rightKind() === "drawing" ? drawingOptions().find((o) => o.id === rightDrawing()) : undefined);
  const band = () => drawingOption()?.band ?? null;
  const fibLevels = () => drawingOption()?.levels ?? [];
  const operators = () => shapeOperators(band(), fibLevels().length > 0) ?? OPERATORS;
  const operatorLabel = (o: AlertOperator) =>
    !isBandOperator(o) ? OPERATOR_LABELS[o] : bandOperatorLabel(o, band() === "rectangle" ? "rectangle" : "channel");
  createEffect(() => {
    const list = operators();
    if (!list.includes(untrack(op))) setOp(list[0]);
  });
  const [rightLevel, setRightLevel] = createSignal<number>(existing?.right.kind === "drawing" && existing.right.level != null ? existing.right.level : 0.5);
  createEffect(() => {
    const lv = fibLevels();
    if (lv.length && !lv.some((l) => l.coeff === untrack(rightLevel))) setRightLevel((lv.find((l) => l.coeff === 0.5) ?? lv[0]).coeff);
  });
  const levelText = (l: { coeff: number; price: number }) => `${l.coeff} (${l.price.toFixed(2)})`;
  // Fib tool, channel condition: a second level (the lower bound), by
  // default the level after the first one.
  const fibChannel = () => fibLevels().length > 0 && isBandOperator(op());
  const [rightLevel2, setRightLevel2] = createSignal<number | null>(existing?.right.kind === "drawing" && existing.right.level2 != null ? existing.right.level2 : null);
  createEffect(() => {
    const lv = fibLevels();
    if (!lv.length) return;
    const cur = untrack(rightLevel2);
    if (cur != null && lv.some((l) => l.coeff === cur)) return;
    const i = lv.findIndex((l) => l.coeff === rightLevel());
    setRightLevel2((lv[i + 1] ?? lv[i - 1] ?? lv[0]).coeff);
  });

  function buildLeft(): Operand {
    if (leftKind() === "indicator" && leftIndicator()) {
      const o = indicatorOptions().find((x) => x.id === leftIndicator());
      return { kind: "indicator", indicatorId: leftIndicator(), plot: leftPlot(), label: plotLabel(o?.label, leftIndicator(), leftPlot()) };
    }
    return { kind: "price" };
  }

  function buildRight(): Operand {
    if (isPct()) return { kind: "value", value: parseFloat(pct()) || 0 };
    switch (rightKind()) {
      case "drawing": {
        const o = drawingOptions().find((x) => x.id === rightDrawing());
        const lv = o?.levels?.find((l) => l.coeff === rightLevel());
        const lv2 = fibChannel() ? o?.levels?.find((l) => l.coeff === rightLevel2()) : undefined;
        return {
          kind: "drawing",
          drawingId: rightDrawing(),
          label: lv && lv2 ? `${o?.label} (upper bound: level ${lv.coeff}, lower bound: level ${lv2.coeff})` : lv ? `${o?.label} level ${levelText(lv)}` : o?.label,
          ...(o?.band ? { band: o.band } : {}),
          ...(lv ? { level: lv.coeff } : {}),
          ...(lv2 ? { level2: lv2.coeff } : {}),
        };
      }
      case "indicator": {
        const o = indicatorOptions().find((x) => x.id === rightIndicator());
        return { kind: "indicator", indicatorId: rightIndicator(), plot: rightPlot(), label: plotLabel(o?.label, rightIndicator(), rightPlot()) };
      }
      default:
        return { kind: "value", value: parseFloat(rightValue()) || 0 };
    }
  }

  /** Operand label: the study title, with the plot title for a study with
   *  several plots ("BB 20 2: Upper"). */
  function plotLabel(title: string | undefined, indicatorId: string, plot: number): string | undefined {
    const plots = plotsOf(indicatorId);
    return plots.length >= 2 && title ? `${title}: ${plots[plot]?.title ?? ""}` : title;
  }

  /** Live preview of the condition, used as the message placeholder. */
  const preview = createMemo(() => {
    // "AZO Crossing 150": the ticker, and no "Price" in front of a price
    // condition.
    const full = symbol() || "—";
    const sym = full.includes(":") ? full.split(":")[1] : full;
    const text = describeCondition({ left: buildLeft(), op: op(), right: buildRight(), bars: barsValue() });
    return `${sym} ${leftKind() === "price" ? text.replace(/^Price /, "") : text}`;
  });

  // The webhook only saves (and the dialog only closes) with an http(s) URL —
  // any other string would silently never deliver.
  const webhookValid = createMemo(() => !webhookOn() || isValidWebhookUrl(webhookUrl()));

  const canSave = createMemo(() => {
    if (!symbol().trim()) return false;
    if (!webhookValid()) return false;
    if (isPct()) return Number.isFinite(parseFloat(pct()));
    if (rightKind() === "value") return Number.isFinite(parseFloat(rightValue()));
    if (rightKind() === "drawing") return drawingOptions().some((o) => o.id === rightDrawing());
    if (rightKind() === "indicator") return indicatorOptions().some((o) => o.id === rightIndicator());
    return true;
  });

  function save() {
    if (!canSave()) return;
    const expiresAt = expiryTime(expiry(), customExpiry());

    const typed = symbol().trim().toUpperCase();
    const rule = {
      symbol: typed,
      resolution: existing?.resolution ?? props.interval,
      left: buildLeft(),
      op: op(),
      right: buildRight(),
      bars: isPct() ? barsValue() : undefined,
      frequency: band() === "time" ? ("only_once" as AlertFrequency) : frequency(),
      name: name().trim(),
      message: message().trim(),
      sound: sound(),
      popup: popup(),
      expiresAt,
    };

    if (popup()) ensureNotificationPermission();

    const webhook = webhookOn() ? webhookUrl() : null;
    const commit = (sym: string) => {
      const r = { ...rule, symbol: sym };
      let id: string;
      if (existing) {
        alertStore.update(existing.id, { ...r, enabled: true });
        // The condition may have changed — drop the stale crossing baseline so the
        // next tick re-establishes it instead of manufacturing a spurious cross.
        resetRuleEvalState(existing.id);
        id = existing.id;
      } else {
        id = alertStore.add(r);
      }
      setAlertWebhook(id, webhook);
    };
    // A typed bare ticker gets its primary listing (rules are keyed by the
    // full name); if the lookup fails it is kept and migrated on a later start.
    if (isFullSymbol(typed)) commit(typed);
    else void toFullSymbol(typed).then(commit, () => commit(typed));
    props.onClose();
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      } else if (existing && e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        // "Save changes in the Edit alert dialog" = Ctrl+Enter (bound for the
        // Edit dialog only).
        e.preventDefault();
        e.stopPropagation();
        save();
      }
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  // ── View helpers ──────────────────────────────────────────────────────────
  const usesIndicator = () => leftKind() === "indicator" || (!isPct() && rightKind() === "indicator");
  const triggerOptions = (): MenuOption[] =>
    FREQUENCIES.filter((f, i) => i < 2 || usesIndicator() || f.key === frequency()).map((f) => ({ value: f.key, label: f.label, desc: f.desc }));
  const sourceOptions = (): MenuOption[] => [{ value: "price", label: "Price" }, ...indicatorOptions().map((r) => ({ value: `ind:${r.id}`, label: r.label }))];
  const rightKindOptions = (): MenuOption[] => [
    { value: "value", label: "Value" },
    { value: "drawing", label: "Drawing", disabled: drawingOptions().length === 0 },
    { value: "indicator", label: "Indicator", disabled: indicatorOptions().length === 0 },
  ];
  const levelOptions = (): MenuOption[] => fibLevels().map((l) => ({ value: String(l.coeff), label: levelText(l) }));
  const plotOptions = (id: string): MenuOption[] => plotsOf(id).map((p) => ({ value: String(p.index), label: p.title }));
  const notificationsText = () => {
    const on = [popup() && "Notification", webhookOn() && "Webhook", sound() && "Sound"].filter(Boolean);
    return on.length ? on.join(", ") : "None";
  };
  const openMessage = () => { setDraftName(name()); setDraftMessage(message()); setView("message"); };
  const openNotifications = () => {
    setDraftPopup(popup());
    setDraftWebhookOn(webhookOn());
    setDraftWebhookUrl(webhookUrl());
    setDraftSoundOn(!!sound());
    setDraftSound(sound() || "fired");
    setView("notifications");
  };
  const draftWebhookValid = () => !draftWebhookOn() || isValidWebhookUrl(draftWebhookUrl());
  const stepValue = (dir: 1 | -1) => {
    const v = parseFloat(rightValue());
    const text = rightValue().trim();
    const decimals = text.includes(".") ? text.split(".")[1].length : 2;
    const step = 1 / 10 ** decimals;
    setRightValue(((Number.isFinite(v) ? v : 0) + dir * step).toFixed(decimals));
  };
  const closeIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
    </svg>
  );
  const arrow = (d: string) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path stroke="currentColor" stroke-width="1.2" fill="none" d={d} />
    </svg>
  );
  const subHeader = (title: string) => (
    <header class="ad-header">
      <button type="button" class="ad-icon-btn" data-name="back" aria-label="Back" onClick={() => setView("main")}>
        {arrow("M11 3.5 5.5 9l5.5 5.5")}
      </button>
      <span class="ad-title">{title}</span>
      <span class="ad-spacer" />
      <button type="button" class="ad-icon-btn" data-name="close" aria-label="Close" onClick={() => props.onClose()}>
        {closeIcon}
      </button>
    </header>
  );

  return (
    <Portal mount={document.body}>
      <div class="ad-backdrop" role="presentation" onMouseDown={() => props.onClose()}>
        <div class="ad" role="dialog" aria-label={existing ? "Edit alert" : "Create alert"} onMouseDown={(e) => e.stopPropagation()}>
          {/* ── Main view ── */}
          <Show when={view() === "main"}>
            <header class="ad-header">
              <span class="ad-title">{existing ? "Edit alert on" : "Create alert on"}</span>
              <Show
                when={!symbolEdit()}
                fallback={
                  <input
                    class="ad-input ad-symbol-input"
                    type="text"
                    aria-label="Symbol"
                    value={symbol()}
                    placeholder="Symbol"
                    spellcheck={false}
                    ref={(el) => queueMicrotask(() => { if (symbol()) el.select(); el.focus(); })}
                    onInput={(e) => setSymbol(e.currentTarget.value.toUpperCase())}
                    onKeyDown={(e) => { if (e.key === "Enter" && symbol().trim()) setSymbolEdit(false); }}
                    onBlur={() => { if (symbol().trim()) setSymbolEdit(false); }}
                  />
                }
              >
                <button type="button" class="ad-symbol-btn" data-name="symbols-button" onClick={() => setSymbolEdit(true)}>
                  <span class="ad-symbol-text">{symbol().includes(":") ? symbol().split(":")[1] : symbol()}</span>
                  {arrow("m4.5 7 4.5 4 4.5-4")}
                </button>
              </Show>
              <span class="ad-spacer" />
              <button type="button" class="ad-icon-btn" data-name="close" aria-label="Close" onClick={() => props.onClose()}>
                {closeIcon}
              </button>
            </header>

            <div class="ad-body">
              <div class="ad-row ad-row--top">
                <span class="ad-label">Condition</span>
                <div class="ad-controls">
                  <AdMenu
                    variant="box"
                    label="Source"
                    value={leftKind() === "indicator" ? `ind:${leftIndicator()}` : "price"}
                    options={sourceOptions()}
                    onPick={(v) => {
                      if (v === "price") setLeftKind("price");
                      else { setLeftKind("indicator"); setLeftIndicator(v.slice(4)); setLeftPlot(0); }
                    }}
                  />
                  {/* Plot select: a study with 2 or more plots. */}
                  <Show when={leftKind() === "indicator" && plotsOf(leftIndicator()).length >= 2}>
                    <AdMenu variant="box" label="Plot" value={String(leftPlot())} options={plotOptions(leftIndicator())} onPick={(v) => setLeftPlot(Number(v))} />
                  </Show>

                  <AdMenu
                    variant="box"
                    label="Condition"
                    value={op()}
                    more={shapeOperators(band(), fibLevels().length > 0) ? undefined : 3}
                    options={operators().map((o) => ({ value: o, label: operatorLabel(o), icon: OPERATOR_ICONS[o] }))}
                    onPick={(v) => setOp(v as AlertOperator)}
                  />

                  <Show
                    when={!isPct()}
                    fallback={
                      <div class="ad-pair ad-pct">
                        <input class="ad-input" type="number" step="0.5" min="0" aria-label="Percent" value={pct()} onInput={(e) => setPct(e.currentTarget.value)} />
                        <span class="ad-suffix">% in</span>
                        <input
                          class="ad-input"
                          type="number"
                          step="1"
                          min={leftKind() === "indicator" ? 2 : 1}
                          max="300"
                          aria-label="Bars"
                          value={bars()}
                          onInput={(e) => setBars(e.currentTarget.value)}
                        />
                        <span class="ad-suffix">{barsValue() === 1 ? "bar" : "bars"}</span>
                      </div>
                    }
                  >
                    <div class="ad-pair">
                      <AdMenu variant="box" label="Compared with" value={rightKind()} options={rightKindOptions()} onPick={(v) => setRightKind(v as SideKind)} />
                      <Show when={rightKind() === "value"}>
                        <span class="ad-number">
                          <input class="ad-input" type="text" inputmode="decimal" aria-label="Value" value={rightValue()} onInput={(e) => setRightValue(e.currentTarget.value)} placeholder="0.00" />
                          <span class="ad-steppers">
                            <button type="button" tabIndex={-1} aria-label="Increase" onClick={() => stepValue(1)}>{arrow("m5 11 4-4 4 4")}</button>
                            <button type="button" tabIndex={-1} aria-label="Decrease" onClick={() => stepValue(-1)}>{arrow("m5 7 4 4 4-4")}</button>
                          </span>
                        </span>
                      </Show>
                      <Show when={rightKind() === "drawing"}>
                        <AdMenu
                          variant="box"
                          label="Drawing"
                          placeholder="Select drawing…"
                          value={rightDrawing()}
                          options={drawingOptions().map((d) => ({ value: d.id, label: d.label }))}
                          onPick={setRightDrawing}
                        />
                      </Show>
                      <Show when={rightKind() === "indicator"}>
                        <AdMenu
                          variant="box"
                          label="Indicator"
                          placeholder="Select indicator…"
                          value={rightIndicator()}
                          options={indicatorOptions().map((r) => ({ value: r.id, label: r.label }))}
                          onPick={(v) => { setRightIndicator(v); setRightPlot(0); }}
                        />
                      </Show>
                    </div>
                    <Show when={rightKind() === "indicator" && plotsOf(rightIndicator()).length >= 2}>
                      <AdMenu variant="box" label="Plot" value={String(rightPlot())} options={plotOptions(rightIndicator())} onPick={(v) => setRightPlot(Number(v))} />
                    </Show>
                  </Show>
                </div>
              </div>
              {/* Fib tool: its level; with a channel condition the two bounds. */}
              <Show when={!isPct() && rightKind() === "drawing" && fibLevels().length > 0}>
                <div class="ad-row">
                  <span class="ad-label">{fibChannel() ? "Upper bound" : "Level"}</span>
                  <div class="ad-controls">
                    <AdMenu variant="box" label={fibChannel() ? "Upper bound" : "Level"} value={String(rightLevel())} options={levelOptions()} onPick={(v) => setRightLevel(Number(v))} />
                  </div>
                </div>
                <Show when={fibChannel()}>
                  <div class="ad-row">
                    <span class="ad-label">Lower bound</span>
                    <div class="ad-controls">
                      <AdMenu variant="box" label="Lower bound" value={String(rightLevel2())} options={levelOptions()} onPick={(v) => setRightLevel2(Number(v))} />
                    </div>
                  </div>
                </Show>
              </Show>

              <div class="ad-divider" />

              {/* A vertical line is crossed once: no trigger choice. */}
              <Show when={band() !== "time"}>
                <div class="ad-row ad-row--text">
                  <span class="ad-label">Trigger</span>
                  <AdMenu variant="inline" label="Trigger" value={frequency()} options={triggerOptions()} onPick={(v) => setFrequency(v as AlertFrequency)} />
                </div>
              </Show>
              <div class="ad-row ad-row--text">
                <span class="ad-label">Expiration</span>
                <AdMenu variant="inline" label="Expiration" value={expiry()} options={expiryOptions()} onPick={(v) => { setExpiry(v as ExpiryKey); if (v === "custom" && customExpiry() == null) setCustomExpiry(expiryTime("1w", null)); }} />
                <Show when={expiry() === "custom"}>
                  <input
                    class="ad-input ad-date"
                    type="datetime-local"
                    aria-label="Expiration date"
                    value={customExpiry() != null ? toLocalInput(customExpiry()!) : ""}
                    onChange={(e) => { const t = Date.parse(e.currentTarget.value); setCustomExpiry(Number.isFinite(t) ? t : null); }}
                  />
                </Show>
              </div>
              <div class="ad-row ad-row--text">
                <span class="ad-label">Message</span>
                <button type="button" class="ad-link" data-name="alert-message-button" onClick={openMessage}>
                  <span class="ad-link-text">{name() ? `${name()}: ` : ""}{message() || preview()}</span>
                  {arrow("m7 4.5 4 4.5-4 4.5")}
                </button>
              </div>
              <div class="ad-row ad-row--text">
                <span class="ad-label">Notifications</span>
                <button type="button" class="ad-link" data-name="alert-notifications-button" onClick={openNotifications}>
                  <span class="ad-link-text">{notificationsText()}</span>
                  {arrow("m7 4.5 4 4.5-4 4.5")}
                </button>
              </div>
            </div>

            <footer class="ad-footer">
              <Show when={existing}>
                <button
                  type="button"
                  class="ot-dlg-btn is-secondary ad-delete"
                  onClick={() => {
                    resetRuleEvalState(existing!.id);
                    setAlertWebhook(existing!.id, null);
                    alertStore.remove(existing!.id);
                    props.onClose();
                  }}
                >
                  Delete
                </button>
              </Show>
              <span class="ad-spacer" />
              <button type="button" class="ot-dlg-btn is-secondary" data-name="cancel" onClick={() => props.onClose()}>Cancel</button>
              <button type="button" class="ot-dlg-btn is-main is-neutral" data-name="submit" aria-disabled={!canSave()} disabled={!canSave()} onClick={save}>
                {existing ? "Save" : "Create"}
              </button>
            </footer>
          </Show>

          {/* ── Edit message ── */}
          <Show when={view() === "message"}>
            {subHeader("Edit message")}
            <div class="ad-body">
              <label class="ad-field">
                <span class="ad-label">Alert name</span>
                <input class="ad-input" type="text" value={draftName()} onInput={(e) => setDraftName(e.currentTarget.value)} />
              </label>
              <label class="ad-field">
                <span class="ad-label">Message</span>
                <textarea class="ad-input ad-textarea" value={draftMessage()} placeholder={preview()} onInput={(e) => setDraftMessage(e.currentTarget.value)} />
              </label>
            </div>
            <footer class="ad-footer">
              <span class="ad-spacer" />
              <button type="button" class="ot-dlg-btn is-secondary" onClick={() => setView("main")}>Cancel</button>
              <button type="button" class="ot-dlg-btn is-main is-neutral" onClick={() => { setName(draftName()); setMessage(draftMessage()); setView("main"); }}>Apply</button>
            </footer>
          </Show>

          {/* ── Notifications ── */}
          <Show when={view() === "notifications"}>
            {subHeader("Notifications")}
            <div class="ad-body">
              <label class="ad-check">
                <input type="checkbox" checked={draftPopup()} onChange={() => setDraftPopup((v) => !v)} />
                <span class="ad-check-title">Show desktop notification</span>
                <span class="ad-check-desc">Displays a notification of the operating system when your alert triggers.</span>
              </label>
              {/* Webhook — POSTs the fire payload as JSON (see alert-engine). */}
              <label class="ad-check">
                <input type="checkbox" checked={draftWebhookOn()} onChange={() => setDraftWebhookOn((v) => !v)} />
                <span class="ad-check-title">Webhook URL</span>
                <span class="ad-check-desc">Sends a POST request to your specified URL when your alert triggers.</span>
              </label>
              <Show when={draftWebhookOn()}>
                <input
                  class="ad-input ad-indent"
                  type="url"
                  value={draftWebhookUrl()}
                  onInput={(e) => setDraftWebhookUrl(e.currentTarget.value)}
                  placeholder="https://example.com/alert-hook"
                  aria-label="Webhook URL"
                  aria-invalid={!draftWebhookValid() || undefined}
                  title={draftWebhookValid() ? undefined : "Enter an http:// or https:// URL"}
                />
              </Show>
              <label class="ad-check">
                <input type="checkbox" checked={draftSoundOn()} onChange={() => setDraftSoundOn((v) => !v)} />
                <span class="ad-check-title">Play sound</span>
                <span class="ad-check-desc">Plays an audio cue when your alert triggers.</span>
              </label>
              <Show when={draftSoundOn()}>
                <div class="ad-pair ad-indent">
                  <AdMenu variant="box" label="Sound" value={draftSound()} options={SOUND_OPTIONS.filter((s) => s.key).map((s) => ({ value: s.key, label: s.label }))} onPick={setDraftSound} />
                  <button type="button" class="ot-dlg-btn is-secondary" title="Preview sound" onClick={() => playAlertSound(draftSound(), { preview: true })}>Test</button>
                </div>
                <Show when={!alertSettings.soundEnabled()}>
                  <div class="ad-hint ad-indent">Alert sounds are off in Settings: this alert fires without sound.</div>
                </Show>
              </Show>
            </div>
            <footer class="ad-footer">
              <span class="ad-spacer" />
              <button type="button" class="ot-dlg-btn is-secondary" onClick={() => setView("main")}>Cancel</button>
              <button
                type="button"
                class="ot-dlg-btn is-main is-neutral"
                aria-disabled={!draftWebhookValid()}
                disabled={!draftWebhookValid()}
                onClick={() => {
                  setPopup(draftPopup());
                  setWebhookOn(draftWebhookOn());
                  setWebhookUrl(draftWebhookUrl());
                  setSound(draftSoundOn() ? draftSound() : "");
                  setView("main");
                }}
              >
                Apply
              </button>
            </footer>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
