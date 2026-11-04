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
  tickerOf: (s: string) => s.slice(s.indexOf(":") + 1),
  toFullSymbol: (s: string) => Promise.resolve(`NASDAQ:${s}`),
}));
const engine = vi.hoisted(() => ({ reset: [] as string[] }));
vi.mock("../../data/alert-engine", () => ({ resetRuleEvalState: (id: string) => engine.reset.push(id), setAlertWebhook: () => undefined }));
vi.mock("../../window/shell/app-dialogs", () => ({ setActiveRailTab: () => undefined }));
vi.mock("../../data/screener-store", () => ({
  screenerStore: { savedScreens: () => [{ id: "scr_1", screen: { title: "Oversold" }, updatedAt: 0 }] },
}));

import { createAlertTools } from "../alert-tools";
import { alertStore } from "../../data/alert-store";

const drawings = [
  { id: "d1", kind: "horizontal-line", points: [{ time: 1, price: 150 }] },
  { id: "d2", kind: "rectangle", points: [{ time: 1, price: 150 }, { time: 2, price: 160 }] },
  { id: "d3", kind: "fib-retracement", points: [{ time: 1, price: 150 }, { time: 2, price: 160 }] },
];
const tools = createAlertTools(() => ({ symbol: "NASDAQ:AAPL", interval: "60", session: "RTH", drawings: () => drawings as never }));
const run = (name: string, args: Record<string, unknown> = {}) => tools.find((t) => t.name === name)!.run(args) as Promise<Record<string, unknown>>;

describe("alert tools", () => {
  it("creates a price alert on the focused chart, as the dialog does", async () => {
    const r = await run("create_alert", { condition: "crossing_up", value: 200 });
    const rule = alertStore.rule(r.id as string)!;
    expect(rule).toMatchObject({ symbol: "NASDAQ:AAPL", resolution: "60", session: "RTH", left: { kind: "price" }, op: "crossing_up", right: { kind: "value", value: 200 } });
    expect(rule).toMatchObject({ frequency: "only_once", sound: "fired", popup: true, toast: true, expiresAt: null, message: "", enabled: true });
    expect(r.status).toBe("active");
  });

  it("takes bands, moves in N bars, drawings and screens", async () => {
    const band = alertStore.rule((await run("create_alert", { condition: "inside", symbol: "MSFT", low: 410, high: 400 })).id as string)!;
    expect(band).toMatchObject({ symbol: "NASDAQ:MSFT", right: { value: 410 }, right2: { value: 400 } });
    const move = alertStore.rule((await run("create_alert", { condition: "moving_up_pct", value: 5, bars: 3 })).id as string)!;
    expect(move).toMatchObject({ op: "moving_up_pct", right: { value: 5 }, bars: 3 });
    const line = alertStore.rule((await run("create_alert", { condition: "crossing", drawingId: "d1" })).id as string)!;
    expect(line.right).toMatchObject({ kind: "drawing", drawingId: "d1" });
    const rect = alertStore.rule((await run("create_alert", { condition: "entering", drawingId: "d2" })).id as string)!;
    expect(rect.right).toMatchObject({ kind: "drawing", band: "rectangle" });
    await expect(run("create_alert", { condition: "crossing_up", drawingId: "d2" })).rejects.toThrow(/takes the conditions/);
    await expect(run("create_alert", { condition: "crossing", drawingId: "d3" })).rejects.toThrow(/alert dialog/);
    const scr = alertStore.rule((await run("create_alert", { condition: "screen_enter", screen: "oversold" })).id as string)!;
    expect(scr).toMatchObject({ symbol: "", left: { kind: "screen", screenId: "scr_1" }, frequency: "every_time" });
  });

  it("edits, switches off and deletes", async () => {
    const id = (await run("create_alert", { condition: "greater", value: 1 })).id as string;
    await run("update_alert", { id, value: 2, frequency: "every_time" });
    expect(alertStore.rule(id)).toMatchObject({ right: { value: 2 }, frequency: "every_time", enabled: true });
    expect(engine.reset).toContain(id);
    await run("update_alert", { id, enabled: false });
    expect(alertStore.rule(id)).toMatchObject({ enabled: false, stopReason: "manual" });
    await expect(run("update_alert", { id, bars: 3 })).rejects.toThrow(/moving/);
    const listed = await run("list_alerts", { symbol: "AAPL" });
    expect((listed.alerts as { id: string }[]).some((a) => a.id === id)).toBe(true);
    await run("delete_alert", { id });
    expect(alertStore.rule(id)).toBeUndefined();
  });

  it("refuses unknown conditions and past expiries", async () => {
    await expect(run("create_alert", { condition: "above", value: 1 })).rejects.toThrow(/condition/);
    await expect(run("create_alert", { condition: "greater", value: 1, expires: "2001-01-01" })).rejects.toThrow(/future date/);
  });
});
