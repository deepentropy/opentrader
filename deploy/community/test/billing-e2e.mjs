// End-to-end test of the paid tier's accounts side (#252): sign-in, passes,
// checkout, the payment webhook (signature, duplicates, read-back, refunds),
// revocation calls to the gateway, account deletion.
// Starts: a mock of the payment API and of the gateway's admin route (port
// 9931) + `wrangler dev --env local` on a fresh local database (port 8798).
// Run: npm run test:billing
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const MOCK_PORT = 9931;
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_SECRET = "whsec_test";
const ADMIN = "gw-admin";
const keys = generateKeyPairSync("ed25519");
const PRIVATE = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");

// ------------------------------------------------------------ mock payment API + gateway
const calls = []; // {method, path, form}
const subs = new Map(); // customer -> its newest subscription
const older = new Map(); // customer -> other subscriptions
const charges = new Map(); // charge -> customer
let openSessions = [];
/** A subscription as the provider sends it, for the plan's price and paid for real. */
const subscription = (o) => ({ livemode: true, items: { data: [{ price: { id: "price_test" } }] }, current_period_start: nowSec(), current_period_end: future(), ...o });
const nowSec = () => Math.floor(Date.now() / 1000);
let customers = 0;
const revokes = [];
const mock = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url, "http://x");
  const form = Object.fromEntries(new URLSearchParams(body));
  calls.push({ method: req.method, path: url.pathname, form });
  const send = (data, status = 200) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  };
  if (url.pathname === "/market/v1/stream/rt/revoke") {
    if (req.headers.authorization !== `Bearer ${ADMIN}`) return send({}, 401);
    revokes.push(JSON.parse(body).userId);
    return send({ closed: 1 });
  }
  if (req.headers.authorization !== "Bearer sk_test") return send({ error: { message: "bad key" } }, 401);
  if (req.method === "POST" && url.pathname === "/v1/customers") return send({ id: `cus_${++customers}` });
  if (req.method === "GET" && url.pathname === "/v1/checkout/sessions") return send({ data: openSessions });
  const expire = /^\/v1\/checkout\/sessions\/(.+)\/expire$/.exec(url.pathname);
  if (expire) {
    openSessions = openSessions.filter((s) => s.id !== expire[1]);
    return send({ id: expire[1] });
  }
  if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") return send({ url: "https://checkout.test/session" });
  const charge = /^\/v1\/charges\/(.+)$/.exec(url.pathname);
  if (charge) return send({ id: charge[1], customer: charges.get(charge[1]) });
  if (req.method === "POST" && url.pathname === "/v1/billing_portal/sessions") return send({ url: "https://portal.test/session" });
  if (req.method === "GET" && url.pathname === "/v1/subscriptions") {
    const customer = url.searchParams.get("customer");
    const sub = subs.get(customer);
    return send({ data: [...(sub ? [sub] : []), ...(older.get(customer) ?? [])] });
  }
  const del = /^\/v1\/subscriptions\/(.+)$/.exec(url.pathname);
  if (req.method === "DELETE" && del) {
    for (const sub of [...subs.values(), ...[...older.values()].flat()]) if (sub.id === del[1]) sub.status = "canceled";
    return send({ id: del[1], status: "canceled" });
  }
  send({ error: { message: "unknown" } }, 404);
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

