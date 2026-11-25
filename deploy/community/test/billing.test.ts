import { describe, expect, it } from "vitest";
import { openTo, planOf, signatureValid } from "../src/billing";
import { fromBase64url, signPass } from "../src/pass";
import { base64url } from "../src/util";

describe("planOf", () => {
  const t = 1_800_000_000;
  const day = 86_400;
  const month = 30 * day;
  it("gives real-time to active and trialing subscriptions", () => {
    expect(planOf({ status: "active", current_period_start: t - day, current_period_end: t + 10 }, t)).toBe("rt");
    expect(planOf({ status: "trialing", current_period_start: null, current_period_end: null }, t)).toBe("rt");
  });
  it("gives a failed renewal three days, not the month nobody paid", () => {
    const pastDue = (start: number | null) => ({ status: "past_due", current_period_start: start, current_period_end: start === null ? t + month : start + month });
    expect(planOf(pastDue(t - 1), t)).toBe("rt");
    expect(planOf(pastDue(t - 3 * day + 1), t)).toBe("rt");
    expect(planOf(pastDue(t - 3 * day), t)).toBe("free");
    expect(planOf(pastDue(null), t)).toBe("free");
  });
  it("ends an active subscription whose renewal was never heard of", () => {
    const s = { status: "active", current_period_start: t - month, current_period_end: t };
    expect(planOf(s, t + 2 * day)).toBe("rt");
    expect(planOf(s, t + 3 * day)).toBe("free");
  });
  it("is free once a payment is disputed", () => {
    expect(planOf({ status: "active", current_period_start: t, current_period_end: t + month, blocked: 1 }, t)).toBe("free");
  });
  it("is free for anything else", () => {
    for (const status of ["none", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
      expect(planOf({ status, current_period_start: t, current_period_end: t + 10 }, t)).toBe("free");
    }
    expect(planOf(null, t)).toBe("free");
  });
});

describe("openTo", () => {
  const env = (PAID_OPEN?: string, STRIPE_SECRET_KEY: string | undefined = "sk") => ({ PAID_OPEN, STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY: "pk", STRIPE_PRICE_ID: "price" }) as any;
  it("is nobody until opened, the accounts listed, or everyone", () => {
    expect(openTo(env(), "u1")).toBe(false);
    expect(openTo(env("0"), "u1")).toBe(false);
    expect(openTo(env("u2, u1"), "u1")).toBe(true);
    expect(openTo(env("u2"), "u1")).toBe(false);
    expect(openTo(env("u2"), null)).toBe(false);
    expect(openTo(env("1"), null)).toBe(true);
    expect(openTo(env("1", ""), "u1")).toBe(false);
  });
});

async function header(secret: string, body: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("signatureValid", () => {
  const t = 1_800_000_000;
  const body = '{"id":"evt_1"}';
  it("accepts a signature made with the secret", async () => {
    expect(await signatureValid("whsec_a", await header("whsec_a", body, t), body, t + 10)).toBe(true);
  });
  it("accepts one good signature among several (secret rotation)", async () => {
    const good = await header("whsec_a", body, t);
    expect(await signatureValid("whsec_a", `t=${t},v1=${"0".repeat(64)},${good.split(",")[1]}`, body, t)).toBe(true);
  });
  it("refuses another secret, another body, an old timestamp, a missing part", async () => {
    expect(await signatureValid("whsec_a", await header("whsec_b", body, t), body, t)).toBe(false);
    expect(await signatureValid("whsec_a", await header("whsec_a", body, t), body + " ", t)).toBe(false);
    expect(await signatureValid("whsec_a", await header("whsec_a", body, t), body, t + 301)).toBe(false);
    expect(await signatureValid("whsec_a", `t=${t}`, body, t)).toBe(false);
    expect(await signatureValid("whsec_a", "", body, t)).toBe(false);
  });
});

describe("signPass", () => {
  it("makes a pass the public key verifies, with the claims in its payload", async () => {
    const { privateKey, publicKey } = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = base64url(new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer));
    const claims = { sub: "u1", plan: "rt" as const, sid: "abc", iat: 1, exp: 901 };
    const pass = await signPass(raw, claims);
    const [prefix, payload, sig] = pass.split(".");
    expect(prefix).toBe("otp1");
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(payload)))).toEqual(claims);
    const data = new TextEncoder().encode(`otp1.${payload}`);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, fromBase64url(sig), data)).toBe(true);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, fromBase64url(sig), new TextEncoder().encode(`otp1.${payload}x`))).toBe(false);
  });
});
