/*
 * Alert tools of Settings > Coding agents: list the alerts and their log, create price, study, drawing and
 * stock-screen alerts, switch them on or off, edit and delete them. They write the same rules as the alert dialog
 * (alert-store.ts), with its operands (alert-operands.ts): the alert engine watches them at once, and they show in
 * the Alerts panel.
 */
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { isFullSymbol, isSupportedResolution, toFullSymbol } from "../data/datafeed";
import {
  blocksMoreConditions,
  conditionHasIntervalRow,
  describeCondition,
  drawingCanAlert,
  drawingLabel,
  drawingOption,
  isBandOperator,
  isMovingOperator,
  isStrategyOperator,
  ruleConditions,
  BAND_OPERATORS,
  LEVEL_OPERATORS,
  MAX_CONDITIONS,
  STRATEGY_OPERATORS,
  VALUE_OPERATORS,
  VWAP_PLOTS,
} from "../data/alert-condition";
import {
  callsGiveMessages,
  chartStudies,
  defaultFibLevel,
  defaultFibLevel2,
  drawingOperand,
  drawingOperators,
  fixedFrequency,
  indicatorOperand,
  movingBarsMin,
  perBarTriggers,
  savedConditions,
  strategyOperators,
  studyConditionOperand,
  studyLabel,
  studyPlots,
  type StudyChoice,
} from "../data/alert-operands";
import { hasAlertFunction, studyConditions } from "../data/alert-study-conditions";
import { resetRuleEvalState, setAlertWebhook } from "../data/alert-engine";
import { alertStore, isScreenRule, type AlertCondition, type AlertFrequency, type AlertOperator, type AlertRule, type DrawingShape, type NewAlertRule, type Operand } from "../data/alert-store";
import { screenerStore } from "../data/screener-store";
import { getIndicatorEntry, loadIndicatorLibrary } from "../window/chart/indicators/registry";
import { isStrategyId } from "../window/chart/indicators/strategy-entries";
import { setActiveRailTab } from "../window/shell/app-dialogs";
import { AgentError, type AgentTool } from "./mcp";

/** The focused chart, as the alerts need it. */
export type AlertChart = { symbol: string; interval: string; session?: string; drawings: () => Drawing[] };

const SCREEN: AlertOperator[] = ["screen_enter", "screen_exit"];
/** A study's own conditions: no plot read, nothing compared. */
const OWN: AlertOperator[] = ["alert_condition", "alert_function", ...STRATEGY_OPERATORS];
const CONDITIONS: AlertOperator[] = [...VALUE_OPERATORS, "hits_level", ...OWN, ...SCREEN];
const FREQUENCIES: AlertFrequency[] = ["only_once", "once_per_bar", "once_per_bar_close", "every_time"];
const PER_BAR: AlertFrequency[] = ["once_per_bar", "once_per_bar_close"];

/** As in the dialog, a strategy, a script's alert() calls and a position take no other condition. */
const MULTI_CONDITION_HINT = "A strategy, a script's alert() calls or a long / short position is the only condition of its alert.";

const status = (r: AlertRule) => (r.enabled ? "active" : r.stopReason === "triggered" ? "triggered" : r.stopReason === "expired" ? "expired" : "stopped");

const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new AgentError(`"${what}" must be a number.`);
  return v;
};

const same = (a: string, b: unknown) => typeof b === "string" && a.toLowerCase() === b.trim().toLowerCase();

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
    ...(r.and?.length ? { andConditions: r.and.map((c) => describeCondition(c)) } : {}),
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

/** The shape of the drawing a condition compares with, for its fixed trigger. */
const bandOf = (c: Pick<AlertCondition, "right">): DrawingShape | null => (c.right.kind === "drawing" ? (c.right.band ?? null) : null);

