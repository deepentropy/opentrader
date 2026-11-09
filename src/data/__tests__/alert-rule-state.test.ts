import { describe, expect, it, vi } from "vitest";
import type { AlertRule } from "../alert-store";

const kv = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("../kv", () => ({
  getItem: (k: string) => kv.store.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.store.set(k, v),
  removeItem: (k: string) => void kv.store.delete(k),
  onExternalChange: () => () => undefined,
}));
vi.mock("../datafeed", () => ({ isFullSymbol: () => true, toFullSymbol: (s: string) => Promise.resolve(s) }));

import { RuleStates, ruleRuntimes, ruleSignature } from "../alert-rule-state";
import { alertStore, alertWebhook, setAlertWebhook } from "../alert-store";

const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: "r",
  symbol: "NASDAQ:AAPL",
  resolution: "1",
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
  activeSince: 1,
  expiresAt: null,
  ...over,
});

describe("ruleSignature", () => {
  it("changes with the condition, the trigger, the session and the moment the rule became active", () => {
    const sig = ruleSignature(rule());
    expect(ruleSignature(rule())).toBe(sig);
    expect(ruleSignature(rule({ right: { kind: "value", value: 101 } }))).not.toBe(sig);
    expect(ruleSignature(rule({ frequency: "once_per_bar" }))).not.toBe(sig);
    expect(ruleSignature(rule({ session: "ETH" }))).not.toBe(sig);
    // An edit or a restart moves activeSince.
    expect(ruleSignature(rule({ activeSince: 2 }))).not.toBe(sig);
    // A second condition counts too; the name, the message or the sound do not.
    expect(ruleSignature(rule({ and: [{ left: { kind: "price" }, op: "less", right: { kind: "value", value: 1 }, resolution: "1" }] }))).not.toBe(sig);
    expect(ruleSignature(rule({ name: "x", message: "y", sound: "z" }))).toBe(sig);
  });
});

describe("RuleStates", () => {
  it("keeps a rule's state while its signature stays, and drops it when the rule changes or goes", () => {
    const states = new RuleStates(() => ({ n: 0 }));
    states.sync(new Map([["a", "1"], ["b", "1"]]));
    states.get("a").n = 5;
    states.get("b").n = 7;
    states.sync(new Map([["a", "1"], ["b", "2"]]));
    expect(states.get("a").n).toBe(5);
    expect(states.get("b").n).toBe(0);
    // Deleted or paused (no longer listed): nothing is kept.
    states.sync(new Map([["b", "2"]]));
    expect(states.peek("a")).toBeUndefined();
    expect(states.size).toBe(1);
  });

  it("a rule's memory is one object: every part of it goes together", () => {
    ruleRuntimes.sync(new Map([["r", "1"]]));
    const rt = ruleRuntimes.get("r");
    rt.eval.prevDiff = -1;
    rt.movingRefs[0] = 100;
    rt.calls = { bar: 1, once: true, seq: 3 };
    rt.strategyDelivered.add("fill");
    rt.eval.entryHit = true;
    ruleRuntimes.sync(new Map());
    expect(ruleRuntimes.peek("r")).toBeUndefined();
    ruleRuntimes.sync(new Map([["r", "1"]]));
    const fresh = ruleRuntimes.get("r");
    expect(fresh).toMatchObject({ movingRefs: [], calls: null, strategy: null, strategyRun: null });
    expect(fresh.eval).toMatchObject({ prevDiff: null, entryHit: false });
    expect(fresh.strategyDelivered.size).toBe(0);
  });
});

describe("alert webhooks", () => {
  it("deleting an alert deletes its webhook URL", () => {
    const id = alertStore.add({ ...rule(), symbol: "NASDAQ:AAPL" });
    setAlertWebhook(id, " https://example.com/hook ");
    expect(alertWebhook(id)).toBe("https://example.com/hook");
    expect(JSON.parse(kv.store.get("ot:alert-webhooks:v1")!)).toEqual({ [id]: "https://example.com/hook" });
    alertStore.remove(id);
    expect(alertWebhook(id)).toBeNull();
    expect(JSON.parse(kv.store.get("ot:alert-webhooks:v1")!)).toEqual({});
  });

  it("clearing the alerts clears every URL", () => {
    const id = alertStore.add({ ...rule(), symbol: "NASDAQ:AAPL" });
    setAlertWebhook(id, "https://example.com/a");
    alertStore.clearRules();
    expect(alertWebhook(id)).toBeNull();
  });
});
