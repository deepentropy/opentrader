/*
 * Alert tools of Settings > Coding agents: list the alerts and their log, create price, drawing and stock-screen
 * alerts, switch them on or off, edit and delete them. They write the same rules as the alert dialog (alert-store.ts):
 * the alert engine watches them at once, and they show in the Alerts panel.
 */
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { isFullSymbol, toFullSymbol } from "../data/datafeed";
import { describeCondition, drawingBandType, drawingCanAlert, drawingLabel, isMovingOperator, shapeOperators, LEVEL_OPERATORS, BAND_OPERATORS } from "../data/alert-condition";
import { resetRuleEvalState, setAlertWebhook } from "../data/alert-engine";
import { alertStore, isScreenRule, type AlertFrequency, type AlertOperator, type AlertRule, type NewAlertRule, type Operand } from "../data/alert-store";
import { screenerStore } from "../data/screener-store";
import { setActiveRailTab } from "../window/shell/app-dialogs";
import { AgentError, type AgentTool } from "./mcp";

/** The focused chart, as the alerts need it. */
export type AlertChart = { symbol: string; interval: string; session?: string; drawings: () => Drawing[] };

const MOVING: AlertOperator[] = ["moving_up", "moving_down", "moving_up_pct", "moving_down_pct"];
const SCREEN: AlertOperator[] = ["screen_enter", "screen_exit"];
const CONDITIONS: AlertOperator[] = [...LEVEL_OPERATORS, ...BAND_OPERATORS, ...MOVING, ...SCREEN];
const FREQUENCIES: AlertFrequency[] = ["only_once", "once_per_bar", "once_per_bar_close", "every_time"];

const status = (r: AlertRule) => (r.enabled ? "active" : r.stopReason === "triggered" ? "triggered" : r.stopReason === "expired" ? "expired" : "stopped");

const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new AgentError(`"${what}" must be a number.`);
  return v;
};

/** "YYYY-MM-DD[ HH:MM]" (local time) or UNIX seconds → epoch ms. */
function expiryOf(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const ms = typeof v === "number" ? v * 1000 : Date.parse(String(v).replace(" ", "T"));
  if (!Number.isFinite(ms) || ms <= Date.now()) throw new AgentError('"expires": a future date "YYYY-MM-DD", "YYYY-MM-DD HH:MM" or UNIX seconds.');
  return ms;
}

function ruleView(r: AlertRule) {
  return {
    id: r.id,
    ...(r.name ? { name: r.name } : {}),
    symbol: r.symbol || undefined,
    condition: describeCondition(r),
    ...(r.and?.length ? { andConditions: r.and.length } : {}),
    interval: r.resolution || undefined,
    frequency: r.frequency,
    status: status(r),
    ...(r.message ? { message: r.message } : {}),
    ...(r.expiresAt ? { expires: new Date(r.expiresAt).toISOString() } : {}),
  };
}

function ruleNamed(id: unknown): AlertRule {
  const r = typeof id === "string" ? alertStore.rule(id) : undefined;
  if (!r) throw new AgentError(`No alert "${String(id)}": see list_alerts.`);
  return r;
}

