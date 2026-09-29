/*
 * AlertDialog — create or edit a single alert rule.
 *
 * A real, condition-based alert (the per-symbol counterpart to the watchlist's
 * list-level AddAlertDialog). Ports TV's create-alert dialog shape: a
 * (left · operator · right) condition over price / drawing / indicator
 * operands, plus trigger frequency, name, message, sound and an optional
 * expiry. Saving writes to alert-store; the engine evaluates it live.
 *
 * Opened from the header "Create alert" button and the chart context menu
 * (prefilled with the clicked symbol + price), or with an `editId` to edit.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import {
  alertStore,
  type AlertFrequency,
  type AlertOperator,
  type Operand,
} from "../../data/alert-store";
import {
  OPERATOR_LABELS,
  describeCondition,
  isPercentOperator,
  priceableDrawings,
} from "../../data/alert-condition";
import { indicatorLegendFor } from "../../data/chart-state-registry";
import { SOUND_OPTIONS, playAlertSound } from "../../data/alert-sounds";
import {
  alertWebhook,
  ensureNotificationPermission,
  resetRuleEvalState,
  setAlertWebhook,
} from "../../data/alert-engine";

type Props = {
  /** When set, edit this existing rule instead of creating one. */
  editId?: string;
  /** Prefill symbol (bare ticker) for new rules. */
  symbol?: string;
  /** Prefill the right-hand value (e.g. the clicked chart price). */
  price?: number;
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

const FREQUENCIES: { key: AlertFrequency; label: string }[] = [
  { key: "once_per_bar", label: "Once per bar" },
  { key: "once_per_bar_close", label: "Once per bar close" },
  { key: "only_once", label: "Only once" },
  { key: "every_time", label: "Every time" },
];

