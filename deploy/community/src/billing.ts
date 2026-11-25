/*
 * Paid tier (#252): subscriptions, passes, checkout and the payment webhook.
 *
 * The account's plan comes from its `subscriptions` row (migration 0008),
 * which mirrors the payment provider's subscription: every webhook event, and
 * a nightly pass over all rows, reads the customer's latest subscription back
 * from the provider and stores it. Reading it back (rather than applying each
 * event's own copy) makes duplicated and out-of-order deliveries harmless.
 *
 * When an account loses real-time data (cancellation, refund, dispute, unpaid),
 * the gateway is told at once to close its real-time stream and to refuse the
 * passes made until then; if that call fails the pass expires within 15 minutes.
 *
 * The plan is worked out here alone, from what the provider says was paid: an
 * app can ask for a pass, never for a plan.
 */
import { Env } from "./env";
import { User, page } from "./auth";
import { requireUser } from "./api";
import { PASS_TTL, Plan, signPass } from "./pass";
import { HttpError, json, now } from "./util";

const API = "https://api.stripe.com";
/** The API version the calls below are written for (the period is on the subscription's items). */
const API_VERSION = "2025-03-31.basil";
/** Webhook signatures older than this are refused (replays). */
const SIGNATURE_TOLERANCE = 300;
const GATEWAY_TIMEOUT_MS = 5_000;
/** Real-time is kept this long after a renewal that failed, and after a period whose end nothing was heard of (s). */
const GRACE = 3 * 86_400;
const DAY = 86_400;
/** Largest webhook body read (characters). */
const MAX_WEBHOOK = 512 * 1024;
/** A checkout page is good this long (s; the provider's minimum). */
const CHECKOUT_TTL = 1_860;
/** `POST /billing/refresh` reads the provider at most this often per account (s). */
const REFRESH_EVERY = 8;

export type SubscriptionRow = {
  user_id: string;
  customer_id: string;
  subscription_id: string | null;
  status: string;
  current_period_end: number | null;
  cancel_at_period_end: number;
  updated_at: number;
  current_period_start: number | null;
  test: number;
  blocked: number;
};

type PlanRow = Pick<SubscriptionRow, "status" | "current_period_start" | "current_period_end"> & { blocked?: number };

/**
 * Real-time while the subscription is active or trialing (and its period's end
 * is not long past: nothing was heard of the renewal), and for GRACE from the
 * start of a period whose payment failed (past_due). The provider moves the
 * period on before it charges: the end of a past_due period is a month that
 * nobody paid. Anything else (canceled, unpaid, incomplete, paused, disputed, no
 * subscription) is the free plan.
 */
export function planOf(row: PlanRow | null, at = now()): Plan {
  if (!row || row.blocked) return "free";
  if (row.status === "active" || row.status === "trialing") {
    return row.current_period_end === null || at < row.current_period_end + GRACE ? "rt" : "free";
  }
  if (row.status === "past_due" && row.current_period_start !== null && at < row.current_period_start + GRACE) return "rt";
  return "free";
}

/** The account may subscribe (`PAID_OPEN`). */
export function openTo(env: Env, userId: string | null): boolean {
  const list = (env.PAID_OPEN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return billingOn(env) && (list.includes("1") || (userId !== null && list.includes(userId)));
}

/** GET /paid → {open, price}: whether the app offers the subscription to this account (or, signed out, to everyone). */
export function offer(env: Env, user: User | null): Response {
  return json({ open: !!env.PASS_PRIVATE_KEY && openTo(env, user?.id ?? null), price: env.PAID_PRICE || "$10" });
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
  const r = await row(env, u.id);
  const plan = planOf(r);
  const iat = now();
  const exp = iat + PASS_TTL;
  // A short id of the sign-in session, not the session token's hash itself.
  const pass = await signPass(env.PASS_PRIVATE_KEY, { sub: u.id, plan, sid: u.token_hash.slice(0, 12), iat, exp, ...(r?.test ? { test: true } : {}) });
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
    billing: openTo(env, u.id),
  });
}

// ── Checkout and customer portal ────────────────────────────────────────

