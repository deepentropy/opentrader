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
import { typeIdOf } from "../window/chart/indicators/study-id";
import { currentInputs, currentTypeId } from "../window/chart/indicators/retired-ids";
import type { StudyFormat } from "./study-format";

/** A side of the condition. Price = the symbol's last/close; value = a fixed
 *  number; drawing = a chart drawing's price level (horizontal line/ray, trend
 *  line); indicator = an active study's plot value; symbol = the price of a
 *  symbol compared on the chart. */
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
      /** The line plot the alert reads (plotConfig index). */
      plot?: number;
      /** Set when the alert reads another output of the study (a shape, a
       *  character, an arrow, a candle's or a bar's price): its key
       *  (alert-outputs.ts outputKey); `plot` is then unused. */
      output?: string;
      label?: string;
      /** The study's full title with its inputs, as alert messages write it
       *  ("Moving average convergence divergence (close, 12, 26, 9)"); unset
       *  on older alerts (the label is used). */
      title?: string;
      /** Decimals of the study's values when it declares them (else the
       *  symbol's price format), for the amounts in messages. */
      precision?: number;
      /** The study's value format when it declares one (a price with its decimals, a volume, a percentage): the
       *  amounts in messages and in the dialog are written that way. */
      format?: StudyFormat;
      /** The study's inputs when the alert was made: the alert reads the
       *  study computed with them, whatever the chart shows later. Unset on
       *  older alerts (the charted study, else the factory inputs). */
      inputs?: Record<string, unknown>;
      /** Operator `alert_condition`: the study's own condition the alert
       *  watches (a script's alertcondition(), a TPO extended level), with
       *  its title and default message as the study declares them. */
      condition?: StudyConditionRef;
    }
  | {
      /** A compared symbol of the chart (its legend row): the alert reads
       *  that symbol's price, on the rule's interval and session. */
      kind: "symbol";
      /** Full name of the compared symbol ("NASDAQ:MSFT"). */
      symbol: string;
      /** As the dialog names it: "<description> (<exchange>)". */
      label?: string;
    };

/** A condition a study declares for alerts. */
export type StudyConditionRef = { id: string; title: string; message?: string };

export type DrawingShape = "channel" | "rectangle" | "time" | "position";

/** Condition operators. The `crossing_*` set needs the previous sample to
 *  detect the moment of crossing; `greater`/`less` are level checks;
 *  `moving_up` / `moving_down` (an amount) and `moving_*_pct` (a percentage):
 *  the LEFT operand moved up / down by at least the value (right operand)
 *  within the last `bars` bars;
 *  `entering` / `exiting` / `inside` / `outside`: the left operand against
 *  the band of a channel or rectangle drawing (right operand), or between
 *  two bounds (right = upper bound, `right2` = lower bound: values, the
 *  price or study plots);
 *  `hits_level`: the left operand reaches the entry, stop or target level
 *  of a long / short position drawing;
 *  `alert_condition`: a condition of the study on the left (its
 *  `condition`) is true on the current bar; the right operand is unused;
 *  `alert_function`: "Any alert() function call" of the script on the left:
 *  fires on its alert() calls, with their message and as often as each call
 *  allows (its freq argument); the rule's frequency and message are unused;
 *  `strategy_orders` / `strategy_orders_and_alerts` / `strategy_alerts`: a
 *  strategy on the left (its study id `strategy:<key>`): fires on each order
 *  fill (with the rule's message, filled with the order), on the fills and on
 *  the script's alert() calls, or on the calls only; the right operand is
 *  unused. */
export type AlertOperator =
  | "crossing"
  | "crossing_up"
  | "crossing_down"
  | "greater"
  | "less"
  | "moving_up"
  | "moving_down"
  | "moving_up_pct"
  | "moving_down_pct"
  | "entering"
  | "exiting"
  | "inside"
  | "outside"
  | "hits_level"
  | "alert_condition"
  | "alert_function"
  | "strategy_orders"
  | "strategy_orders_and_alerts"
  | "strategy_alerts";

/** How often a rule may fire (trigger-frequency options). */
export type AlertFrequency =
  | "only_once"
  | "once_per_bar"
  | "once_per_bar_close"
  | "every_time";

export type AlertStopReason = "triggered" | "manual" | "expired";

/** Days (ISO: 1 = Monday .. 7 = Sunday) and a daily time range ("HH:MM", "00:00"–"00:00" = all day) in a time
 *  zone (see alert-schedule.ts). */
export type AlertSchedule = { days: number[]; from: string; to: string; timeZone: string };

/** One condition of an alert: its source, operator, what it compares with and the interval it reads. */
export type AlertCondition = {
  left: Operand;
  op: AlertOperator;
  right: Operand;
  right2?: Operand;
  bars?: number;
  resolution: string;
};

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
  /** Channel conditions between two bounds: the lower bound (`right` is the
   *  upper one). Unset for a drawing's band. */
  right2?: Operand;
  /** Moving operators: the bar count ("in N bars", 1-300; unset = 1). */
  bars?: number;
  /** A multi-condition alert: the conditions after the first one (the rule's own fields above), each with its own
   *  interval; the alert fires when all of them hold at the same time (AND). Unset or empty = one condition. */
  and?: AlertCondition[];
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
  /** Show the in-app toast on fire (reference "Show toast notification"); unset = on. */
  toast?: boolean;
  /** Notification schedule: the notifications are muted outside it (the fire is still logged); unset = 24/7. */
  schedule?: AlertSchedule | null;
  enabled: boolean;
  /** Why a stopped alert stopped: it fired once ("triggered"), it was switched
   *  off ("manual") or its expiry passed ("expired"). Unset while active. */
  stopReason?: AlertStopReason;
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

/** An indicator operand saved under a retired library id reads its
 *  replacement, with its inputs renamed. */
function currentOperand<T>(op: T): T {
  const o = op as { kind?: string; indicatorId?: string; inputs?: Record<string, unknown> };
  if (o?.kind !== "indicator" || typeof o.indicatorId !== "string") return op;
  const type = typeIdOf(o.indicatorId);
  const next = currentTypeId(type);
  if (next === type) return op;
  return { ...o, indicatorId: next + o.indicatorId.slice(type.length), inputs: currentInputs(type, o.inputs) } as T;
}

function load(): StoreShape {
  let rules: AlertRule[] = [];
  let fires: AlertFire[] = [];
  try {
    const raw = kv.getItem(RULES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const current = <T extends { left: Operand; right: Operand; right2?: Operand }>(c: T): T =>
          ({ ...c, left: currentOperand(c.left), right: currentOperand(c.right), ...(c.right2 ? { right2: currentOperand(c.right2) } : {}) });
        rules = parsed.filter(isRule).map((r: AlertRule) => ({ ...current(r), ...(Array.isArray(r.and) && r.and.length ? { and: r.and.map(current) } : {}) }));
      }
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
    setState("rules", i, produce((r: AlertRule) => {
      Object.assign(r, patch, { activeSince: Date.now() });
      if (r.enabled) delete r.stopReason;
    }));
  },

  /** Switch a rule on or off; `reason`: why it stops (default: by hand). */
  setEnabled(id: string, enabled: boolean, reason: AlertStopReason = "manual"): void {
    const i = state.rules.findIndex((r) => r.id === id);
    if (i < 0) return;
    if (enabled && !state.rules[i].enabled) setState("rules", i, "activeSince", Date.now());
    setState("rules", i, produce((r: AlertRule) => {
      r.enabled = enabled;
      if (enabled) delete r.stopReason;
      else r.stopReason = reason;
    }));
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