// ------------------------------------------------------------ wrangler dev
const persist = mkdtempSync(join(tmpdir(), "billing-e2e-"));
execSync(`npx wrangler d1 migrations apply opentrader-community --env local --local --persist-to "${persist}"`, { stdio: "ignore", input: "y\n" });
const vars = {
  STRIPE_API_URL: `http://127.0.0.1:${MOCK_PORT}`, STRIPE_SECRET_KEY: "sk_test", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_ID: "price_test,price_old", STRIPE_PORTAL_CONFIG: "bpc_test", PAID_OPEN: "1", PASS_PRIVATE_KEY: PRIVATE, GATEWAY_URL: `http://127.0.0.1:${MOCK_PORT}`, GATEWAY_ADMIN_TOKEN: ADMIN,
  // The sign-in without the bot check.
  TURNSTILE_SITE_KEY: "",
};
const wrangler = spawn(
  "npx",
  ["wrangler", "dev", "--env", "local", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", `"${persist}"`,
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])],
  { shell: true, stdio: ["ignore", "pipe", "pipe"] },
);
let out = "";
wrangler.stdout.on("data", (d) => (out += d));
wrangler.stderr.on("data", (d) => (out += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for: ${what}`);
}

// ------------------------------------------------------------ helpers
const b64url = (buf) => Buffer.from(buf).toString("base64url");
async function login(name) {
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const redirect = "http://127.0.0.1:1/community-auth";
  const q = new URLSearchParams({ provider: "dev", state, challenge, redirect });
  assert.equal((await fetch(`${BASE}/auth/start?${q}`)).status, 200);
  const r = await fetch(`${BASE}/auth/dev?${new URLSearchParams({ state, name })}`, { redirect: "manual" });
  const code = new URL(r.headers.get("location")).searchParams.get("code");
  const t = await fetch(`${BASE}/auth/token`, { method: "POST", body: JSON.stringify({ code, verifier }) });
  return (await t.json()).token;
}
const api = (token) => async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
let events = 0;
async function deliver(type, object, { id = `evt_${++events}`, secret = WEBHOOK_SECRET } = {}) {
  const body = JSON.stringify({ id, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const r = await fetch(`${BASE}/billing/webhook`, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}` }, body });
  return { status: r.status, data: await r.json().catch(() => null) };
}
function passClaims(pass) {
  const [prefix, payload, sig] = pass.split(".");
  assert.equal(prefix, "otp1");
  assert.ok(verify(null, Buffer.from(`otp1.${payload}`), keys.publicKey, Buffer.from(sig, "base64url")), "pass signature");
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}
const future = () => Math.floor(Date.now() / 1000) + 30 * 86400;

let step = 0;
const ok = (name) => console.log(`[${++step}] ok  ${name}`);