/** The fields of one condition (the tool's own arguments, or an item of "and"). */
const CONDITION_PROPERTIES = {
  condition: { type: "string", enum: CONDITIONS },
  study: { type: "string", description: "The source: a study of the focused chart (its id from get_chart). Default: the price." },
  plot: { type: ["integer", "string"], description: "The study's plot: its number (0 first) or title. Default: the first." },
  alertCondition: { type: "string", description: "alert_condition: the study's condition, by id or title (default: its first)." },
  value: {
    type: ["number", "string", "object"],
    description: 'What the source is compared with: a number, "price" (a study source, crossing / greater / less), or a study plot {"study": id, "plot": number or title}. Moving conditions: the amount or percentage.',
    properties: { study: { type: "string" }, plot: { type: ["integer", "string"] } },
  },
  low: { type: ["number", "object"], description: 'Channel conditions: the lower bound, a number or a study plot {"study", "plot"}.' },
  high: { type: ["number", "object"], description: 'Channel conditions: the upper bound, a number or a study plot {"study", "plot"}.' },
  bars: { type: "integer", description: "Moving conditions: within this many bars (1-300 on the price, 2-300 on a study; default the fewest)." },
  drawingId: { type: "string", description: "Compare with a drawing of the focused chart (list_drawings)." },
  level: { type: "number", description: "Fib drawing: the level's coefficient (default 0.5, else its first visible level)." },
  level2: { type: "number", description: "Fib drawing, channel conditions: the lower bound's coefficient (default the next level)." },
  line: { type: ["integer", "string"], description: `Anchored VWAP: its line, by number (0 first) or name: ${VWAP_PLOTS.join(", ")}. Default VWAP.` },
  interval: { type: "string", description: "The interval the condition reads (a study, a move in N bars). Default: the focused chart's." },
};

