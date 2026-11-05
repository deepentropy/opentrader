/*
 * Paid tier (#252): subscriptions, passes, checkout and the payment webhook.
 *
 * The account's plan comes from its `subscriptions` row (migration 0008),
 * which mirrors the payment provider's subscription: every webhook event, and
 * a nightly pass over all rows, reads the customer's latest subscription back
 * from the provider and stores it. Reading it back (rather than applying each
 * event's own copy) makes duplicated and out-of-order deliveries harmless.
 *
 * When an account loses real-time data (cancellation, refund, unpaid), the
 * gateway is told at once to close its real-time stream; if that call fails
 * the pass expires within 15 minutes anyway.
 */
import { Env } from "./env";
import { User, page } from "./auth";
import { requireUser } from "./api";
import { PASS_TTL, Plan, signPass } from "./pass";
import { HttpError, json, now } from "./util";

const API = "https://api.stripe.com";
/** Webhook signatures older than this are refused (replays). */
const SIGNATURE_TOLERANCE = 300;
const GATEWAY_TIMEOUT_MS = 5_000;

export type SubscriptionRow = {
  user_id: string;
  customer_id: string;
  subscription_id: string | null;
  status: string;
  current_period_end: number | null;
  cancel_at_period_end: number;
  updated_at: number;
};

/**
 * Real-time while the subscription is active or trialing, and while a renewal
 * payment is retried (past_due) until the paid period ends. Anything else
 * (canceled, unpaid, incomplete, paused, no subscription) is the free plan.
 */
export function planOf(row: Pick<SubscriptionRow, "status" | "current_period_end"> | null, at = now()): Plan {
  if (!row) return "free";
  if (row.status === "active" || row.status === "trialing") return "rt";
  if (row.status === "past_due" && row.current_period_end !== null && at < row.current_period_end) return "rt";
  return "free";
}

/** True when the provider is set up: secret key and price. */
function billingOn(env: Env): boolean {
  return !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID);
}

async function row(env: Env, userId: string): Promise<SubscriptionRow | null> {
  return env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ?").bind(userId).first<SubscriptionRow>();
}

// ── Passes and plan ─────────────────────────────────────────────────────

/** POST /auth/pass → {pass, plan, exp}: a fresh pass for the signed-in account. */
export async function issuePass(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  if (!env.PASS_PRIVATE_KEY) throw new HttpError(404, "Not available.");
  const plan = planOf(await row(env, u.id));
  const iat = now();
  const exp = iat + PASS_TTL;
  // A short id of the sign-in session, not the session token's hash itself.
  const pass = await signPass(env.PASS_PRIVATE_KEY, { sub: u.id, plan, sid: u.token_hash.slice(0, 12), iat, exp });
  return json({ pass, plan, exp });
}

/** GET /me/plan → the account's plan and subscription, for the account section. */
export async function myPlan(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  const r = await row(env, u.id);
  return json({
    plan: planOf(r),
    status: r?.status ?? "none",
    renews_at: r?.current_period_end ?? null,
    cancel_at_period_end: !!r?.cancel_at_period_end,
    billing: billingOn(env),
  });
}

// ── Checkout and customer portal ────────────────────────────────────────

/** POST /billing/checkout → {url}: the provider's checkout page for the subscription. */
export async function checkout(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  if (!billingOn(env)) throw new HttpError(404, "Not available.");
  let r = await row(env, u.id);
  if (planOf(r) === "rt") throw new HttpError(409, "You already have a subscription. Manage it from your account.");
  if (!r) {
    const customer = await stripe(env, "POST", "/v1/customers", { "metadata[user_id]": u.id, description: u.name });
    const at = now();
    await env.DB.prepare("INSERT INTO subscriptions (user_id, customer_id, updated_at) VALUES (?, ?, ?)").bind(u.id, customer.id, at).run();
    r = { user_id: u.id, customer_id: customer.id, subscription_id: null, status: "none", current_period_end: null, cancel_at_period_end: 0, updated_at: at };
  }
  const session = await stripe(env, "POST", "/v1/checkout/sessions", {
    mode: "subscription",
    customer: r.customer_id,
    client_reference_id: u.id,
    "line_items[0][price]": env.STRIPE_PRICE_ID!,
    "line_items[0][quantity]": "1",
    "subscription_data[metadata][user_id]": u.id,
    success_url: `${env.PUBLIC_URL}/billing/done`,
    cancel_url: `${env.PUBLIC_URL}/billing/cancelled`,
  });
  return json({ url: session.url });
}

/** POST /billing/portal → {url}: the provider's page to change card, cancel, see invoices. */
export async function portal(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  if (!billingOn(env)) throw new HttpError(404, "Not available.");
  const r = await row(env, u.id);
  if (!r) throw new HttpError(404, "No subscription yet.");
  const session = await stripe(env, "POST", "/v1/billing_portal/sessions", { customer: r.customer_id, return_url: `${env.PUBLIC_URL}/billing/done` });
  return json({ url: session.url });
}

/** The pages checkout and the portal come back to; the app reads the new plan by itself. */
export function returnPage(done: boolean): Response {
  return done
    ? page("Subscription", "<h1>Thank you</h1><p>You can go back to OpenTrader: real-time data starts within a minute.</p>")
    : page("Subscription", "<h1>No change</h1><p>Nothing was charged. You can go back to OpenTrader.</p>");
}