export function createAlertTools(chart: () => AlertChart): AgentTool[] {
  /** The right side of a condition on the focused chart's drawing. */
  function drawingOperand(id: string, op: AlertOperator, symbol: string): Operand {
    const c = chart();
    if (symbol !== c.symbol) throw new AgentError(`A drawing alert is on the focused chart's symbol (${c.symbol}).`);
    const d = c.drawings().find((x) => x.id === id);
    if (!d) throw new AgentError(`No drawing "${id}" on the focused chart: see list_drawings.`);
    const band = drawingBandType(d.kind);
    if (!drawingCanAlert(d.kind) || d.kind.startsWith("fib") || d.kind === "anchored-vwap" || band === "position" || band === "time") {
      throw new AgentError(`An alert on a ${drawingLabel(d)} is made in the alert dialog (its levels or lines): this tool takes lines, channels and rectangles.`);
    }
    const ops = shapeOperators(band) ?? LEVEL_OPERATORS;
    if (!ops.includes(op)) throw new AgentError(`A ${drawingLabel(d)} takes the conditions ${ops.join(", ")}.`);
    return { kind: "drawing", drawingId: id, label: drawingLabel(d), ...(band ? { band } : {}) };
  }

  return [
    {
      name: "list_alerts",
      title: "List alerts",
      description: "The user's alerts (id, symbol, condition, interval, frequency, status: active, triggered, stopped, expired) and the latest fired events of the log.",
      inputSchema: { type: "object", properties: { symbol: { type: "string", description: "Only the alerts of this symbol." }, fired: { type: "integer", description: "Log events to return (default 20)." } } },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const want = typeof args.symbol === "string" && args.symbol.trim() ? args.symbol.trim().toUpperCase() : null;
        const match = (s: string) => !want || s === want || s.split(":").pop() === want.split(":").pop();
        const n = Math.min(200, Math.max(0, Math.floor(Number(args.fired ?? 20)) || 0));
        return {
          alerts: alertStore.rules().filter((r) => match(r.symbol)).map(ruleView),
          fired: alertStore.fires().filter((f) => match(f.symbol)).slice(0, n).map((f) => ({ alertId: f.alertId, symbol: f.symbol, message: f.message, time: new Date(f.fireTime).toISOString() })),
        };
      },
    },
    {
      name: "create_alert",
      title: "Create alert",
      description:
        "Create an alert and show the Alerts panel. condition: crossing, crossing_up, crossing_down, greater, less (with value or drawingId); " +
        "entering, exiting, inside, outside (with low and high, or the drawingId of a channel or rectangle); moving_up, moving_down (an amount), moving_up_pct, moving_down_pct (a percentage) with value and bars; " +
        "screen_enter, screen_exit (with screen: a saved stock screen's name; a symbol entering or leaving its results). " +
        "symbol: default the focused chart's; interval: default the focused chart's. frequency: only_once (default), once_per_bar, once_per_bar_close, every_time. " +
        "The message defaults to the condition. Alerts on study values are made in the alert dialog.",
      inputSchema: {
        type: "object",
        properties: {
          condition: { type: "string", enum: CONDITIONS },
          symbol: { type: "string" },
          value: { type: "number" },
          low: { type: "number" },
          high: { type: "number" },
          bars: { type: "integer", description: "Moving conditions: within this many bars (1-300, default 1)." },
          drawingId: { type: "string" },
          screen: { type: "string" },
          interval: { type: "string" },
          frequency: { type: "string", enum: FREQUENCIES },
          name: { type: "string" },
          message: { type: "string" },
          expires: { type: ["string", "number"], description: '"YYYY-MM-DD", "YYYY-MM-DD HH:MM" or UNIX seconds (default: no expiry).' },
        },
        required: ["condition"],
      },
      run: async (args) => {
        const op = CONDITIONS.find((c) => c === args.condition);
        if (!op) throw new AgentError(`"condition": one of ${CONDITIONS.join(", ")}.`);
        const frequency = args.frequency === undefined ? "only_once" : FREQUENCIES.find((f) => f === args.frequency);
        if (!frequency) throw new AgentError(`"frequency": one of ${FREQUENCIES.join(", ")}.`);
        const common = {
          name: typeof args.name === "string" ? args.name.trim() : "",
          message: typeof args.message === "string" ? args.message.trim() : "",
          sound: "fired",
          soundDuration: 0,
          popup: true,
          toast: true,
          expiresAt: expiryOf(args.expires),
        };
        let rule: NewAlertRule;
        if (SCREEN.includes(op)) {
          const name = typeof args.screen === "string" ? args.screen.trim().toLowerCase() : "";
          const s = screenerStore.savedScreens().find((x) => x.screen.title.toLowerCase() === name);
          if (!s) throw new AgentError(`"screen": the name of a saved stock screen (list_screens; save_screen makes one).`);
          rule = { ...common, symbol: "", resolution: "", left: { kind: "screen", screenId: s.id, title: s.screen.title }, op, right: { kind: "value", value: 0 }, frequency: "every_time" };
        } else {
          const c = chart();
          const asked = typeof args.symbol === "string" && args.symbol.trim() ? args.symbol.trim().toUpperCase() : c.symbol;
          const symbol = isFullSymbol(asked) ? asked : await toFullSymbol(asked).catch(() => {
            throw new AgentError(`Unknown symbol "${asked}".`);
          });
          let right: Operand;
          let right2: Operand | undefined;
          let bars: number | undefined;
          if (typeof args.drawingId === "string") right = drawingOperand(args.drawingId, op, symbol);
          else if (BAND_OPERATORS.includes(op)) {
            const lo = num(args.low, "low");
            const hi = num(args.high, "high");
            right = { kind: "value", value: Math.max(lo, hi) };
            right2 = { kind: "value", value: Math.min(lo, hi) };
          } else {
            right = { kind: "value", value: num(args.value, "value") };
            if (isMovingOperator(op)) {
              bars = args.bars === undefined ? 1 : Math.floor(num(args.bars, "bars"));
              if (bars < 1 || bars > 300) throw new AgentError('"bars": 1 to 300.');
            }
          }
          const interval = typeof args.interval === "string" && args.interval.trim() ? args.interval.trim() : c.interval;
          rule = {
            ...common,
            symbol,
            resolution: interval,
            ...(symbol === c.symbol && c.session ? { session: c.session as AlertRule["session"] } : {}),
            left: { kind: "price" },
            op,
            right,
            ...(right2 ? { right2 } : {}),
            ...(bars !== undefined ? { bars } : {}),
            frequency,
          };
        }
        const id = alertStore.add(rule);
        setActiveRailTab("alerts");
        return ruleView(alertStore.rule(id)!);
      },
    },
    {
      name: "update_alert",
      title: "Update alert",
      description:
        "Change an alert: enabled (switch it on or off), value / low / high / bars (its condition's numbers), frequency, name, message, expires (null: no expiry). An edited alert starts again.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          enabled: { type: "boolean" },
          value: { type: "number" },
          low: { type: "number" },
          high: { type: "number" },
          bars: { type: "integer" },
          frequency: { type: "string", enum: FREQUENCIES },
          name: { type: "string" },
          message: { type: "string" },
          expires: { type: ["string", "number", "null"] },
        },
        required: ["id"],
      },
      run: async (args) => {
        const r = ruleNamed(args.id);
        const patch: Partial<AlertRule> = {};
        let condition = false;
        if (args.value !== undefined) {
          if (r.right.kind !== "value" || r.right2 || isScreenRule(r)) throw new AgentError("This alert's condition has no single value.");
          patch.right = { kind: "value", value: num(args.value, "value") };
          condition = true;
        }
        if (args.low !== undefined || args.high !== undefined) {
          if (!r.right2 || r.right.kind !== "value" || r.right2.kind !== "value") throw new AgentError("This alert has no low / high bounds.");
          const hi = args.high === undefined ? r.right.value : num(args.high, "high");
          const lo = args.low === undefined ? r.right2.value : num(args.low, "low");
          patch.right = { kind: "value", value: Math.max(lo, hi) };
          patch.right2 = { kind: "value", value: Math.min(lo, hi) };
          condition = true;
        }
        if (args.bars !== undefined) {
          if (!isMovingOperator(r.op)) throw new AgentError("Only a moving condition has bars.");
          const b = Math.floor(num(args.bars, "bars"));
          if (b < 1 || b > 300) throw new AgentError('"bars": 1 to 300.');
          patch.bars = b;
          condition = true;
        }
        if (args.frequency !== undefined) {
          const f = FREQUENCIES.find((x) => x === args.frequency);
          if (!f) throw new AgentError(`"frequency": one of ${FREQUENCIES.join(", ")}.`);
          patch.frequency = f;
        }
        if (typeof args.name === "string") patch.name = args.name.trim();
        if (typeof args.message === "string") patch.message = args.message.trim();
        if (args.expires !== undefined) patch.expiresAt = expiryOf(args.expires);
        if (Object.keys(patch).length) {
          // An edit starts the alert again, as saving the dialog does.
          alertStore.update(r.id, { ...patch, enabled: args.enabled !== false });
          if (condition) resetRuleEvalState(r.id);
        } else if (typeof args.enabled === "boolean") {
          alertStore.setEnabled(r.id, args.enabled);
        }
        return ruleView(alertStore.rule(r.id)!);
      },
    },
    {
      name: "delete_alert",
      title: "Delete alert",
      description: "Delete an alert. Ask the user first: it cannot be undone.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      annotations: { destructiveHint: true },
      run: async (args) => {
        const r = ruleNamed(args.id);
        resetRuleEvalState(r.id);
        setAlertWebhook(r.id, null);
        alertStore.remove(r.id);
        return { deleted: r.id, condition: describeCondition(r) };
      },
    },
  ];
}
