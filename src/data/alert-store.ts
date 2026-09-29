/*
 * Alert store — the configured alert *rules* plus the fired-event *log*.
 *
 * A local alerts subsystem: there is no alert backend, so the alert engine
 * (data/alert-engine.ts) evaluates rules client-side against the live tick
 * stream and appends fires here.
 *
 * The shapes are backend-ready: an `AlertRule` is a (left · operator · right)
 * condition over price / drawing / indicator operands; an `AlertFire` is a
 * `Fire` record. This keeps the door open to swap in a real backend later
 * without reshaping the UI.
 *
 * Process singleton with a createRoot autosave effect, same pattern as
 * watchlist-store.ts.
 */
import { createRoot, createEffect } from "solid-js";
import { createStore, produce } from "solid-js/store";
import * as kv from "./kv";

/** A side of the condition. Price = the symbol's last/close; value = a fixed
 *  number; drawing = a chart drawing's price level (horizontal line/ray, trend
 *  line); indicator = an active study's plot value. */
export type Operand =
  | { kind: "price" }
  | { kind: "value"; value: number }
  | { kind: "drawing"; drawingId: string; label?: string }
  | { kind: "indicator"; indicatorId: string; plot?: number; label?: string };

/** Condition operators. The `crossing_*` set needs the previous sample to
 *  detect the moment of crossing; `greater`/`less` are level checks;
 *  `moving_*_pct` compares the session change% to a threshold (value operand). */
export type AlertOperator =
  | "crossing"
  | "crossing_up"
  | "crossing_down"
  | "greater"
  | "less"
  | "moving_up_pct"
  | "moving_down_pct";

/** How often a rule may fire (trigger-frequency options). */
export type AlertFrequency =
  | "only_once"
  | "once_per_bar"
  | "once_per_bar_close"
  | "every_time";

export type AlertRule = {
  id: string;
  /** Bare ticker, uppercased (e.g. "AAPL"). */
  symbol: string;
  /** Interval label the rule was created on, for once-per-bar semantics and
   *  display (e.g. "1D", "5m"). */
  resolution: string;
  left: Operand;
  op: AlertOperator;
  right: Operand;
  frequency: AlertFrequency;
  /** User-supplied name; "" when unnamed. */
  name: string;
  /** Rendered alert message shown on fire and in the log. */
  message: string;
  /** Sound bank key, e.g. "alert/fired" (see data/alert-sounds.ts). "" = silent. */
  sound: string;
  /** Show a desktop/OS notification on fire (vs. toast + log only). */
  popup: boolean;
  enabled: boolean;
  createdAt: number;
  /** Epoch ms after which the rule auto-disables; null = no expiry. */
  expiresAt: number | null;
};

/** A fired event: a `Fire` record, trimmed to the fields we can populate
 *  locally. */
export type AlertFire = {
  fireId: string;
  alertId: string;
  symbol: string;
  resolution: string;
  name: string | null;
  message: string;
  /** Epoch ms when the condition fired. */
  fireTime: number;
  /** Bar-open epoch ms of the firing bar, when known. */
  barTime: number | null;
  soundFile: string;
  /** Symbol logo for the log row, when resolvable. */
  logoUrl: string | null;
};

type StoreShape = { rules: AlertRule[]; fires: AlertFire[] };

const RULES_KEY = "ot:alerts:v1";
const FIRES_KEY = "ot:alert-fires:v1";
/** Cap the persisted log so it can't grow without bound. */
const MAX_FIRES = 200;

let idSeq = 0;
/** Monotonic-ish unique id. Date.now keeps ids sortable across reloads; the
 *  counter disambiguates ids minted within the same millisecond. */
function uid(prefix: string): string {
  idSeq = (idSeq + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

function isRule(r: unknown): r is AlertRule {
  return (
    !!r &&
    typeof r === "object" &&
    typeof (r as AlertRule).id === "string" &&
    typeof (r as AlertRule).symbol === "string" &&
    !!(r as AlertRule).left &&
    !!(r as AlertRule).right &&
    typeof (r as AlertRule).op === "string"
  );
}

function load(): StoreShape {
  let rules: AlertRule[] = [];
  let fires: AlertFire[] = [];
  try {
    const raw = kv.getItem(RULES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) rules = parsed.filter(isRule);
    }
  } catch {
    /* malformed — start empty */
  }
  try {
    const raw = kv.getItem(FIRES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) fires = parsed.filter((f) => f && typeof f === "object");
    }
  } catch {
    /* malformed — start empty */
  }
  return { rules, fires };
}

const [state, setState] = createStore<StoreShape>(load());

// Autosave: root-scoped effects mirror rules + fires to storage on change.
createRoot(() => {
  createEffect(() => {
    try {
      kv.setItem(RULES_KEY, JSON.stringify(state.rules));
    } catch {
      /* best-effort */
    }
  });
  createEffect(() => {
    try {
      kv.setItem(FIRES_KEY, JSON.stringify(state.fires));
    } catch {
      /* best-effort */
    }
  });
});

// Live cross-window sync: when another window edits rules/fires, re-load the
// whole shape. setState merges the top-level keys; the autosave effects above
// then re-serialise to identical strings, which kv.setItem dedups to no-ops.
kv.onExternalChange(RULES_KEY, () => setState(load()));
kv.onExternalChange(FIRES_KEY, () => setState(load()));

/** Fields the caller supplies when creating a rule; the store fills in id /
 *  createdAt / enabled defaults. */
export type NewAlertRule = Omit<AlertRule, "id" | "createdAt" | "enabled"> & {
  enabled?: boolean;
};

export const alertStore = {
  rules: () => state.rules,
  fires: () => state.fires,
  rule: (id: string): AlertRule | undefined => state.rules.find((r) => r.id === id),
  rulesFor: (symbol: string): AlertRule[] => {
    const up = symbol.toUpperCase();
    return state.rules.filter((r) => r.symbol === up);
  },
  enabledRules: (): AlertRule[] => state.rules.filter((r) => r.enabled),

  /** Create a rule and return its id. */
  add(rule: NewAlertRule): string {
    const id = uid("al");
    const full: AlertRule = {
      ...rule,
      symbol: rule.symbol.toUpperCase(),
      enabled: rule.enabled ?? true,
      id,
      createdAt: Date.now(),
    };
    setState("rules", (rs) => [...rs, full]);
    return id;
  },

  /** Patch an existing rule in place. */
  update(id: string, patch: Partial<Omit<AlertRule, "id">>): void {
    const i = state.rules.findIndex((r) => r.id === id);
    if (i < 0) return;
    setState("rules", i, produce((r: AlertRule) => Object.assign(r, patch)));
  },

  setEnabled(id: string, enabled: boolean): void {
    const i = state.rules.findIndex((r) => r.id === id);
    if (i >= 0) setState("rules", i, "enabled", enabled);
  },

  remove(id: string): void {
    setState("rules", (rs) => rs.filter((r) => r.id !== id));
  },

  clearRules(): void {
    setState("rules", []);
  },

  /** Append a fired event to the log (newest first), capped at MAX_FIRES. */
  recordFire(fire: Omit<AlertFire, "fireId">): AlertFire {
    const full: AlertFire = { ...fire, fireId: uid("fire") };
    setState("fires", (fs) => [full, ...fs].slice(0, MAX_FIRES));
    return full;
  },

  clearFires(): void {
    setState("fires", []);
  },
};