// ── Webhook ─────────────────────────────────────────────────────────────

/** Events whose object names a customer whose subscription may have changed. */
const SYNCED = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.refunded",
]);

/** POST /billing/webhook: the provider's events, signature checked, each applied once. */
export async function webhook(env: Env, request: Request): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET || !billingOn(env)) throw new HttpError(404, "Not available.");
  const body = await request.text();
  if (!(await signatureValid(env.STRIPE_WEBHOOK_SECRET, request.headers.get("stripe-signature") ?? "", body))) {
    throw new HttpError(400, "Bad signature.");
  }
  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    throw new HttpError(400, "The request is not valid JSON.");
  }
  const id = String(event?.id ?? "");
  const type = String(event?.type ?? "");
  if (!id) throw new HttpError(400, "No event id.");
  if (await env.DB.prepare("SELECT 1 FROM billing_events WHERE id = ?").bind(id).first()) return json({ received: true, duplicate: true });

  if (SYNCED.has(type)) {
    const obj = event.data?.object ?? {};
    const customer = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
    if (customer) {
      // A full refund ends the subscription: the same as a cancellation.
      if (type === "charge.refunded" && obj.refunded === true) await cancelCustomer(env, customer);
      await syncCustomer(env, customer);
    }
  }
  // Recorded once applied: a failure above is retried by the provider.
  await env.DB.prepare("INSERT OR IGNORE INTO billing_events (id, type, received_at) VALUES (?, ?, ?)").bind(id, type, now()).run();
  return json({ received: true });
}

/** `Stripe-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "t.body">[,v1=...]`, within the tolerance. */
export async function signatureValid(secret: string, header: string, body: string, at = now()): Promise<boolean> {
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(at - t) > SIGNATURE_TOLERANCE) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => timingSafeEqual(s, expected));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Read the customer's latest subscription back from the provider and store it. */
export async function syncCustomer(env: Env, customer: string): Promise<void> {
  const r = await env.DB.prepare("SELECT * FROM subscriptions WHERE customer_id = ?").bind(customer).first<SubscriptionRow>();
  if (!r) return; // A customer not made by this Worker.
  const list = await stripe(env, "GET", `/v1/subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=1`);
  const sub = list.data?.[0];
  const next = sub
    ? {
        subscription_id: String(sub.id),
        status: String(sub.status),
        // Newer API versions keep the period on the subscription's items.
        current_period_end: numOrNull(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end),
        cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
      }
    : { subscription_id: null, status: "none", current_period_end: null, cancel_at_period_end: 0 };
  await env.DB.prepare(
    "UPDATE subscriptions SET subscription_id = ?, status = ?, current_period_end = ?, cancel_at_period_end = ?, updated_at = ? WHERE customer_id = ?",
  )
    .bind(next.subscription_id, next.status, next.current_period_end, next.cancel_at_period_end, now(), customer)
    .run();
  if (planOf(r) === "rt" && planOf(next) === "free") await revokeRealtime(env, r.user_id);
}

async function cancelCustomer(env: Env, customer: string): Promise<void> {
  const r = await env.DB.prepare("SELECT subscription_id, status FROM subscriptions WHERE customer_id = ?").bind(customer).first<SubscriptionRow>();
  if (r?.subscription_id && r.status !== "canceled") await stripe(env, "DELETE", `/v1/subscriptions/${encodeURIComponent(r.subscription_id)}`);
}

/** Every row read back from the provider (cron, once a night): a webhook missed is caught here. */
export async function reconcile(env: Env): Promise<void> {
  if (!billingOn(env)) return;
  const { results } = await env.DB.prepare("SELECT customer_id FROM subscriptions WHERE subscription_id IS NOT NULL").all<{ customer_id: string }>();
  for (const { customer_id } of results) {
    try {
      await syncCustomer(env, customer_id);
    } catch (e) {
      console.error("[billing] reconcile", customer_id, e);
    }
  }
}

/** An account being deleted: end its subscription first so it is not charged again. */
export async function cancelForDeletedAccount(env: Env, userId: string): Promise<void> {
  const r = await row(env, userId);
  if (!r || !billingOn(env)) return;
  await cancelCustomer(env, r.customer_id);
  await revokeRealtime(env, userId);
}

/** Tell the gateway to close the account's real-time stream now. Failures are logged: the pass expires anyway. */
async function revokeRealtime(env: Env, userId: string): Promise<void> {
  if (!env.GATEWAY_URL || !env.GATEWAY_ADMIN_TOKEN) return;
  try {
    const res = await fetch(`${env.GATEWAY_URL}/market/v1/stream/rt/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GATEWAY_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (!res.ok) console.error("[billing] revoke", userId, res.status);
  } catch (e) {
    console.error("[billing] revoke", userId, e);
  }
}

// ── Provider API ────────────────────────────────────────────────────────

async function stripe(env: Env, method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, string>): Promise<any> {
  const res = await fetch(`${env.STRIPE_API_URL ?? API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(params ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[billing]", method, path, res.status, data?.error?.message);
    throw new HttpError(502, "The payment service did not answer. Try again in a minute.");
  }
  return data;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