try {
  await until(() => /Ready on/.test(out), "wrangler dev ready", 90_000);
  const owner = api(await login("pilot_owner"));

  // 1. free account
  let r = await owner("GET", "/me/plan");
  assert.deepEqual(r.data, { plan: "free", status: "none", renews_at: null, cancel_at_period_end: false, billing: true });
  r = await owner("POST", "/auth/pass");
  let claims = passClaims(r.data.pass);
  assert.equal(claims.plan, "free");
  assert.equal(claims.exp - claims.iat, 900);
  const userId = claims.sub;
  assert.equal((await fetch(`${BASE}/auth/pass`, { method: "POST" })).status, 401);
  ok("free account: plan free, a signed 15-minute pass; no pass without sign-in");

  // 2. checkout
  r = await owner("POST", "/billing/checkout");
  assert.equal(r.data.url, "https://checkout.test/session");
  const session = calls.find((c) => c.method === "POST" && c.path === "/v1/checkout/sessions").form;
  assert.equal(session["line_items[0][price]"], "price_test");
  assert.equal(session.mode, "subscription");
  assert.equal(session.customer, "cus_1");
  assert.equal(session.client_reference_id, userId);
  assert.equal(session["payment_method_types[0]"], "card");
  openSessions = [{ id: "cs_old" }];
  await owner("POST", "/billing/checkout");
  assert.deepEqual(openSessions, [], "the page opened before is closed");
  assert.equal(calls.filter((c) => c.path === "/v1/customers").length, 1);
  ok("checkout: customer made once, subscription session for the price");

  // 3. webhook: bad signature, then the subscription
  assert.equal((await deliver("customer.subscription.created", { customer: "cus_1" }, { secret: "whsec_other" })).status, 400);
  // Not the plan's price, as a change of plan or another product would be: no real-time.
  subs.set("cus_1", subscription({ id: "sub_0", customer: "cus_1", status: "active", items: { data: [{ price: { id: "price_cheap" } }] } }));
  await deliver("customer.subscription.created", { customer: "cus_1" });
  assert.equal((await owner("GET", "/me/plan")).data.plan, "free");
  subs.set("cus_1", {
    id: "sub_1", customer: "cus_1", status: "active", livemode: true, cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_test" }, current_period_start: nowSec(), current_period_end: future() }] },
  });
  r = await deliver("customer.subscription.created", { customer: "cus_1" }, { id: "evt_created" });
  assert.equal(r.status, 200);
  r = await owner("GET", "/me/plan");
  assert.equal(r.data.plan, "rt");
  assert.ok(r.data.renews_at > Date.now() / 1000);
  claims = passClaims((await owner("POST", "/auth/pass")).data.pass);
  assert.equal(claims.plan, "rt");
  assert.equal(claims.test, undefined);
  subs.get("cus_1").livemode = false;
  await deliver("customer.subscription.updated", { customer: "cus_1" });
  assert.equal(passClaims((await owner("POST", "/auth/pass")).data.pass).test, true, "a test card's pass says so");
  subs.get("cus_1").livemode = true;
  await deliver("customer.subscription.updated", { customer: "cus_1" });
  ok("signed webhook: plan rt, pass rt (period end read from the subscription's items); a bad signature is refused");

  // 4. duplicate and already subscribed
  r = await deliver("customer.subscription.created", { customer: "cus_1" }, { id: "evt_created" });
  assert.equal(r.data.duplicate, true);
  assert.equal((await owner("POST", "/billing/checkout")).status, 409);
  assert.equal((await owner("POST", "/billing/portal")).data.url, "https://portal.test/session");
  assert.equal(calls.findLast((c) => c.path === "/v1/billing_portal/sessions").form.configuration, "bpc_test");
  ok("a delivery sent again is skipped; no second checkout; portal link");

  // 5. cancellation in the portal, then an older event arriving late
  subs.get("cus_1").status = "canceled";
  await deliver("customer.subscription.deleted", { customer: "cus_1", status: "canceled" });
  assert.equal((await owner("GET", "/me/plan")).data.plan, "free");
  assert.deepEqual(revokes, [userId]);
  await deliver("customer.subscription.updated", { customer: "cus_1", status: "active" });
  assert.equal((await owner("GET", "/me/plan")).data.plan, "free");
  assert.equal(revokes.length, 1);
  ok("cancellation: plan free, the gateway told once; a late older event changes nothing (state read back)");

  // 6. renewal payment failing
  subs.set("cus_1", subscription({ id: "sub_2", customer: "cus_1", status: "past_due" }));
  await deliver("invoice.payment_failed", { customer: "cus_1" });
  assert.equal((await owner("GET", "/me/plan")).data.plan, "rt");
  assert.equal((await owner("POST", "/billing/checkout")).status, 409, "no second subscription while the first is retried");
  // Three days later: the period the provider moved on to ends in weeks, but nobody paid it.
  subs.get("cus_1").current_period_start = nowSec() - 3 * 86400;
  await deliver("invoice.payment_failed", { customer: "cus_1" });
  assert.equal((await owner("GET", "/me/plan")).data.plan, "free");
  assert.equal(revokes.length, 2);
  ok("past due: real-time kept three days, then dropped, whatever the period's end");

  // 7. full refund
  subs.set("cus_1", subscription({ id: "sub_3", customer: "cus_1", status: "active", items: { data: [{ price: "price_old" }] } }));
  await deliver("invoice.paid", { customer: "cus_1" });
  assert.equal((await owner("GET", "/me/plan")).data.plan, "rt");
  await deliver("charge.refunded", { customer: "cus_1", refunded: false });
  assert.equal((await owner("GET", "/me/plan")).data.plan, "rt", "partial refund keeps the subscription");
  await deliver("charge.refunded", { customer: "cus_1", refunded: true });
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_3"));
  assert.equal((await owner("GET", "/me/plan")).data.plan, "free");
  assert.equal(revokes.length, 3);
  ok("full refund: subscription ended, plan free, gateway told; a partial refund changes nothing");

  // 7b. a webhook that never came: the app back from the checkout has the plan read
  subs.set("cus_1", subscription({ id: "sub_4", customer: "cus_1", status: "active" }));
  assert.equal((await owner("GET", "/me/plan")).data.plan, "free");
  await until(async () => (await owner("POST", "/billing/refresh")).data.plan === "rt", "plan read on refresh", 12_000);
  const reads = calls.filter((c) => c.path === "/v1/subscriptions").length;
  for (let i = 0; i < 5; i++) await owner("POST", "/billing/refresh");
  assert.equal(calls.filter((c) => c.path === "/v1/subscriptions").length, reads, "not read again at once");
  ok("refresh: the plan read from the provider without its webhook, a few times a minute at most");

  // 7c. paid twice: one subscription is kept
  older.set("cus_1", [subscription({ id: "sub_5", customer: "cus_1", status: "active", created: 5 })]);
  subs.get("cus_1").created = 10;
  await deliver("customer.subscription.created", { customer: "cus_1" });
  assert.equal(older.get("cus_1")[0].status, "canceled");
  assert.equal(subs.get("cus_1").status, "active");
  assert.equal((await owner("GET", "/me/plan")).data.plan, "rt");
  // the newest one ended, an older one still charged: the plan is the one in force
  older.set("cus_1", [subscription({ id: "sub_6", customer: "cus_1", status: "active", created: 1 })]);
  subs.get("cus_1").status = "canceled";
  await deliver("customer.subscription.deleted", { customer: "cus_1" });
  assert.equal((await owner("GET", "/me/plan")).data.plan, "rt");
  ok("two subscriptions: the second is ended and credited; the one in force makes the plan");

  // 7d. a disputed payment
  charges.set("ch_1", "cus_1");
  const before = revokes.length;
  await deliver("charge.dispute.created", { charge: "ch_1", status: "needs_response" });
  assert.equal((await owner("GET", "/me/plan")).data.plan, "free");
  assert.equal(older.get("cus_1")[0].status, "canceled");
  assert.equal(revokes.length, before + 1);
  assert.equal((await owner("POST", "/billing/checkout")).status, 403);
  subs.set("cus_1", subscription({ id: "sub_7", customer: "cus_1", status: "active" }));
  await deliver("customer.subscription.created", { customer: "cus_1" });
  assert.equal((await owner("GET", "/me/plan")).data.plan, "free", "blocked whatever is paid after");
  await deliver("charge.dispute.closed", { charge: "ch_1", status: "lost" });
  assert.equal((await owner("GET", "/me/plan")).data.plan, "free");
  await deliver("charge.dispute.closed", { charge: "ch_1", status: "won" });
  assert.equal((await owner("GET", "/me/plan")).data.plan, "rt");
  ok("a disputed payment: subscription ended, plan free, no new checkout until it is won");

  // 8. account deleted while subscribed
  const other = api(await login("pilot_other"));
  await other("POST", "/billing/checkout");
  subs.set("cus_2", subscription({ id: "sub_9", customer: "cus_2", status: "active" }));
  await deliver("checkout.session.completed", { customer: "cus_2" });
  assert.equal((await other("GET", "/me/plan")).data.plan, "rt");
  assert.equal((await other("DELETE", "/me")).status, 200);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/v1/subscriptions/sub_9"));
  ok("account deleted: its subscription is ended first");

  // the offer, for an app that is not signed in too
  assert.deepEqual(await (await fetch(`${BASE}/paid`)).json(), { open: true, price: "$10" });
  // nothing an app sends makes a plan
  const thief = api(await login("thief"));
  for (const [m, p, b] of [["POST", "/auth/pass", { plan: "rt", sub: userId }], ["GET", "/me/plan?plan=rt", undefined], ["POST", "/billing/refresh", { customer: "cus_1", plan: "rt" }]]) {
    const x = await thief(m, p, b);
    assert.equal(x.data.plan, "free", p);
  }
  const forged = JSON.stringify({ id: "evt_forged", type: "customer.subscription.created", data: { object: { customer: "cus_1", status: "active" } } });
  for (const headers of [{}, { "stripe-signature": "t=1,v1=00" }, { "stripe-signature": `t=${nowSec()},v1=${"0".repeat(64)}` }, { "stripe-signature": `t=${nowSec()},v0=x` }]) {
    assert.equal((await fetch(`${BASE}/billing/webhook`, { method: "POST", headers, body: forged })).status, 400);
  }
  assert.equal((await fetch(`${BASE}/billing/webhook`, { method: "POST", body: "x".repeat(600_000) })).status, 413);
  ok("the offer; a plan asked for, and webhooks forged, give nothing");

  // 9. return pages
  assert.equal((await fetch(`${BASE}/billing/done`)).status, 200);
  assert.equal((await fetch(`${BASE}/billing/cancelled`)).status, 200);
  ok("checkout return pages");

  console.log("\nall billing tests passed");
} catch (err) {
  console.error(err);
  console.error("---- wrangler output ----\n" + out.slice(-4000));
  process.exitCode = 1;
} finally {
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${wrangler.pid} /T /F`, { stdio: "ignore" });
    } catch {}
  } else wrangler.kill();
  mock.close();
  setTimeout(() => {
    try {
      rmSync(persist, { recursive: true, force: true });
    } catch {}
    process.exit();
  }, 500);
}
