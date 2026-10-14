import { describe, expect, it, vi } from "vitest";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";

// The TPO module pulls the chart's theme and session stores; only its entry test is needed here.
vi.mock("../../window/chart/profiles/tpo", () => ({
  isTpoEntry: (e: unknown) => !!(e as { tpo?: boolean } | null | undefined)?.tpo,
}));

import {
  ALERT_CONDITION_DEFAULT_TEXT,
  ALERT_CONDITION_DEFAULT_TITLE,
  alertCallsOf,
  conditionBars,
  conditionMessage,
  hasAlertFunction,
  studyConditions,
} from "../alert-study-conditions";

const entry = (x: Record<string, unknown>) => x as unknown as IndicatorRegistryEntry;
const tpoEntry = entry({ tpo: true, defaultInputs: { extendPOC: true, extendTpoVah: false, extendTpoVal: false, extendSingleprints: false } });

describe("studyConditions", () => {
  it("is empty without an entry", () => {
    expect(studyConditions(null)).toEqual([]);
    expect(studyConditions(undefined)).toEqual([]);
  });

  it("a script's alertcondition() calls, with default titles", () => {
    const e = entry({
      alertConditions: [
        { id: "a", title: "", message: "" },
        { id: "b", title: "Cross up", message: "{{ticker}} crossed" },
      ],
    });
    expect(studyConditions(e)).toStrictEqual([
      { id: "a", title: ALERT_CONDITION_DEFAULT_TITLE },
      { id: "b", title: "Cross up", message: "{{ticker}} crossed" },
    ]);
    expect(studyConditions(entry({}))).toEqual([]);
  });

  it("a TPO study offers the levels set to Extend, in order, inputs over defaults", () => {
    expect(studyConditions(tpoEntry).map((c) => c.id)).toEqual(["cross_extended_POC"]);
    expect(studyConditions(tpoEntry, { extendTpoVal: true, extendPOC: false }).map((c) => c.id)).toEqual(["cross_extended_VAL"]);
    expect(studyConditions(tpoEntry, { extendSingleprints: true, extendPoorHigh: true })).toEqual([
      { id: "cross_extended_POC", title: "Price crossed extended POC", message: "{{ticker}} Crossing TPO POC" },
      { id: "cross_extended_poor_high", title: "Price crossed extended poor high", message: "{{ticker}} Crossing TPO poor high" },
      { id: "cross_extended_singleprint", title: "Price crossed extended singleprint", message: "{{ticker}} Crossing TPO singleprint" },
    ]);
    // Only `true` counts.
    expect(studyConditions(tpoEntry, { extendPOC: "yes" })).toEqual([]);
  });
});

describe("hasAlertFunction / alertCallsOf / conditionMessage", () => {
  it("hasAlertFunction", () => {
    expect(hasAlertFunction(entry({ hasAlertFunction: true }))).toBe(true);
    expect(hasAlertFunction(entry({}))).toBe(false);
    expect(hasAlertFunction(null)).toBe(false);
  });

  it("alertCallsOf: null while loading, else the calls", () => {
    expect(alertCallsOf(null)).toBeNull();
    expect(alertCallsOf({ pending: true, alertCalls: [] })).toBeNull();
    expect(alertCallsOf({})).toEqual([]);
    const calls = [{ time: 1, message: "m", freq: "all" }];
    expect(alertCallsOf({ alertCalls: calls })).toBe(calls);
  });

  it("conditionMessage falls back to 'Alert Fired!'", () => {
    expect(conditionMessage(undefined)).toBe(ALERT_CONDITION_DEFAULT_TEXT);
    expect(conditionMessage({ id: "a", title: "A", message: "" })).toBe("Alert Fired!");
    expect(conditionMessage({ id: "a", title: "A", message: "Go" })).toBe("Go");
  });
});

describe("conditionBars", () => {
  const bars = [{ time: 100 }, { time: 200 }, { time: 300 }, { time: 400 }];
  const script = entry({});

  it("null while loading or for an unknown condition", () => {
    expect(conditionBars(script, null, "a", bars)).toBeNull();
    expect(conditionBars(script, { pending: true }, "a", bars)).toBeNull();
    expect(conditionBars(script, { alerts: [] }, "a", bars)).toBeNull();
  });

  it("marks the bars at the condition's times (unknown times ignored)", () => {
    const r = { alerts: [{ id: "a", times: [200, 400, 999] }] };
    expect(conditionBars(script, r, "a", bars)).toEqual([false, true, false, true]);
  });

  it("a condition with no times but triggered marks the last bar", () => {
    expect(conditionBars(script, { alerts: [{ id: "a", triggered: true }] }, "a", bars)).toEqual([false, false, false, true]);
    expect(conditionBars(script, { alerts: [{ id: "a", triggered: false }] }, "a", bars)).toEqual([false, false, false, false]);
    expect(conditionBars(script, { alerts: [{ id: "a", triggered: true }] }, "a", [])).toEqual([]);
  });

  it("TPO: the bars where an extended level stops", () => {
    const tpo = {
      profiles: [
        { extend: { poc: 1, vah: null, val: 3, poorHigh: undefined, poorLow: 7 }, singleExtend: [0, -1, 2] },
        { extend: { poc: 2, vah: 0 }, singleExtend: [] },
      ],
    };
    expect(conditionBars(tpoEntry, { tpo }, "cross_extended_POC", bars)).toEqual([false, true, true, false]);
    expect(conditionBars(tpoEntry, { tpo }, "cross_extended_VAH", bars)).toEqual([true, false, false, false]);
    expect(conditionBars(tpoEntry, { tpo }, "cross_extended_poor_low", bars)).toEqual([false, false, false, false]); // out of range
    expect(conditionBars(tpoEntry, { tpo }, "cross_extended_singleprint", bars)).toEqual([true, false, true, false]);
    expect(conditionBars(tpoEntry, { tpo }, "nope", bars)).toBeNull();
    expect(conditionBars(tpoEntry, {}, "cross_extended_POC", bars)).toBeNull();
  });
});