export function createAlertTools(chart: () => AlertChart): AgentTool[] {
  /** The study `id` of the focused chart. */
  function studyOf(studies: readonly StudyChoice[], id: unknown, symbol: string): StudyChoice {
    if (symbol !== chart().symbol) throw new AgentError(`A study alert is on the focused chart's symbol (${chart().symbol}).`);
    const s = typeof id === "string" ? studies.find((x) => x.id === id) : undefined;
    if (!s) throw new AgentError(`No study "${String(id)}" on the focused chart: see get_chart (the studies' id).`);
    return s;
  }

  /** The row of a study's plot select, by number or title. */
  function plotOf(studies: readonly StudyChoice[], id: string, plot: unknown): number {
    const plots = studyPlots(id);
    if (!plots.length) throw new AgentError(`${studyLabel(studies, id)} has no plots to compare: use its own conditions (alert_condition, alert_function).`);
    if (plot === undefined) return 0;
    const i = plots.findIndex((p) => (typeof plot === "number" ? p.index === plot : same(p.title, plot)));
    if (i < 0) throw new AgentError(`"plot": one of ${plots.map((p) => `${p.index} "${p.title}"`).join(", ")}.`);
    return i;
  }

  /** The source of a condition: the price, a study's plot, or the study of one of its own conditions. */
  function leftOf(spec: Record<string, unknown>, op: AlertOperator, studies: readonly StudyChoice[], symbol: string, later: boolean): Operand {
    if (spec.study === undefined) {
      if (OWN.includes(op)) throw new AgentError(`"${op}" is a condition of a study: give "study" (its id from get_chart).`);
      return { kind: "price" };
    }
    const s = studyOf(studies, spec.study, symbol);
    const name = studyLabel(studies, s.id);
    const entry = getIndicatorEntry(s.id);
    const calls = hasAlertFunction(entry);
    if (isStrategyId(s.id)) {
      if (later) throw new AgentError(MULTI_CONDITION_HINT);
      const ops = strategyOperators(calls);
      if (!ops.includes(op)) throw new AgentError(`A strategy takes the conditions ${ops.join(", ")}.`);
      return studyConditionOperand(studies, s.id, op, undefined, undefined);
    }
    if (isStrategyOperator(op)) throw new AgentError(`"${op}" is a condition of a strategy.`);
    if (op === "alert_function") {
      if (!calls) throw new AgentError(`${name} makes no alert() calls.`);
      if (later) throw new AgentError(MULTI_CONDITION_HINT);
      return studyConditionOperand(studies, s.id, op, undefined, undefined);
    }
    if (op === "alert_condition") {
      const list = studyConditions(entry, s.inputs);
      if (!list.length) throw new AgentError(`${name} declares no alert conditions.`);
      const want = spec.alertCondition;
      const cond = want === undefined ? list[0] : list.find((c) => c.id === want || same(c.title, want));
      if (!cond) throw new AgentError(`"alertCondition": one of ${list.map((c) => `"${c.title}"`).join(", ")}.`);
      return studyConditionOperand(studies, s.id, op, cond, undefined);
    }
    return indicatorOperand(studies, s.id, plotOf(studies, s.id, spec.plot), undefined);
  }

  /** What a condition compares with (or a bound of a channel): a value, the price, a study's plot. */
  function sideOf(v: unknown, what: string, left: Operand, op: AlertOperator, studies: readonly StudyChoice[], symbol: string): Operand {
    if (typeof v === "number") return { kind: "value", value: num(v, what) };
    if (v === "price") {
      // As the dialog offers it: a study (or a compared symbol) against the price, on a level condition.
      if (what !== "value" || left.kind === "price" || !LEVEL_OPERATORS.includes(op)) throw new AgentError(`"${what}": "price" compares a study source on crossing, greater or less.`);
      return { kind: "price" };
    }
    if (v && typeof v === "object" && "study" in v) {
      const { study, plot } = v as { study: unknown; plot?: unknown };
      const s = studyOf(studies, study, symbol);
      if (left.kind === "indicator" && left.indicatorId === s.id) throw new AgentError(`"${what}": another study than the source.`);
      return indicatorOperand(studies, s.id, plotOf(studies, s.id, plot), undefined);
    }
    throw new AgentError(`"${what}": a number${what === "value" ? ', "price"' : ""} or a study plot {"study": id, "plot": number or title}.`);
  }

  /** The drawing a condition compares with: its level, fib levels or VWAP line. */
  function drawingSide(spec: Record<string, unknown>, op: AlertOperator, symbol: string, later: boolean): Operand {
    const c = chart();
    if (symbol !== c.symbol) throw new AgentError(`A drawing alert is on the focused chart's symbol (${c.symbol}).`);
    const d = c.drawings().find((x) => x.id === spec.drawingId);
    if (!d) throw new AgentError(`No drawing "${String(spec.drawingId)}" on the focused chart: see list_drawings.`);
    if (!drawingCanAlert(d.kind)) throw new AgentError(`A ${drawingLabel(d)} takes no alert.`);
    const o = drawingOption(d);
    if (later && o.band === "position") throw new AgentError(MULTI_CONDITION_HINT);
    if (o.levels && !o.levels.length) throw new AgentError(`This ${o.label} shows no level.`);
    const ops = drawingOperators(o) ?? LEVEL_OPERATORS;
    if (!ops.includes(op)) throw new AgentError(`A ${o.label} takes the conditions ${ops.join(", ")}.`);
    const levelOf = (v: unknown, what: string) => {
      const coeff = num(v, what);
      if (!o.levels?.some((l) => l.coeff === coeff)) throw new AgentError(`"${what}": one of the levels ${o.levels?.map((l) => l.coeff).join(", ")}.`);
      return coeff;
    };
    if (!o.levels && (spec.level !== undefined || spec.level2 !== undefined)) throw new AgentError('"level" and "level2" are the levels of a fib drawing.');
    const level = !o.levels ? 0 : spec.level === undefined ? defaultFibLevel(o.levels) : levelOf(spec.level, "level");
    const level2 = !o.levels || !isBandOperator(op) ? null : spec.level2 === undefined ? defaultFibLevel2(o.levels, level) : levelOf(spec.level2, "level2");
    let plot = 0;
    if (spec.line !== undefined) {
      if (!o.plots) throw new AgentError('"line" is a line of an anchored VWAP.');
      plot = o.plots.findIndex((p, i) => (typeof spec.line === "number" ? i === spec.line : same(p, spec.line)));
      if (plot < 0) throw new AgentError(`"line": one of ${o.plots.map((p, i) => `${i} "${p}"`).join(", ")}.`);
    }
    return drawingOperand(d.id, o, { level, level2, plot });
  }

  /** One condition of the alert (`later`: after the first). */
  function conditionOf(spec: Record<string, unknown>, studies: readonly StudyChoice[], symbol: string, later: boolean): AlertCondition {
    const op = CONDITIONS.find((c) => c === spec.condition);
    if (!op) throw new AgentError(`"condition": one of ${CONDITIONS.join(", ")}.`);
    if (SCREEN.includes(op)) throw new AgentError("A screen alert has one condition.");
    const left = leftOf(spec, op, studies, symbol, later);
    let right: Operand = { kind: "value", value: 0 };
    let right2: Operand | undefined;
    let bars: number | undefined;
    if (OWN.includes(op)) {
      // A study's own condition compares nothing.
    } else if (isMovingOperator(op)) {
      right = { kind: "value", value: num(spec.value, "value") };
      const min = movingBarsMin(left.kind);
      bars = spec.bars === undefined ? min : Math.floor(num(spec.bars, "bars"));
      if (bars < min || bars > 300) throw new AgentError(`"bars": ${min} to 300.`);
    } else if (typeof spec.drawingId === "string") {
      right = drawingSide(spec, op, symbol, later);
    } else if (op === "hits_level") {
      throw new AgentError('"hits_level" takes the drawingId of a long or short position.');
    } else if (BAND_OPERATORS.includes(op)) {
      const hi = sideOf(spec.high, "high", left, op, studies, symbol);
      const lo = sideOf(spec.low, "low", left, op, studies, symbol);
      // Two numbers: the upper one is the larger.
      const swap = hi.kind === "value" && lo.kind === "value" && lo.value > hi.value;
      right = swap ? lo : hi;
      right2 = swap ? hi : lo;
    } else {
      right = sideOf(spec.value, "value", left, op, studies, symbol);
    }
    const c = chart();
    const asked = typeof spec.interval === "string" && spec.interval.trim() ? spec.interval.trim() : null;
    if (asked && !isSupportedResolution(asked)) throw new AgentError(`Interval "${asked}" is not served.`);
    // As in the dialog: a condition that reads no interval of its own (the price against a value, a drawing) keeps
    // the chart's.
    const resolution = conditionHasIntervalRow({ left, op, right, right2 }) ? (asked ?? c.interval) : c.interval;
    return { left, op, right, ...(right2 ? { right2 } : {}), ...(bars !== undefined ? { bars } : {}), resolution };
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
        "Create an alert and show the Alerts panel. The source is the price, or a study of the focused chart (study: its id from get_chart; plot: its number or title). condition: " +
        'crossing, crossing_up, crossing_down, greater, less (with value: a number, "price" for a study source, or another study\'s plot {"study","plot"}; or drawingId); ' +
        "entering, exiting, inside, outside (with low and high: numbers or study plots; or the drawingId of a channel, a rectangle or a fib drawing with level and level2); " +
        "moving_up, moving_down (an amount), moving_up_pct, moving_down_pct (a percentage) with value and bars; " +
        "alert_condition (a study's alertcondition(), alertCondition: its id or title), alert_function (a script's alert() calls), " +
        "strategy_orders, strategy_orders_and_alerts, strategy_alerts (a strategy's order fills and alert() calls); " +
        "hits_level (drawingId of a long or short position); a vertical line takes crossing (the time reaches it), a fib drawing its level, an anchored VWAP its line; " +
        "screen_enter, screen_exit (with screen: a saved stock screen's name; a symbol entering or leaving its results). " +
        `and: up to ${MAX_CONDITIONS - 1} more conditions, each with the same fields and its own interval; the alert fires when all hold (not after a strategy, alert_function or a position). ` +
        "symbol: default the focused chart's (studies and drawings: the focused chart's); interval: the focused chart's by default. " +
        "frequency: only_once (default), every_time, and on a study once_per_bar, once_per_bar_close; alert() calls, order fills, vertical lines and positions set their own. " +
        "The message defaults to the condition (alert() calls give their own).",
      inputSchema: {
        type: "object",
        properties: {
          ...CONDITION_PROPERTIES,
          and: { type: "array", maxItems: MAX_CONDITIONS - 1, items: { type: "object", properties: CONDITION_PROPERTIES, required: ["condition"] } },
          symbol: { type: "string" },
          screen: { type: "string" },
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
        const asked = args.frequency === undefined ? "only_once" : FREQUENCIES.find((f) => f === args.frequency);
        if (!asked) throw new AgentError(`"frequency": one of ${FREQUENCIES.join(", ")}.`);
        const more = args.and === undefined ? [] : args.and;
        if (!Array.isArray(more) || more.some((x) => !x || typeof x !== "object")) throw new AgentError('"and": a list of conditions.');
        if (more.length + 1 > MAX_CONDITIONS) throw new AgentError(`An alert has at most ${MAX_CONDITIONS} conditions.`);
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
          if (more.length) throw new AgentError("A screen alert has one condition.");
          const name = typeof args.screen === "string" ? args.screen.trim().toLowerCase() : "";
          const s = screenerStore.savedScreens().find((x) => x.screen.title.toLowerCase() === name);
          if (!s) throw new AgentError(`"screen": the name of a saved stock screen (list_screens; save_screen makes one).`);
          rule = { ...common, symbol: "", resolution: "", left: { kind: "screen", screenId: s.id, title: s.screen.title }, op, right: { kind: "value", value: 0 }, frequency: "every_time" };
        } else {
          const c = chart();
          const typed = typeof args.symbol === "string" && args.symbol.trim() ? args.symbol.trim().toUpperCase() : c.symbol;
          const symbol = isFullSymbol(typed) ? typed : await toFullSymbol(typed).catch(() => {
            throw new AgentError(`Unknown symbol "${typed}".`);
          });
          await loadIndicatorLibrary();
          const studies = chartStudies(c.symbol);
          const conds = [args, ...(more as Record<string, unknown>[])].map((spec, i) => conditionOf(spec, studies, symbol, i > 0));
          if (conds.length > 1 && blocksMoreConditions(conds[0])) throw new AgentError(MULTI_CONDITION_HINT);
          const [first, ...others] = conds.length > 1 ? savedConditions(conds) : conds;
          const fixed = conds.map((x) => fixedFrequency(x.op, bandOf(x))).find((f) => f !== null) ?? null;
          if (!fixed && PER_BAR.includes(asked) && !perBarTriggers(conds)) {
            throw new AgentError(`"frequency": ${asked} is for conditions that read a study (on one interval); here only_once or every_time.`);
          }
          rule = {
            ...common,
            ...(callsGiveMessages(first.op) ? { message: "" } : {}),
            symbol,
            resolution: first.resolution,
            ...(symbol === c.symbol && c.session ? { session: c.session as AlertRule["session"] } : {}),
            left: first.left,
            op: first.op,
            right: first.right,
            ...(first.right2 ? { right2: first.right2 } : {}),
            ...(first.bars !== undefined ? { bars: first.bars } : {}),
            ...(others.length ? { and: others } : {}),
            frequency: fixed ?? asked,
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
        "Change an alert: enabled (switch it on or off), value / low / high / bars (its first condition's numbers), frequency, name, message, expires (null: no expiry). An edited alert starts again.",
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
          if (r.right.kind !== "value" || r.right2 || isScreenRule(r) || OWN.includes(r.op)) throw new AgentError("This alert's condition has no single value.");
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
          const min = movingBarsMin(r.left.kind);
          if (b < min || b > 300) throw new AgentError(`"bars": ${min} to 300.`);
          patch.bars = b;
          condition = true;
        }
        if (args.frequency !== undefined) {
          const f = FREQUENCIES.find((x) => x === args.frequency);
          if (!f) throw new AgentError(`"frequency": one of ${FREQUENCIES.join(", ")}.`);
          const conds = ruleConditions(r);
          if (isScreenRule(r) || conds.some((x) => fixedFrequency(x.op, bandOf(x)) !== null)) throw new AgentError("This alert's condition sets its own frequency.");
          if (PER_BAR.includes(f) && !perBarTriggers(conds)) throw new AgentError(`"frequency": ${f} is for conditions that read a study (on one interval).`);
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
