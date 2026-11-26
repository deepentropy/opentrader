import { beforeEach, describe, expect, it, vi } from "vitest";

// The Rust side: the passes handed over.
const rust = vi.hoisted(() => ({ passes: [] as (string | null)[] }));
vi.mock("../../../bindings", () => ({
  commands: {
    marketPassSet: async (pass: string | null) => void rust.passes.push(pass),
    marketPassResume: async () => undefined,
  },
  events: { marketTier: { listen: async () => () => undefined } },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => undefined }));
// The accounts server: the answer of each path, or the error it throws.
const server = vi.hoisted(() => ({ answers: {} as Record<string, unknown>, calls: [] as string[] }));
vi.mock("../../community/api", () => {
  class CommunityError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return {
    CommunityError,
    COMMUNITY_ENABLED: true,
    request: async (method: string, path: string) => {
      server.calls.push(`${method} ${path}`);
      const a = server.answers[path];
      if (a instanceof Error) throw a;
      return a;
    },
  };
});
const session = vi.hoisted(() => ({ me: null as unknown }));
vi.mock("../../community/session", () => ({ me: () => session.me, ready: () => true, initSession: async () => undefined }));

import { CommunityError } from "../../community/api";
import { betaEnds, onMarketTier, paidOffer, paidShown, planInfo, realtimeActive, awaitPlan, refreshOffer, refreshPass, setCancelled, startCheckout } from "../plan";

const exp = () => Math.floor(Date.now() / 1000) + 900;
const plan = (p: "free" | "rt") => ({ plan: p, status: p === "rt" ? "active" : "none", renews_at: null, cancel_at_period_end: false, billing: true });

beforeEach(() => {
  vi.useFakeTimers();
  rust.passes.length = 0;
  server.calls.length = 0;
  server.answers = {};
  session.me = { user: { name: "owner" } };
});

