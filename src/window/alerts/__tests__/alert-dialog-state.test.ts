import { describe, expect, it, vi } from "vitest";
import type { AlertCondition, AlertRule } from "../../../data/alert-store";

const mocks = vi.hoisted(() => ({ kv: new Map<string, string>() }));
vi.mock("../../../data/kv", () => ({
  getItem: (k: string) => mocks.kv.get(k) ?? null,
  setItem: (k: string, v: string) => void mocks.kv.set(k, v),
  removeItem: (k: string) => void mocks.kv.delete(k),
  onExternalChange: () => () => undefined,
  onExternalChangePrefix: () => () => undefined,
}));
vi.mock("../../chart/indicators/registry", () => ({ getIndicatorEntry: () => undefined }));

import {
  conditionFields,
  createMessageState,
  createNotificationsState,
  createSettingsState,
  expiryTime,
  openingFields,
} from "../alert-dialog-state";
import { conditionOf, type ConditionChoices } from "../alert-form";

const ctx = { savedText: (v: number) => v.toFixed(2), chartInterval: "5" };
const noChoices: ConditionChoices = { studies: [], compares: [], drawings: [], fibChannel: false };
const cond = (c: Partial<AlertCondition>): AlertCondition => ({ left: { kind: "price" }, op: "crossing", right: { kind: "value", value: 100 }, resolution: "60", ...c });
const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: "r",
  symbol: "NASDAQ:AAPL",
  resolution: "60",
  left: { kind: "price" },
  op: "crossing",
  right: { kind: "value", value: 100 },
  frequency: "every_time",
  name: "",
  message: "",
  sound: "",
  popup: false,
  enabled: true,
  createdAt: 1,
  expiresAt: null,
  ...over,
});

describe("condition editor fields", () => {
  it("a new condition: the price crossing a value that follows it, on the chart's interval", () => {
    expect(conditionFields(null, ctx)).toMatchObject({
      leftKind: "price",
      op: "crossing",
      rightKind: "value",
      rightValue: "",
      valueEdited: false,
      pct: "1.00",
      bars: "",
      upperSel: "value",
      boundsEdited: false,
      rightLevel: 0.5,
      rightLevel2: null,
      resolution: "5",
      intervalOrigin: "same-as-chart",
    });
    // A chart on ticks or ranges: 1 minute, in the minutes.
    expect(conditionFields(null, { savedText: ctx.savedText })).toMatchObject({ resolution: "1", intervalOrigin: "minutes" });
  });

  it("puts a condition back as it was saved", () => {
    const crossing = cond({});
    const band = cond({ op: "entering", right: { kind: "value", value: 110 }, right2: { kind: "value", value: 90 } });
    const moving = cond({ op: "moving_up_pct", right: { kind: "value", value: 2.5 }, bars: 3 });
    expect(conditionFields(crossing, ctx)).toMatchObject({ rightValue: "100.00", valueEdited: true, resolution: "60", intervalOrigin: "hours" });
    expect(conditionFields(band, ctx)).toMatchObject({ rightValue: "", upperSel: "value", upperValue: "110.00", lowerValue: "90.00", boundsEdited: true });
    expect(conditionFields(moving, ctx)).toMatchObject({ rightValue: "", pct: "2.50", bars: "3" });
    // The editor gives the same condition back.
    for (const c of [crossing, band]) expect(conditionOf(conditionFields(c, ctx), noChoices, 1, c.resolution)).toEqual(c);
    expect(conditionOf(conditionFields(moving, ctx), noChoices, 3, moving.resolution)).toEqual(moving);
  });

  it("reads a drawing's level, a study's condition and a compared symbol", () => {
    const fib = conditionFields(cond({ op: "entering", right: { kind: "drawing", drawingId: "d", level: 0.618, level2: 0.382 } }), ctx);
    expect(fib).toMatchObject({ rightKind: "drawing", rightDrawing: "d", rightLevel: 0.618, rightLevel2: 0.382, upperSel: "value", boundsEdited: false });
    const vwap = conditionFields(cond({ right: { kind: "drawing", drawingId: "v", plot: 2 } }), ctx);
    expect(vwap).toMatchObject({ rightVwapPlot: 2, rightLevel: 0.5 });
    const own = conditionFields(cond({ op: "alert_condition", left: { kind: "indicator", indicatorId: "rsi", condition: { id: "c1", title: "Cross" } } }), ctx);
    expect(own).toMatchObject({ leftKind: "indicator", leftIndicator: "rsi", leftCond: "c1" });
    const sym = conditionFields(cond({ left: { kind: "symbol", symbol: "nasdaq:msft" }, right: { kind: "symbol", symbol: "nasdaq:aapl" } }), ctx);
    expect(sym).toMatchObject({ leftKind: "symbol", leftSymbol: "NASDAQ:MSFT", rightKind: "symbol", rightSymbol: "NASDAQ:AAPL" });
  });

  it("opens on what a new alert was made from", () => {
    expect(openingFields(undefined, undefined, { drawingId: "d", op: "crossing" }, ctx)).toMatchObject({ rightKind: "drawing", rightDrawing: "d", rightValue: "" });
    expect(openingFields(undefined, undefined, { price: 123.4, op: "crossing" }, ctx)).toMatchObject({ rightValue: "123.4", valueEdited: true });
    expect(openingFields(undefined, undefined, { compareSymbol: "nasdaq:msft", op: "crossing" }, ctx)).toMatchObject({ leftKind: "symbol", leftSymbol: "NASDAQ:MSFT" });
    expect(openingFields(undefined, undefined, { indicatorId: "rsi", op: "alert_condition", leftCond: "c1" }, ctx)).toMatchObject({
      leftKind: "indicator",
      leftIndicator: "rsi",
      op: "alert_condition",
      leftCond: "c1",
      intervalOrigin: "same-as-chart",
    });
  });

  it("an alert being edited keeps its number in the value field, whatever its condition", () => {
    const existing = rule({ op: "moving_up", right: { kind: "value", value: 4 }, bars: 2 });
    const first = cond({ op: "moving_up", right: { kind: "value", value: 4 }, bars: 2 });
    expect(openingFields(existing, first, { op: "crossing" }, ctx)).toMatchObject({ op: "moving_up", pct: "4.00", bars: "2", rightValue: "4.00", valueEdited: true });
  });
});

