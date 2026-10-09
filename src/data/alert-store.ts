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
import type { SessionId } from "./session/symbol-sessions";
import { createRoot, createEffect } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { isFullSymbol, toFullSymbol } from "./datafeed";
import { migrateDrawingKey } from "../window/drawings/persistence";
import * as kv from "./kv";

/** A side of the condition. Price = the symbol's last/close; value = a fixed
 *  number; drawing = a chart drawing's price level (horizontal line/ray, trend
 *  line); indicator = an active study's plot value. */
export type Operand =
  | { kind: "price" }
  | { kind: "value"; value: number }
  | {
      kind: "drawing";
      drawingId: string;
      label?: string;
      /** What the drawing gives the condition when it is not one price
       *  level: two bounds (channel, rectangle), a time (vertical line) or
       *  the entry / stop / target levels of a position. */
      band?: DrawingShape;
      /** Fib tools: the coefficient of the level the alert reads (the upper
       *  bound of a channel condition). */
      level?: number;
      /** Fib tools, channel conditions: the coefficient of the lower bound. */
      level2?: number;
      /** Anchored VWAP: which of its lines the alert reads (index in
       *  VWAP_PLOTS: the VWAP, the three lower bands, the three upper
       *  bands). */
      plot?: number;
    }
  | {
      kind: "indicator";
      indicatorId: string;
      plot?: number;
      label?: string;
      /** The study's inputs when the alert was made: the alert reads the
       *  study computed with them, whatever the chart shows later. Unset on
       *  older alerts (the charted study, else the factory inputs). */
      inputs?: Record<string, unknown>;
    };

export type DrawingShape = "channel" | "rectangle" | "time" | "position";

/** Condition operators. The `crossing_*` set needs the previous sample to
 *  detect the moment of crossing; `greater`/`less` are level checks;
 *  `moving_*_pct`: the LEFT operand moved up / down by at least the value
 *  (right operand, %) within the last `bars` bars;
 *  `entering` / `exiting` / `inside` / `outside`: the left operand against
 *  the band of a channel or rectangle drawing (right operand);
 *  `hits_level`: the left operand reaches the entry, stop or target level
 *  of a long / short position drawing. */
export type AlertOperator =
  | "crossing"
  | "crossing_up"
  | "crossing_down"
  | "greater"
  | "less"
  | "moving_up_pct"
  | "moving_down_pct"
  | "entering"
  | "exiting"
  | "inside"
  | "outside"
  | "hits_level";

/** How often a rule may fire (trigger-frequency options). */
export type AlertFrequency =
  | "only_once"
  | "once_per_bar"
  | "once_per_bar_close"
  | "every_time";

export type AlertRule = {
  id: string;
  /** Full name, uppercased ("NASDAQ:AAPL"); rules saved before full names
   *  hold a bare ticker until migrated (see below). */
  symbol: string;
  /** Interval label the rule was created on, for once-per-bar semantics and
   *  display (e.g. "1D", "5m"). */
  resolution: string;
  /** Session of the chart the rule was made on (regular or extended hours),
   *  for the operands computed from bars. Unset on older rules. */
  session?: SessionId;
  left: Operand;
  op: AlertOperator;
  right: Operand;
  /** Moving % operators: the bar count ("in N bars", 1-300; unset = 1). */
  bars?: number;
  frequency: AlertFrequency;
  /** User-supplied name; "" when unnamed. */
  name: string;
  /** Rendered alert message shown on fire and in the log. */
  message: string;
  /** Sound bank key, e.g. "alert/fired" (see data/alert-sounds.ts). "" = silent. */
  sound: string;
  /** Seconds the sound keeps playing, started again each time it ends (0 or unset = once). */
  soundDuration?: number;
  /** Show a desktop/OS notification on fire (vs. toast + log only). */
  popup: boolean;
  enabled: boolean;
  createdAt: number;
  /** Epoch ms the rule last became active (created, edited, switched on):
   *  nothing before it counts as missed. Unset on older rules (= createdAt). */
  activeSince?: number;
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
  /** Found at start in the bars missed while the app was not running:
   *  logged, not announced. `fireTime` is then the time of the bar. */
  offline?: boolean;
  /** Epoch ms the event entered the log, when it differs from `fireTime`
   *  (offline events): what the unread mark compares. */
  receivedAt?: number;
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

// Rules saved with a bare ticker get their primary listing once (the live
// events and the chart state are keyed by the full name); the drawings an
// operand points at move with them.
void (async () => {
  const bare = [...new Set(state.rules.map((r) => r.symbol).filter((s) => !isFullSymbol(s)))];
  for (const b of bare) {
    try {
      const full = await toFullSymbol(b);
      migrateDrawingKey(b, full);
      setState("rules", (r) => r.symbol === b, "symbol", full);
    } catch {
      /* lookup failed (offline): retried on the next start */
    }
  }
})();

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
      activeSince: Date.now(),
    };
    setState("rules", (rs) => [...rs, full]);
    return id;
  },

  /** Patch an existing rule in place. */
  update(id: string, patch: Partial<Omit<AlertRule, "id">>): void {
    const i = state.rules.findIndex((r) => r.id === id);
    if (i < 0) return;
    setState("rules", i, produce((r: AlertRule) => Object.assign(r, patch, { activeSince: Date.now() })));
  },

  setEnabled(id: string, enabled: boolean): void {
    const i = state.rules.findIndex((r) => r.id === id);
    if (i < 0) return;
    if (enabled && !state.rules[i].enabled) setState("rules", i, "activeSince", Date.now());
    setState("rules", i, "enabled", enabled);
  },

  remove(id: string): void {
    setState("rules", (rs) => rs.filter((r) => r.id !== id));
  },

  clearRules(): void {
    setState("rules", []);
  },

  /** Add a fired event to the log (newest first; an offline event takes the
   *  place of its own time), capped at MAX_FIRES. */
  recordFire(fire: Omit<AlertFire, "fireId">): AlertFire {
    const full: AlertFire = { ...fire, fireId: uid("fire") };
    setState("fires", (fs) => {
      const at = fs.findIndex((f) => f.fireTime <= full.fireTime);
      return (at < 0 ? [...fs, full] : [...fs.slice(0, at), full, ...fs.slice(at)]).slice(0, MAX_FIRES);
    });
    return full;
  },

  clearFires(): void {
    setState("fires", []);
  },
};
