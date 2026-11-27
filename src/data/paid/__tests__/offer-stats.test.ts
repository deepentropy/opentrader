import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ events: [] as { event: string; props: Record<string, unknown> }[] }));
vi.mock("../../analytics", () => ({ track: (event: string, props: Record<string, unknown>) => sent.events.push({ event, props }) }));
const session = vi.hoisted(() => ({ user: null as { id: string } | null, next: null as Error | null }));
vi.mock("../../community/session", () => ({
  me: () => session.user,
  signIn: async () => {
    if (session.next) throw session.next;
    session.user = { id: "u1" };
  },
}));

import { offerShown, signInFromOffer } from "../offer-stats";

describe("live data offer in the usage statistics", () => {
  beforeEach(() => {
    sent.events.length = 0;
    session.user = null;
    session.next = null;
  });

  it("counts the dialog shown, with what opened it and whether the user was signed in", () => {
    offerShown("notice", "beta");
    session.user = { id: "u1" };
    offerShown("badge", "beta");
    expect(sent.events).toEqual([
      { event: "live_offer_shown", props: { from: "notice", view: "beta", signed_in: false } },
      { event: "live_offer_shown", props: { from: "badge", view: "beta", signed_in: true } },
    ]);
  });

  it("counts each sign-in from the offer and how it ended, and rejects as the sign-in does", async () => {
    await signInFromOffer("google", true);
    session.next = new Error("cancelled");
    await expect(signInFromOffer("email", true)).rejects.toThrow("cancelled");
    session.next = new Error("The sign-in did not complete.");
    await expect(signInFromOffer("github", false)).rejects.toThrow("did not complete");
    expect(sent.events.map((e) => e.props)).toEqual([
      { provider: "google", beta: true, outcome: "done" },
      { provider: "email", beta: true, outcome: "cancelled" },
      { provider: "github", beta: false, outcome: "failed" },
    ]);
    expect(sent.events.every((e) => e.event === "live_offer_sign_in")).toBe(true);
  });
});
