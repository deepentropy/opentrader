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
    request: async (method: string, path: string) => {
      server.calls.push(`${method} ${path}`);
      const a = server.answers[path];
      if (a instanceof Error) throw a;
      return a;
    },
  };
});
const session = vi.hoisted(() => ({ me: null as unknown }));
vi.mock("../../community/session", () => ({ me: () => session.me, initSession: async () => undefined }));

import { CommunityError } from "../../community/api";
import { onMarketTier, planInfo, realtimeActive, refreshPass } from "../plan";

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
