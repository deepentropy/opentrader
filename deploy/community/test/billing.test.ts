import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { planOf, signatureValid } from "../src/billing";
import { fromBase64url, signPass } from "../src/pass";

describe("planOf", () => {
  const t = 1_800_000_000;
  it("gives real-time to active and trialing subscriptions", () => {
    expect(planOf({ status: "active", current_period_end: t + 10 }, t)).toBe("rt");
    expect(planOf({ status: "trialing", current_period_end: null }, t)).toBe("rt");
  });
  it("keeps real-time while a renewal is retried, until the paid period ends", () => {
    expect(planOf({ status: "past_due", current_period_end: t + 10 }, t)).toBe("rt");
    expect(planOf({ status: "past_due", current_period_end: t - 1 }, t)).toBe("free");
    expect(planOf({ status: "past_due", current_period_end: null }, t)).toBe("free");
  });
  it("is free for anything else", () => {
    for (const status of ["none", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
      expect(planOf({ status, current_period_end: t + 10 }, t)).toBe("free");
    }
    expect(planOf(null, t)).toBe("free");
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
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const raw = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
    const claims = { sub: "u1", plan: "rt" as const, sid: "abc", iat: 1, exp: 901 };
    const pass = await signPass(raw, claims);
    const [prefix, payload, sig] = pass.split(".");
    expect(prefix).toBe("otp1");
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(payload)))).toEqual(claims);
    const key = await crypto.subtle.importKey("raw", fromBase64url(publicKey.export({ format: "jwk" }).x!), { name: "Ed25519" }, false, ["verify"]);
    const data = new TextEncoder().encode(`otp1.${payload}`);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64url(sig), data)).toBe(true);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64url(sig), new TextEncoder().encode(`otp1.${payload}x`))).toBe(false);
  });
});