/** POST /billing/checkout → {url}: the provider's checkout page for the subscription. */
export async function checkout(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  if (!openTo(env, u.id)) throw new HttpError(404, "Not available.");
  let r = await row(env, u.id);
  if (r?.blocked) throw new HttpError(403, "A payment of this account was disputed. Write to support@opentrader.markets.");
  // Not only the plan: a renewal being retried is a subscription, a second one would be charged besides it.
  if (planOf(r) === "rt" || r?.status === "past_due") throw new HttpError(409, "You already have a subscription. Manage it from your account.");
  if (!r) {
    // The same key for a checkout asked twice at once: one customer.
    const customer = await stripe(env, "POST", "/v1/customers", { "metadata[user_id]": u.id, description: u.name }, `customer-${u.id}`);
    await env.DB.prepare("INSERT INTO subscriptions (user_id, customer_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING").bind(u.id, customer.id, now()).run();
    r = (await row(env, u.id))!;
  }
  // One checkout page at a time: two paid would be two subscriptions.
  const open = await stripe(env, "GET", `/v1/checkout/sessions?customer=${encodeURIComponent(r.customer_id)}&status=open&limit=20`);
  for (const s of open.data ?? []) await stripe(env, "POST", `/v1/checkout/sessions/${encodeURIComponent(s.id)}/expire`, {});
  const session = await stripe(env, "POST", "/v1/checkout/sessions", {
    mode: "subscription",
    customer: r.customer_id,
    client_reference_id: u.id,
    // The provider sells (it owes the tax in every country), or this account does. Cards only then: a bank debit
    // starts the subscription days before it is paid, or not.
    ...(env.STRIPE_MANAGED === "1" ? { "managed_payments[enabled]": "true" } : { "payment_method_types[0]": "card" }),
    expires_at: String(now() + CHECKOUT_TTL),
    "line_items[0][price]": env.STRIPE_PRICE_ID!.split(",")[0].trim(),
    "line_items[0][quantity]": "1",
    "subscription_data[metadata][user_id]": u.id,
    success_url: `${env.PUBLIC_URL}/billing/done`,
    cancel_url: `${env.PUBLIC_URL}/billing/cancelled`,
    ...(env.STRIPE_TAX === "1" && env.STRIPE_MANAGED !== "1" ? { "automatic_tax[enabled]": "true", "customer_update[address]": "auto" } : {}),
    ...(env.STRIPE_TERMS === "1" ? { "consent_collection[terms_of_service]": "required" } : {}),
  });
  return json({ url: session.url });
}

/** POST /billing/portal → {url}: the provider's page to change card, cancel, see invoices. */
export async function portal(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  if (!billingOn(env)) throw new HttpError(404, "Not available.");
  const r = await row(env, u.id);
  if (!r) throw new HttpError(404, "No subscription yet.");
  const session = await stripe(env, "POST", "/v1/billing_portal/sessions", {
    customer: r.customer_id,
    return_url: `${env.PUBLIC_URL}/billing/done`,
    ...(env.STRIPE_PORTAL_CONFIG ? { configuration: env.STRIPE_PORTAL_CONFIG } : {}),
  });
  return json({ url: session.url });
}

/** POST /billing/refresh → the plan, read from the provider now: the app back from the checkout, before or without its webhook. */
export async function refresh(env: Env, user: User | null): Promise<Response> {
  const u = requireUser(user);
  const r = await row(env, u.id);
  if (r && billingOn(env) && now() - r.updated_at >= REFRESH_EVERY) await syncCustomer(env, r.customer_id);
  return myPlan(env, u);
}

/** The pages checkout and the portal come back to; the app reads the new plan by itself. */
export function returnPage(done: boolean): Response {
  return done
    ? page("Subscription", "<h1>Thank you</h1><p>You can go back to OpenTrader. Real-time data starts within a minute of a new subscription.</p>")
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
/** Events of a charge: a dispute opened takes the plan away, one won gives it back. */
const DISPUTES = new Set(["charge.dispute.created", "charge.dispute.closed"]);

/** POST /billing/webhook: the provider's events, signature checked, each applied once. */
export async function webhook(env: Env, request: Request): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET || !billingOn(env)) throw new HttpError(404, "Not available.");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK) throw new HttpError(413, "Too long.");
  const body = await request.text();
  if (body.length > MAX_WEBHOOK) throw new HttpError(413, "Too long.");
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
  if (DISPUTES.has(type)) await dispute(env, type, event.data?.object ?? {});
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

/** A disputed payment: the subscription ends and the account is blocked; a dispute won unblocks it. */
async function dispute(env: Env, type: string, d: any): Promise<void> {
  const id = typeof d.charge === "string" ? d.charge : d.charge?.id;
  if (!id) return;
  const charge = await stripe(env, "GET", `/v1/charges/${encodeURIComponent(id)}`);
  const customer = typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
  if (!customer) return;
  if (type === "charge.dispute.closed") {
    if (d.status === "won" || d.status === "warning_closed") await env.DB.prepare("UPDATE subscriptions SET blocked = 0 WHERE customer_id = ?").bind(customer).run();
    return;
  }
  const r = await env.DB.prepare("SELECT * FROM subscriptions WHERE customer_id = ?").bind(customer).first<SubscriptionRow>();
  if (!r) return;
  await env.DB.prepare("UPDATE subscriptions SET blocked = 1 WHERE customer_id = ?").bind(customer).run();
  if (planOf(r) === "rt") await revokeRealtime(env, r.user_id);
  await cancelCustomer(env, customer);
  await syncCustomer(env, customer);
}