describe("refreshPass", () => {
  it("hands a paid pass to the Rust side and asks a new one before it expires", async () => {
    server.answers["/auth/pass"] = { pass: "otp1.a.b", plan: "rt", exp: exp() };
    server.answers["/me/plan"] = plan("rt");
    await refreshPass();
    await vi.advanceTimersByTimeAsync(0);
    expect(rust.passes).toEqual(["otp1.a.b"]);
    expect(realtimeActive()).toBe(false);
    // Real-time once the stream's real-time session is up.
    onMarketTier({ tier: "realtime", reason: null });
    expect(realtimeActive()).toBe(true);
    expect(planInfo()?.plan).toBe("rt");
    server.answers["/auth/pass"] = { pass: "otp1.c.d", plan: "rt", exp: exp() + 780 };
    // 15 min less 2: 780 s.
    await vi.advanceTimersByTimeAsync(779_000);
    expect(rust.passes).toEqual(["otp1.a.b"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rust.passes).toEqual(["otp1.a.b", "otp1.c.d"]);
  });

  it("leaves real-time when another device takes the session, or the pass is refused", async () => {
    server.answers["/auth/pass"] = { pass: "otp1.a.b", plan: "rt", exp: exp() };
    server.answers["/me/plan"] = plan("rt");
    await refreshPass();
    onMarketTier({ tier: "realtime", reason: null });
    onMarketTier({ tier: "delayed", reason: "signed_in_elsewhere" });
    expect(realtimeActive()).toBe(false);
    onMarketTier({ tier: "realtime", reason: null });
    expect(realtimeActive()).toBe(true);
    onMarketTier({ tier: "delayed", reason: "revoked" });
    expect(realtimeActive()).toBe(false);
    // A new pass is asked a second later.
    const before = server.calls.filter((c) => c === "POST /auth/pass").length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.calls.filter((c) => c === "POST /auth/pass").length).toBe(before + 1);
  });

  it("a session that devices keep taking from each other waits for the user", async () => {
    server.answers["/auth/pass"] = { pass: "otp1.a.b", plan: "rt", exp: exp() };
    server.answers["/me/plan"] = plan("rt");
    await refreshPass();
    onMarketTier({ tier: "realtime", reason: null });
    const before = server.calls.length;
    onMarketTier({ tier: "delayed", reason: "too_many_devices" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(realtimeActive()).toBe(false);
    expect(server.calls.length).toBe(before);
    onMarketTier({ tier: "realtime", reason: null });
  });

  it("a connection lost for a moment changes nothing, for longer it is delayed data", async () => {
    server.answers["/auth/pass"] = { pass: "otp1.a.b", plan: "rt", exp: exp() };
    server.answers["/me/plan"] = plan("rt");
    await refreshPass();
    onMarketTier({ tier: "realtime", reason: null });
    onMarketTier({ tier: "delayed", reason: null });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(realtimeActive()).toBe(true);
    onMarketTier({ tier: "realtime", reason: null });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(realtimeActive()).toBe(true);
    onMarketTier({ tier: "delayed", reason: null });
    await vi.advanceTimersByTimeAsync(3_000);
    // a try to connect again failed
    onMarketTier({ tier: "delayed", reason: null });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(realtimeActive()).toBe(false);
  });

  it("a refused pass: tried again later, and at once when the plan is paid again", async () => {
    server.answers["/auth/pass"] = { pass: "otp1.a.b", plan: "rt", exp: exp() };
    server.answers["/me/plan"] = plan("rt");
    await refreshPass();
    await vi.advanceTimersByTimeAsync(0);
    onMarketTier({ tier: "delayed", reason: "not_allowed" });
    await refreshPass();
    expect(rust.passes[rust.passes.length - 1]).toBe(null);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rust.passes[rust.passes.length - 1]).toBe("otp1.a.b");
    // refused again, the plan ends, then is paid again
    onMarketTier({ tier: "delayed", reason: "not_allowed" });
    server.answers["/auth/pass"] = { pass: "otp1.x.y", plan: "free", exp: exp() };
    server.answers["/me/plan"] = plan("free");
    await refreshPass();
    await vi.advanceTimersByTimeAsync(0);
    server.answers["/auth/pass"] = { pass: "otp1.c.d", plan: "rt", exp: exp() };
    server.answers["/me/plan"] = plan("rt");
    await refreshPass();
    expect(rust.passes[rust.passes.length - 1]).toBe("otp1.c.d");
    onMarketTier({ tier: "realtime", reason: null });
  });

  it("hands no pass on the free plan", async () => {
    server.answers["/auth/pass"] = { pass: "otp1.x.y", plan: "free", exp: exp() };
    server.answers["/me/plan"] = plan("free");
    await refreshPass();
    expect(rust.passes).toEqual([null]);
    expect(realtimeActive()).toBe(false);
  });

  it("signed out: no pass, nothing asked", async () => {
    session.me = null;
    await refreshPass();
    expect(rust.passes).toEqual([null]);
    expect(server.calls).toEqual([]);
  });

  it("a server without the paid tier (404): free, not asked again", async () => {
    server.answers["/auth/pass"] = new CommunityError(404, "Not available.");
    await refreshPass();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(rust.passes).toEqual([null]);
    expect(server.calls).toEqual(["POST /auth/pass"]);
  });

  it("unreachable: the pass handed over stays, asked again later", async () => {
    server.answers["/auth/pass"] = { pass: "otp1.a.b", plan: "rt", exp: exp() };
    server.answers["/me/plan"] = plan("rt");
    await refreshPass();
    server.answers["/auth/pass"] = new CommunityError(0, "unreachable");
    await refreshPass();
    expect(rust.passes).toEqual(["otp1.a.b"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.calls.filter((c) => c === "POST /auth/pass")).toHaveLength(3);
  });
});

describe("the live data beta", () => {
  it("is offered signed out, and the account's own once signed in, until it ends", async () => {
    const end = Math.floor(Date.now() / 1000) + 86_400;
    session.me = null;
    await refreshPass();
    server.answers["/paid"] = { open: false, price: "$10", beta_until: end };
    await refreshOffer();
    expect(betaEnds()).toBe(end);
    expect(paidShown()).toBe(true);
    session.me = { user: { name: "owner" } };
    server.answers["/auth/pass"] = { pass: "otp1.beta.b", plan: "rt", exp: exp() };
    server.answers["/me/plan"] = { ...plan("rt"), status: "none", billing: false, beta_until: end };
    await refreshPass();
    await vi.advanceTimersByTimeAsync(0);
    expect(rust.passes[rust.passes.length - 1]).toBe("otp1.beta.b");
    expect(betaEnds()).toBe(end);
    // A subscriber is not on the beta.
    server.answers["/me/plan"] = { ...plan("rt"), beta_until: null };
    await refreshPass();
    await vi.advanceTimersByTimeAsync(0);
    expect(betaEnds()).toBeNull();
    // Over: nothing is offered.
    session.me = null;
    await refreshPass();
    server.answers["/paid"] = { open: false, price: "$10", beta_until: null };
    await refreshOffer();
    expect(betaEnds()).toBeNull();
    expect(paidShown()).toBe(false);
  });
});

describe("the offer", () => {
  it("is shown when the server opens it, and to a subscriber when it is closed", async () => {
    session.me = null;
    await refreshPass();
    server.answers["/paid"] = { open: false, price: "$10" };
    await refreshOffer();
    expect(paidShown()).toBe(false);
    server.answers["/paid"] = { open: true, price: "$12" };
    await refreshOffer();
    expect(paidShown()).toBe(true);
    expect(paidOffer()?.price).toBe("$12");
    // unreachable: as it was; a server without the paid tier: nothing
    server.answers["/paid"] = new CommunityError(0, "unreachable");
    await refreshOffer();
    expect(paidShown()).toBe(true);
    server.answers["/paid"] = new CommunityError(404, "Not found.");
    await refreshOffer();
    expect(paidShown()).toBe(false);
    session.me = { user: { name: "owner" } };
    server.answers["/auth/pass"] = { pass: "otp1.a.b", plan: "rt", exp: exp() };
    server.answers["/me/plan"] = { ...plan("rt"), billing: false };
    await refreshPass();
    await vi.advanceTimersByTimeAsync(0);
    expect(paidShown()).toBe(true);
  });

  it("after the checkout the plan is read until it is paid", async () => {
    server.answers["/billing/checkout"] = { page: "https://pay.test/billing/pay", secret: "cs_a_secret_b/c" };
    server.answers["/billing/refresh"] = plan("free");
    server.answers["/auth/pass"] = { pass: "otp1.p.q", plan: "rt", exp: exp() };
    server.answers["/me/plan"] = plan("rt");
    expect(await startCheckout()).toBe("https://pay.test/billing/pay#cs_a_secret_b%2Fc");
    const paid = awaitPlan(10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(server.calls.filter((c) => c === "POST /billing/refresh")).toHaveLength(2);
    server.answers["/billing/refresh"] = plan("rt");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await paid).toBe(true);
    expect(rust.passes[rust.passes.length - 1]).toBe("otp1.p.q");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.calls.filter((c) => c === "POST /billing/refresh")).toHaveLength(3);
  });
});

describe("cancelling", () => {
  it("shows the plan the server answers", async () => {
    server.answers["/billing/cancel"] = { ...plan("rt"), cancel_at_period_end: true };
    server.answers["/billing/resume"] = plan("rt");
    await setCancelled(true);
    expect(planInfo()?.cancel_at_period_end).toBe(true);
    await setCancelled(false);
    expect(planInfo()?.cancel_at_period_end).toBe(false);
  });
});
