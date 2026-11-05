/*
 * Passes (#252): what the app shows the market-data gateway to read
 * real-time data. Signed here with Ed25519, checked by the gateway with the
 * public key alone (no call back to this Worker), at connect and on renewal.
 *
 *   otp1.<payload>.<signature>        both base64url, no padding
 *   payload   JSON {sub, plan, sid, iat, exp}: account id, "free" | "rt",
 *             a short id of the sign-in session, issue and expiry (seconds)
 *   signature Ed25519 over "otp1.<payload>"
 *
 * `PASS_PRIVATE_KEY`: PKCS #8, base64url (scripts/pass-keys.mjs makes a pair).
 */
import { base64url } from "./util";

export const PASS_TTL = 15 * 60;
const PREFIX = "otp1.";

export type Plan = "free" | "rt";

export interface PassClaims {
  sub: string;
  plan: Plan;
  sid: string;
  iat: number;
  exp: number;
}

let cached: { raw: string; key: Promise<CryptoKey> } | null = null;

function privateKey(raw: string): Promise<CryptoKey> {
  if (cached?.raw !== raw) {
    cached = { raw, key: crypto.subtle.importKey("pkcs8", fromBase64url(raw), { name: "Ed25519" }, false, ["sign"]) };
  }
  return cached.key;
}

export async function signPass(raw: string, claims: PassClaims): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, await privateKey(raw), new TextEncoder().encode(PREFIX + payload));
  return `${PREFIX}${payload}.${base64url(new Uint8Array(sig))}`;
}

export function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