const LIVE = ["active", "trialing", "past_due"];

/** It is charged, or will be. */
const isLive = (s: any): boolean => LIVE.includes(String(s.status));

/** The subscription is for the plan's price (`STRIPE_PRICE_ID`, comma-separated: the first is sold, the others were). */
function ours(env: Env, s: any): boolean {
  const prices = (env.STRIPE_PRICE_ID ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return (s.items?.data ?? []).some((i: any) => prices.includes(String(i.price?.id ?? i.price)));
}

/** The subscriptions of the customer for the plan's price: the one in force first, then the newest. */
async function subscriptionsOf(env: Env, customer: string): Promise<any[]> {
  const list = await stripe(env, "GET", `/v1/subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100`);
  const rank = (s: any) => (LIVE.includes(String(s.status)) ? LIVE.indexOf(String(s.status)) : LIVE.length);
  return (list.data ?? []).filter((s: any) => ours(env, s)).sort((a: any, b: any) => rank(a) - rank(b) || Number(b.created ?? 0) - Number(a.created ?? 0));
}

/** Read the customer's subscription back from the provider and store it. */
export async function syncCustomer(env: Env, customer: string): Promise<void> {
  const r = await env.DB.prepare("SELECT * FROM subscriptions WHERE customer_id = ?").bind(customer).first<SubscriptionRow>();
  if (!r) return; // A customer not made by this Worker.
  const [sub, ...rest] = await subscriptionsOf(env, customer);
  // Paid twice (two checkout pages at the same moment): the second is ended and credited.
  for (const s of rest) if (isLive(s)) await endSubscription(env, s.id, true);
  const next = sub
    ? {
        subscription_id: String(sub.id),
        status: String(sub.status),
        // Newer API versions keep the period on the subscription's items.
        current_period_start: numOrNull(sub.current_period_start ?? sub.items?.data?.[0]?.current_period_start),
        current_period_end: numOrNull(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end),
        // Set by the portal in either form.
        cancel_at_period_end: sub.cancel_at_period_end || sub.cancel_at ? 1 : 0,
        test: sub.livemode === true ? 0 : 1,
      }
    : { subscription_id: null, status: "none", current_period_start: null, current_period_end: null, cancel_at_period_end: 0, test: 0 };
  await env.DB.prepare(
    "UPDATE subscriptions SET subscription_id = ?, status = ?, current_period_start = ?, current_period_end = ?, cancel_at_period_end = ?, test = ?, updated_at = ? WHERE customer_id = ?",
  )
    .bind(next.subscription_id, next.status, next.current_period_start, next.current_period_end, next.cancel_at_period_end, next.test, now(), customer)
    .run();
  if (planOf(r) === "rt" && planOf({ ...next, blocked: r.blocked }) === "free") await revokeRealtime(env, r.user_id);
}

/** End a subscription now; `credit`: what is left of it goes to the customer's balance. */
async function endSubscription(env: Env, id: string, credit = false): Promise<void> {
  await stripe(env, "DELETE", `/v1/subscriptions/${encodeURIComponent(id)}${credit ? "?prorate=true&invoice_now=true" : ""}`);
}

/** Every subscription of the customer ends now, read from the provider: none is left to be charged. */
async function cancelCustomer(env: Env, customer: string): Promise<void> {
  for (const s of await subscriptionsOf(env, customer)) {
    if (isLive(s) || s.status === "unpaid" || s.status === "paused" || s.status === "incomplete") await endSubscription(env, s.id);
  }
}

/** Rows read back from the provider (cron, once a night): a webhook missed is caught here. A first checkout's too. */
export async function reconcile(env: Env): Promise<void> {
  if (!billingOn(env)) return;
  const { results } = await env.DB.prepare("SELECT customer_id FROM subscriptions WHERE status NOT IN ('none', 'canceled', 'incomplete_expired') OR updated_at > ?")
    .bind(now() - 30 * DAY)
    .all<{ customer_id: string }>();
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
  if (!billingOn(env)) return;
  const r = await row(env, userId);
  if (!r) return;
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

async function stripe(env: Env, method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, string>, idempotencyKey?: string): Promise<any> {
  const res = await fetch(`${env.STRIPE_API_URL ?? API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Stripe-Version": API_VERSION,
      ...(params ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
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
