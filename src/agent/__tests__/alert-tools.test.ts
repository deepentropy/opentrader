import { describe, expect, it, vi } from "vitest";

const kv = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("../../data/kv", () => ({
  getItem: (k: string) => kv.store.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.store.set(k, v),
  removeItem: (k: string) => void kv.store.delete(k),
  onExternalChange: () => () => undefined,
}));
vi.mock("../../data/datafeed", () => ({
  isFullSymbol: (s: string) => s.includes(":"),
  isSupportedResolution: (s: string) => ["1", "5", "60", "1D"].includes(s),
  tickerOf: (s: string) => s.slice(s.indexOf(":") + 1),
  toFullSymbol: (s: string) => Promise.resolve(`NASDAQ:${s}`),
}));
const engine = vi.hoisted(() => ({ reset: [] as string[] }));
vi.mock("../../data/alert-engine", () => ({ resetRuleEvalState: (id: string) => engine.reset.push(id), setAlertWebhook: () => undefined }));
vi.mock("../../window/shell/app-dialogs", () => ({ setActiveRailTab: () => undefined }));
vi.mock("../../data/screener-store", () => ({
  screenerStore: { savedScreens: () => [{ id: "scr_1", screen: { title: "Oversold" }, updatedAt: 0 }] },
}));
// The studies of the focused chart: Bollinger Bands (three plots), an RSI, a script with a condition and alert()
// calls, a strategy.
const studies = vi.hoisted(() => ({
  entries: {
    bb: { metadata: { title: "Bollinger Bands" }, plotConfig: [{ id: "basis", title: "Basis" }, { id: "upper", title: "Upper" }, { id: "lower", title: "Lower" }], inputConfig: [{ id: "length", type: "int" }, { id: "mult", type: "float" }] },
    rsi: { metadata: { title: "Relative Strength Index", precision: 2 }, plotConfig: [{ id: "rsi", title: "RSI" }], inputConfig: [{ id: "length", type: "int" }] },
    "user:s1": { metadata: { title: "Breakout" }, plotConfig: [{ id: "p", title: "Level" }], inputConfig: [], alertConditions: [{ id: "c1", title: "Long", message: "Go long" }], hasAlertFunction: true },
    "strategy:cross": { metadata: { title: "MA cross" }, plotConfig: [], inputConfig: [] },
  } as Record<string, unknown>,
  legend: [
    { id: "bb", title: "BB", inputValues: { length: 20, mult: 2 }, plots: [] },
    { id: "rsi", title: "RSI", inputValues: { length: 14 }, plots: [] },
    { id: "user:s1", title: "Breakout", inputValues: {}, plots: [] },
    { id: "strategy:cross", title: "MA cross", inputValues: {}, plots: [] },
  ],
}));
vi.mock("../../window/chart/indicators/registry", () => ({
  getIndicatorEntry: (id: string) => studies.entries[id],
  loadIndicatorLibrary: () => Promise.resolve(),
}));
vi.mock("../../data/chart-state-registry", async (orig) => ({
  ...(await orig<typeof import("../../data/chart-state-registry")>()),
  indicatorLegendFor: (symbol: string) => (symbol === "NASDAQ:AAPL" ? studies.legend : []),
  chartComparesFor: (symbol: string) =>
    symbol === "NASDAQ:AAPL"
      ? [
          { id: "c1", symbol: "NASDAQ:MSFT", label: "Microsoft Corp. (NASDAQ)", hidden: false, last: 410 },
          { id: "c2", symbol: "NYSE:IBM", label: "IBM Corp. (NYSE)", hidden: false, last: 250 },
        ]
      : [],
}));

import { createAlertTools } from "../alert-tools";
import { alertStore } from "../../data/alert-store";

const drawings = [
  { id: "d1", kind: "horizontal-line", points: [{ time: 1, price: 150 }], style: {} },
  { id: "d2", kind: "rectangle", points: [{ time: 1, price: 150 }, { time: 2, price: 160 }], style: {} },
  { id: "d3", kind: "fib-retracement", points: [{ time: 1, price: 150 }, { time: 2, price: 160 }], style: {} },
  { id: "d4", kind: "anchored-vwap", points: [{ time: 1, price: 150 }], style: {} },
  { id: "d5", kind: "long-position", points: [{ time: 1, price: 150 }], style: {} },
  { id: "d6", kind: "vertical-line", points: [{ time: 1, price: 150 }], style: {} },
  { id: "d7", kind: "brush", points: [{ time: 1, price: 150 }], style: {} },
];
const tools = createAlertTools(() => ({ symbol: "NASDAQ:AAPL", interval: "60", session: "RTH", drawings: () => drawings as never }));
const run = (name: string, args: Record<string, unknown> = {}) => tools.find((t) => t.name === name)!.run(args) as Promise<Record<string, unknown>>;
const create = async (args: Record<string, unknown>) => alertStore.rule((await run("create_alert", args)).id as string)!;