const EXPIRIES: { key: string; label: string; ms: number | null }[] = [
  { key: "never", label: "No expiration", ms: null },
  { key: "1d", label: "In 1 day", ms: 86_400_000 },
  { key: "1w", label: "In 1 week", ms: 604_800_000 },
  { key: "1m", label: "In 30 days", ms: 2_592_000_000 },
];

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
      return [...opts, { id: r.drawingId, label: r.label ?? "drawing" }];
    }
    return opts;
  });

  // Expiry choices; when editing a rule that already has an expiry, offer a
  // "Keep current" option so the dropdown doesn't misleadingly read "No expiration".
  const expiryOptions = () =>
    existing?.expiresAt != null
      ? [
          { key: "custom", label: `Keep current (${new Date(existing.expiresAt).toLocaleDateString()})`, ms: null },
          ...EXPIRIES,
        ]
      : EXPIRIES;

  // ── Left operand ── price or an indicator plot.
  const [leftKind, setLeftKind] = createSignal<"price" | "indicator">(
    existing?.left.kind === "indicator" ? "indicator" : "price",
  );
  const [leftIndicator, setLeftIndicator] = createSignal(
    existing?.left.kind === "indicator" ? existing.left.indicatorId : "",
  );

  const [op, setOp] = createSignal<AlertOperator>(existing?.op ?? "crossing");

  // ── Right operand ── a value, a drawing level, or an indicator plot.
  const [rightKind, setRightKind] = createSignal<SideKind>(
    existing?.right.kind === "drawing"
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
    existing?.right.kind === "drawing" ? existing.right.drawingId : "",
  );
  const [rightIndicator, setRightIndicator] = createSignal(
    existing?.right.kind === "indicator" ? existing.right.indicatorId : "",
  );

  // ── % threshold (for moving_up_pct / moving_down_pct) ──
  const [pct, setPct] = createSignal(
    isPercentOperator(existing?.op ?? "crossing") && existing?.right.kind === "value"
      ? String(existing.right.value)
      : "5",
  );

  const [frequency, setFrequency] = createSignal<AlertFrequency>(existing?.frequency ?? "once_per_bar");
  const [name, setName] = createSignal(existing?.name ?? "");
  const [message, setMessage] = createSignal(existing?.message ?? "");
  const [sound, setSound] = createSignal(existing?.sound ?? "fired");
  const [popup, setPopup] = createSignal(existing?.popup ?? true);
  // Webhook — persisted per-rule beside the store (see alert-engine's kv map).
  const existingWebhook = existing ? alertWebhook(existing.id) : null;
  const [webhookOn, setWebhookOn] = createSignal(existingWebhook != null);
  const [webhookUrl, setWebhookUrl] = createSignal(existingWebhook ?? "");
  const [expiry, setExpiry] = createSignal(
    existing?.expiresAt == null ? "never" : "custom",
  );

  const isPct = () => isPercentOperator(op());

  function buildLeft(): Operand {
    if (leftKind() === "indicator" && leftIndicator()) {
      const o = indicatorOptions().find((x) => x.id === leftIndicator());
      return { kind: "indicator", indicatorId: leftIndicator(), plot: 0, label: o?.label };
    }
    return { kind: "price" };
  }

  function buildRight(): Operand {
    if (isPct()) return { kind: "value", value: parseFloat(pct()) || 0 };
    switch (rightKind()) {
      case "drawing": {
        const o = drawingOptions().find((x) => x.id === rightDrawing());
        return { kind: "drawing", drawingId: rightDrawing(), label: o?.label };
      }
      case "indicator": {
        const o = indicatorOptions().find((x) => x.id === rightIndicator());
        return { kind: "indicator", indicatorId: rightIndicator(), plot: 0, label: o?.label };
      }
      default:
        return { kind: "value", value: parseFloat(rightValue()) || 0 };
    }
  }

  /** Live preview of the condition, used as the message placeholder. */
  const preview = createMemo(() => {
    const sym = symbol() || "—";
    return `${sym} ${describeCondition({ left: buildLeft(), op: op(), right: buildRight() })}`;
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
    let expiresAt: number | null;
    if (expiry() === "custom") {
      expiresAt = existing?.expiresAt ?? null; // unchanged
    } else {
      const e = expiryOptions().find((x) => x.key === expiry());
      expiresAt = e?.ms != null ? Date.now() + e.ms : null;
    }

    const rule = {
      symbol: symbol().trim().toUpperCase(),
      resolution: existing?.resolution ?? props.interval,
      left: buildLeft(),
      op: op(),
      right: buildRight(),
      frequency: frequency(),
      name: name().trim(),
      message: message().trim(),
      sound: sound(),
      popup: popup(),
      expiresAt,
    };

    if (popup()) ensureNotificationPermission();

    let id: string;
    if (existing) {
      alertStore.update(existing.id, { ...rule, enabled: true });
      // The condition may have changed — drop the stale crossing baseline so the
      // next tick re-establishes it instead of manufacturing a spurious cross.
      resetRuleEvalState(existing.id);
      id = existing.id;
    } else {
      id = alertStore.add(rule);
    }
    setAlertWebhook(id, webhookOn() ? webhookUrl() : null);
    props.onClose();
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      } else if (existing && e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        // TV shortcuts page: "Save changes in the Edit alert dialog" = Ctrl+Enter.
        // (Not verified for the Create dialog, so it is bound for Edit only.)
        e.preventDefault();
        e.stopPropagation();
        save();
      }
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  return (
    <Portal mount={document.body}>
      <div class="wl-dialog-backdrop" role="presentation" onMouseDown={() => props.onClose()}>
        <div
          class="wl-dialog alert-dialog"
          role="dialog"
          aria-label={existing ? "Edit alert" : "Create alert"}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header class="wl-dialog-header">
            <span class="wl-dialog-title">{existing ? "Edit alert" : "Create alert"}</span>
            <button type="button" class="wl-dialog-close" aria-label="Close" onClick={() => props.onClose()}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
                <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
              </svg>
            </button>
          </header>

          <div class="wl-dialog-body alert-dialog-body">
            {/* Symbol */}
            <label class="alert-dialog-row">
              <span class="alert-dialog-label">Symbol</span>
              <input
                class="wl-dialog-input"
                type="text"
                value={symbol()}
                onInput={(e) => setSymbol(e.currentTarget.value.toUpperCase())}
                placeholder="AAPL"
              />
            </label>

            {/* Condition — left · operator · right */}
            <div class="alert-dialog-row">
              <span class="alert-dialog-label">Condition</span>
              <div class="alert-dialog-condition">
                <select
                  class="wl-dialog-input"
                  value={leftKind() === "indicator" ? `ind:${leftIndicator()}` : "price"}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    if (v === "price") setLeftKind("price");
                    else {
                      setLeftKind("indicator");
                      setLeftIndicator(v.slice(4));
                    }
                  }}
                >
                  <option value="price">Price</option>
                  <For each={indicatorOptions()}>
                    {(r) => <option value={`ind:${r.id}`}>{r.label}</option>}
                  </For>
                </select>

                <select
                  class="wl-dialog-input"
                  value={op()}
                  onChange={(e) => setOp(e.currentTarget.value as AlertOperator)}
                >
                  <For each={OPERATORS}>
                    {(o) => <option value={o}>{OPERATOR_LABELS[o]}</option>}
                  </For>
                </select>

                <Show
                  when={!isPct()}
                  fallback={
                    <div class="alert-dialog-pct">
                      <input
                        class="wl-dialog-input"
                        type="number"
                        step="0.5"
                        min="0"
                        value={pct()}
                        onInput={(e) => setPct(e.currentTarget.value)}
                      />
                      <span class="wl-dialog-suffix">%</span>
                    </div>
                  }
                >
                  <div class="alert-dialog-right">
                    <select
                      class="wl-dialog-input alert-dialog-right-kind"
                      value={rightKind()}
                      onChange={(e) => setRightKind(e.currentTarget.value as SideKind)}
                    >
                      <option value="value">Value</option>
                      <option value="drawing" disabled={drawingOptions().length === 0}>
                        Drawing
                      </option>
                      <option value="indicator" disabled={indicatorOptions().length === 0}>
                        Indicator
                      </option>
                    </select>
                    <Show when={rightKind() === "value"}>
                      <input
                        class="wl-dialog-input"
                        type="number"
                        step="any"
                        value={rightValue()}
                        onInput={(e) => setRightValue(e.currentTarget.value)}
                        placeholder="0.00"
                      />
                    </Show>
                    <Show when={rightKind() === "drawing"}>
                      <select
                        class="wl-dialog-input"
                        value={rightDrawing()}
                        onChange={(e) => setRightDrawing(e.currentTarget.value)}
                      >
                        <option value="">Select drawing…</option>
                        <For each={drawingOptions()}>
                          {(d) => <option value={d.id}>{d.label}</option>}
                        </For>
                      </select>
                    </Show>
                    <Show when={rightKind() === "indicator"}>
                      <select
                        class="wl-dialog-input"
                        value={rightIndicator()}
                        onChange={(e) => setRightIndicator(e.currentTarget.value)}
                      >
                        <option value="">Select indicator…</option>
                        <For each={indicatorOptions()}>
                          {(r) => <option value={r.id}>{r.label}</option>}
                        </For>
                      </select>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>

            {/* Trigger frequency */}
            <label class="alert-dialog-row">
              <span class="alert-dialog-label">Trigger</span>
              <select
                class="wl-dialog-input"
                value={frequency()}
                onChange={(e) => setFrequency(e.currentTarget.value as AlertFrequency)}
              >
                <For each={FREQUENCIES}>
                  {(f) => <option value={f.key}>{f.label}</option>}
                </For>
              </select>
            </label>

            {/* Expiration */}
            <label class="alert-dialog-row">
              <span class="alert-dialog-label">Expiration</span>
              <select
                class="wl-dialog-input"
                value={expiry()}
                onChange={(e) => setExpiry(e.currentTarget.value)}
              >
                <For each={expiryOptions()}>
                  {(x) => <option value={x.key}>{x.label}</option>}
                </For>
              </select>
            </label>

            {/* Name */}
            <label class="alert-dialog-row">
              <span class="alert-dialog-label">Name</span>
              <input
                class="wl-dialog-input"
                type="text"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                placeholder="Optional"
              />
            </label>

            {/* Message */}
            <label class="alert-dialog-row">
              <span class="alert-dialog-label">Message</span>
              <textarea
                class="wl-dialog-input alert-dialog-message"
                rows={2}
                value={message()}
                onInput={(e) => setMessage(e.currentTarget.value)}
                placeholder={preview()}
              />
            </label>

            {/* Sound + popup */}
            <label class="alert-dialog-row">
              <span class="alert-dialog-label">Sound</span>
              <div class="alert-dialog-right">
                <select
                  class="wl-dialog-input"
                  value={sound()}
                  onChange={(e) => setSound(e.currentTarget.value)}
                >
                  <For each={SOUND_OPTIONS}>
                    {(s) => <option value={s.key}>{s.label}</option>}
                  </For>
                </select>
                <button
                  type="button"
                  class="wl-dialog-btn"
                  onClick={() => playAlertSound(sound())}
                  disabled={!sound()}
                  title="Preview sound"
                >
                  Test
                </button>
              </div>
            </label>

            <label class="alert-dialog-check">
              <input type="checkbox" checked={popup()} onChange={() => setPopup((v) => !v)} />
              <span>Show a desktop notification when it fires</span>
            </label>

            {/* Webhook — POSTs the fire payload as JSON (see alert-engine). */}
            <label class="alert-dialog-check">
              <input type="checkbox" checked={webhookOn()} onChange={() => setWebhookOn((v) => !v)} />
              <span>Webhook URL</span>
            </label>
            <Show when={webhookOn()}>
              <input
                class="wl-dialog-input"
                type="url"
                value={webhookUrl()}
                onInput={(e) => setWebhookUrl(e.currentTarget.value)}
                placeholder="https://example.com/hook"
                aria-label="Webhook URL"
                aria-invalid={!webhookValid() || undefined}
                style={{ "border-color": webhookValid() ? undefined : "var(--color-invalid-symbol)" }}
                title={webhookValid() ? undefined : "Enter an http:// or https:// URL"}
              />
            </Show>
          </div>

          <footer class="wl-dialog-footer">
            <Show when={existing}>
              <button
                type="button"
                class="wl-dialog-btn wl-dialog-btn--danger"
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
            <span class="wl-dialog-spacer" />
            <button type="button" class="wl-dialog-btn" onClick={() => props.onClose()}>
              Cancel
            </button>
            <button
              type="button"
              class="wl-dialog-btn wl-dialog-btn--primary"
              disabled={!canSave()}
              onClick={save}
            >
              {existing ? "Save" : "Create"}
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