describe("settings", () => {
  it("expiry times from now", () => {
    const now = new Date(2026, 10, 10, 9, 30).getTime();
    expect(expiryTime("open", null, now)).toBeNull();
    expect(expiryTime("eod", null, now)).toBe(new Date(2026, 10, 10, 23, 59).getTime());
    expect(expiryTime("1w", null, now)).toBe(now + 7 * 86_400_000);
    expect(expiryTime("1m", null, now)).toBe(new Date(2026, 11, 10, 9, 30).getTime());
    expect(expiryTime("custom", 5, now)).toBe(5);
  });

  it("an expiring alert opens on its date; a custom date starts a week ahead", () => {
    expect(createSettingsState(rule({ expiresAt: 42 })).expiry()).toBe("custom");
    const s = createSettingsState(undefined);
    expect([s.expiry(), s.expiresAt(), s.frequency()]).toEqual(["open", null, "only_once"]);
    const before = Date.now();
    s.pickExpiry("custom");
    expect(s.customExpiry()).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
    s.setCustomExpiry(7);
    s.pickExpiry("custom");
    expect(s.expiresAt()).toBe(7);
  });
});

describe("message view", () => {
  it("edits a copy; a text left as the default is not kept", () => {
    const m = createMessageState(rule({ name: "Mine" }));
    m.open("AAPL Crossing 100", false);
    expect(m.draft()).toEqual({ name: "Mine", message: "AAPL Crossing 100" });
    m.edit({ message: "Go" });
    expect(m.values().message).toBe("");
    m.apply("AAPL Crossing 100", false);
    expect(m.values()).toEqual({ name: "Mine", message: "Go" });
    m.open("AAPL Crossing 100", false);
    m.edit({ message: "AAPL Crossing 100" });
    m.apply("AAPL Crossing 100", false);
    expect(m.saved("AAPL Crossing 100", false)).toEqual({ name: "Mine", message: "" });
  });

  it("with alert() calls only the name is edited, shown as the condition until named", () => {
    const m = createMessageState(rule({ message: "kept" }));
    m.open("Any alert() function call", true);
    expect(m.draft().name).toBe("Any alert() function call");
    m.apply("Any alert() function call", true);
    expect(m.values()).toEqual({ name: "", message: "kept" });
    m.edit({ name: " Mine " });
    m.apply("Any alert() function call", true);
    expect(m.saved("Any alert() function call", true)).toEqual({ name: "Mine", message: "" });
  });
});

describe("notifications view", () => {
  it("edits a copy written back on Apply; sound off keeps no sound", () => {
    const n = createNotificationsState(rule({ sound: "", popup: true }), null);
    n.open();
    expect(n.draft()).toMatchObject({ popup: true, soundOn: false, sound: "fired", webhookOn: false });
    n.edit({ toast: false, soundOn: true, sound: "bell", soundDuration: 5 });
    expect(n.values().toast).toBe(true);
    expect(n.apply()).toBe(true);
    expect(n.values()).toMatchObject({ toast: false, sound: "bell", soundDuration: 5 });
    n.open();
    n.edit({ soundOn: false });
    n.apply();
    expect(n.values().sound).toBe("");
  });

  it("a webhook URL must be http(s) to apply or save", () => {
    const n = createNotificationsState(undefined, "https://example.com/hook");
    expect([n.values().webhookOn, n.webhookValid()]).toEqual([true, true]);
    n.open();
    n.edit({ webhookUrl: "ftp://x" });
    expect(n.draftWebhookValid()).toBe(false);
    expect(n.apply()).toBe(false);
    expect(n.values().webhookUrl).toBe("https://example.com/hook");
  });

  it("schedule presets, and the custom schedule's editor", () => {
    const n = createNotificationsState(undefined, null);
    n.open();
    n.pickSchedule("weekdays");
    expect(n.draft().schedule).toMatchObject({ days: [1, 2, 3, 4, 5], from: "00:00", to: "00:00" });
    n.pickSchedule("custom");
    // A preset is not a custom schedule: the editor starts on the standard working hours.
    expect(n.customSchedule()).toEqual({ days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" });
    n.setCustomSchedule({ days: [6, 7], from: "10:00", to: "12:00" });
    n.setCustom();
    expect(n.customSchedule()).toBeNull();
    expect(n.draft().schedule).toMatchObject({ days: [6, 7], from: "10:00", to: "12:00" });
    n.pickSchedule("custom");
    expect(n.customSchedule()).toEqual({ days: [6, 7], from: "10:00", to: "12:00" });
    n.pickSchedule("24/7");
    expect(n.draft().schedule).toBeNull();
  });
});