describe("alert tools", () => {
  it("creates a price alert on the focused chart, as the dialog does", async () => {
    const r = await run("create_alert", { condition: "crossing_up", value: 200 });
    const rule = alertStore.rule(r.id as string)!;
    expect(rule).toMatchObject({ symbol: "NASDAQ:AAPL", resolution: "60", session: "RTH", left: { kind: "price" }, op: "crossing_up", right: { kind: "value", value: 200 } });
    expect(rule).toMatchObject({ frequency: "only_once", sound: "fired", popup: true, toast: true, expiresAt: null, message: "", enabled: true });
    expect(r.status).toBe("active");
  });

  it("takes bands, moves in N bars, drawings and screens", async () => {
    const band = await create({ condition: "inside", symbol: "MSFT", low: 410, high: 400 });
    expect(band).toMatchObject({ symbol: "NASDAQ:MSFT", right: { value: 410 }, right2: { value: 400 } });
    const move = await create({ condition: "moving_up_pct", value: 5, bars: 3 });
    expect(move).toMatchObject({ op: "moving_up_pct", right: { value: 5 }, bars: 3 });
    const line = await create({ condition: "crossing", drawingId: "d1" });
    expect(line.right).toMatchObject({ kind: "drawing", drawingId: "d1" });
    const rect = await create({ condition: "entering", drawingId: "d2" });
    expect(rect.right).toMatchObject({ kind: "drawing", band: "rectangle" });
    await expect(run("create_alert", { condition: "crossing_up", drawingId: "d2" })).rejects.toThrow(/takes the conditions/);
    await expect(run("create_alert", { condition: "crossing", drawingId: "d7" })).rejects.toThrow(/takes no alert/);
    const scr = await create({ condition: "screen_enter", screen: "oversold" });
    expect(scr).toMatchObject({ symbol: "", left: { kind: "screen", screenId: "scr_1" }, frequency: "every_time" });
  });

  it("reads a study plot on either side, as the dialog builds it", async () => {
    const upper = await create({ condition: "crossing_down", study: "bb", plot: "upper", value: "price", interval: "5", frequency: "once_per_bar" });
    expect(upper).toMatchObject({ resolution: "5", frequency: "once_per_bar", right: { kind: "price" } });
    expect(upper.left).toEqual({ kind: "indicator", indicatorId: "bb", plot: 1, label: "BB (20, 2): Upper", title: "Bollinger Bands (20, 2)", inputs: { length: 20, mult: 2 } });
    const rsi = await create({ condition: "greater", value: { study: "rsi" } });
    expect(rsi.left).toEqual({ kind: "price" });
    expect(rsi.right).toMatchObject({ kind: "indicator", indicatorId: "rsi", plot: 0, label: "RSI (14)", precision: 2 });
    const channel = await create({ condition: "outside", study: "rsi", high: 70, low: 30 });
    expect(channel).toMatchObject({ right: { value: 70 }, right2: { value: 30 } });
    const bounds = await create({ condition: "inside", high: { study: "bb", plot: 1 }, low: { study: "bb", plot: 2 } });
    expect(bounds).toMatchObject({ right: { indicatorId: "bb", plot: 1 }, right2: { indicatorId: "bb", plot: 2 } });
    const moving = await create({ condition: "moving_up", study: "rsi", value: 10 });
    expect(moving.bars).toBe(2);
    await expect(run("create_alert", { condition: "moving_up", study: "rsi", value: 1, bars: 1 })).rejects.toThrow(/2 to 300/);
    await expect(run("create_alert", { condition: "greater", study: "rsi", value: { study: "rsi" } })).rejects.toThrow(/another study/);
    await expect(run("create_alert", { condition: "greater", study: "bb", plot: "middle", value: 1 })).rejects.toThrow(/0 "Basis", 1 "Upper"/);
    await expect(run("create_alert", { condition: "greater", value: "price" })).rejects.toThrow(/study source/);
    await expect(run("create_alert", { condition: "greater", study: "nope", value: 1 })).rejects.toThrow(/get_chart/);
    await expect(run("create_alert", { condition: "greater", symbol: "MSFT", study: "rsi", value: 1 })).rejects.toThrow(/focused chart's symbol/);
    // The per-bar triggers are for conditions that read a study.
    await expect(run("create_alert", { condition: "greater", value: 1, frequency: "once_per_bar" })).rejects.toThrow(/read a study/);
  });

  it("watches a study's own conditions, its alert() calls and a strategy's order fills", async () => {
    const cond = await create({ condition: "alert_condition", study: "user:s1", alertCondition: "long" });
    expect(cond.left).toMatchObject({ kind: "indicator", indicatorId: "user:s1", label: "Breakout", condition: { id: "c1", title: "Long", message: "Go long" } });
    const calls = await create({ condition: "alert_function", study: "user:s1", message: "ignored", frequency: "every_time" });
    expect(calls).toMatchObject({ op: "alert_function", frequency: "once_per_bar", message: "" });
    expect(calls.left).not.toHaveProperty("condition");
    const fills = await create({ condition: "strategy_orders", study: "strategy:cross" });
    expect(fills).toMatchObject({ op: "strategy_orders", frequency: "every_time", left: { indicatorId: "strategy:cross", label: "MA cross" } });
    // The strategy makes no alert() calls: its order fills only.
    await expect(run("create_alert", { condition: "strategy_alerts", study: "strategy:cross" })).rejects.toThrow(/strategy_orders\./);
    await expect(run("create_alert", { condition: "alert_function", study: "rsi" })).rejects.toThrow(/no alert\(\) calls/);
    await expect(run("create_alert", { condition: "alert_condition", study: "user:s1", alertCondition: "short" })).rejects.toThrow(/"Long"/);
    await expect(run("create_alert", { condition: "alert_condition" })).rejects.toThrow(/condition of a study/);
    await expect(run("update_alert", { id: cond.id, value: 3 })).rejects.toThrow(/no single value/);
  });

  it("takes fib levels, anchored VWAP lines, positions and vertical lines", async () => {
    const fib = await create({ condition: "crossing", drawingId: "d3" });
    expect(fib.right).toEqual({ kind: "drawing", drawingId: "d3", label: "Fib retracement level 0.5 (155.00)", level: 0.5 });
    const fibBand = await create({ condition: "entering", drawingId: "d3", level: 0.382 });
    expect(fibBand.right).toMatchObject({ level: 0.382, level2: 0.5, label: "Fib retracement (upper bound: level 0.382, lower bound: level 0.5)" });
    await expect(run("create_alert", { condition: "crossing", drawingId: "d3", level: 0.3 })).rejects.toThrow(/one of the levels/);
    const vwap = await create({ condition: "crossing_up", drawingId: "d4", line: "upper band" });
    expect(vwap.right).toEqual({ kind: "drawing", drawingId: "d4", label: "anchored VWAP", plot: 4 });
    await expect(run("create_alert", { condition: "entering", drawingId: "d4" })).rejects.toThrow(/takes the conditions/);
    const pos = await create({ condition: "hits_level", drawingId: "d5", frequency: "every_time" });
    expect(pos).toMatchObject({ op: "hits_level", frequency: "only_once", right: { band: "position" } });
    const time = await create({ condition: "crossing", drawingId: "d6" });
    expect(time).toMatchObject({ frequency: "only_once", right: { band: "time" } });
    await expect(run("create_alert", { condition: "greater", drawingId: "d6" })).rejects.toThrow(/takes the conditions crossing\./);
  });

  it("makes multi-condition alerts, each condition on its own interval", async () => {
    const r = await create({
      condition: "crossing_up",
      value: 200,
      and: [
        { condition: "greater", study: "rsi", value: 50, interval: "1D" },
        { condition: "alert_condition", study: "user:s1", interval: "1D" },
      ],
      frequency: "once_per_bar_close",
    });
    // The price condition reads on every update: it takes the interval the others share.
    expect(r).toMatchObject({ op: "crossing_up", resolution: "1D", frequency: "once_per_bar_close" });
    expect(r.and).toMatchObject([{ op: "greater", resolution: "1D", left: { indicatorId: "rsi" } }, { op: "alert_condition", resolution: "1D" }]);
    expect((await run("list_alerts")).alerts).toContainEqual(expect.objectContaining({ id: r.id, andConditions: ["Relative Strength Index (14) Greater Than 50.00", "Breakout: Long"] }));
    await expect(run("create_alert", { condition: "greater", study: "rsi", value: 1, interval: "5", and: [{ condition: "less", study: "rsi", value: 9, interval: "60" }], frequency: "once_per_bar" })).rejects.toThrow(/one interval/);
    await expect(run("create_alert", { condition: "alert_function", study: "user:s1", and: [{ condition: "greater", value: 1 }] })).rejects.toThrow(/only condition/);
    await expect(run("create_alert", { condition: "greater", value: 1, and: [{ condition: "hits_level", drawingId: "d5" }] })).rejects.toThrow(/only condition/);
    await expect(run("create_alert", { condition: "greater", value: 1, and: [{ condition: "strategy_orders", study: "strategy:cross" }] })).rejects.toThrow(/only condition/);
    await expect(run("create_alert", { condition: "greater", value: 1, and: Array(5).fill({ condition: "less", value: 9 }) })).rejects.toThrow(/at most 5/);
    await expect(run("create_alert", { condition: "screen_enter", screen: "oversold", and: [{ condition: "greater", value: 1 }] })).rejects.toThrow(/one condition/);
    await expect(run("create_alert", { condition: "greater", value: 1, interval: "7" })).rejects.toThrow(/not served/);
  });

  it("edits, switches off and deletes", async () => {
    const id = (await run("create_alert", { condition: "greater", value: 1 })).id as string;
    await run("update_alert", { id, value: 2, frequency: "every_time" });
    expect(alertStore.rule(id)).toMatchObject({ right: { value: 2 }, frequency: "every_time", enabled: true });
    expect(engine.reset).toContain(id);
    await expect(run("update_alert", { id, frequency: "once_per_bar" })).rejects.toThrow(/read a study/);
    await run("update_alert", { id, enabled: false });
    expect(alertStore.rule(id)).toMatchObject({ enabled: false, stopReason: "manual" });
    await expect(run("update_alert", { id, bars: 3 })).rejects.toThrow(/moving/);
    const listed = await run("list_alerts", { symbol: "AAPL" });
    expect((listed.alerts as { id: string }[]).some((a) => a.id === id)).toBe(true);
    await run("delete_alert", { id });
    expect(alertStore.rule(id)).toBeUndefined();
  });

  it("takes a symbol compared on the focused chart as the source, the value or a bound, as the dialog does", async () => {
    const src = await create({ condition: "crossing_up", study: { symbol: "msft" }, value: "price", frequency: "once_per_bar_close" });
    expect(src).toMatchObject({ symbol: "NASDAQ:AAPL", frequency: "once_per_bar_close", right: { kind: "price" } });
    expect(src.left).toEqual({ kind: "symbol", symbol: "NASDAQ:MSFT", label: "Microsoft Corp. (NASDAQ)" });
    const vs = await create({ condition: "greater", value: { symbol: "NYSE:IBM" } });
    expect(vs).toMatchObject({ left: { kind: "price" }, right: { kind: "symbol", symbol: "NYSE:IBM", label: "IBM Corp. (NYSE)" } });
    const band = await create({ condition: "inside", study: { symbol: "MSFT" }, high: { symbol: "IBM" }, low: 100 });
    expect(band).toMatchObject({ right: { kind: "symbol", symbol: "NYSE:IBM" }, right2: { kind: "value", value: 100 } });
    // A move on a compared symbol, as on a study: two bars at least.
    expect((await create({ condition: "moving_down_pct", study: { symbol: "MSFT" }, value: 3 })).bars).toBe(2);
    await expect(run("create_alert", { condition: "moving_up", study: { symbol: "MSFT" }, value: 1, bars: 1 })).rejects.toThrow(/2 to 300/);
    await expect(run("create_alert", { condition: "greater", study: { symbol: "MSFT" }, value: { symbol: "MSFT" } })).rejects.toThrow(/another compared symbol/);
    await expect(run("create_alert", { condition: "greater", study: { symbol: "TSLA" }, value: 1 })).rejects.toThrow(/Compared: NASDAQ:MSFT, NYSE:IBM/);
    await expect(run("create_alert", { condition: "alert_condition", study: { symbol: "MSFT" } })).rejects.toThrow(/not of a compared symbol/);
    await expect(run("create_alert", { condition: "greater", symbol: "TSLA", value: { symbol: "MSFT" } })).rejects.toThrow(/focused chart's symbol/);
  });

  it("refuses unknown conditions and past expiries", async () => {
    await expect(run("create_alert", { condition: "above", value: 1 })).rejects.toThrow(/condition/);
    await expect(run("create_alert", { condition: "greater", value: 1, expires: "2001-01-01" })).rejects.toThrow(/future date/);
  });
});
