// The payment provider's side of the paid tier (#252), made once per mode (test,
// then live): the monthly price, the webhook, the customer portal (cancel, card and
// invoices; no change of plan). Run again, it finds what it made and changes
// nothing but the portal's settings. Prints the values of this Worker's secrets.
// Run: STRIPE_SECRET_KEY=sk_... node scripts/stripe-setup.mjs [--price 10] [--currency usd] [--url https://community.opentrader.markets]
const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY is not set.");
  process.exit(1);
}
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const amount = Math.round(Number(arg("price", "10")) * 100);
const currency = arg("currency", "usd").toLowerCase();
const url = arg("url", "https://community.opentrader.markets").replace(/\/+$/, "");
const API = process.env.STRIPE_API_URL ?? "https://api.stripe.com";
const LOOKUP = `opentrader_realtime_monthly_${currency}_${amount}`;
const EVENTS = [
  "checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "customer.subscription.paused", "customer.subscription.resumed", "invoice.paid", "invoice.payment_failed", "charge.refunded",
  "charge.dispute.created", "charge.dispute.closed",
];

async function call(method, path, params) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2025-03-31.basil", "content-type": "application/x-www-form-urlencoded" },
    body: params && new URLSearchParams(params).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data?.error?.message ?? ""}`);
  return data;
}

// One price per amount: a new amount is a new price, sold from then on; subscribers keep theirs.
let price = (await call("GET", `/v1/prices?lookup_keys[]=${LOOKUP}&active=true`)).data[0];
if (!price) {
  const product = await call("POST", "/v1/products", {
    name: "OpenTrader live data", "metadata[app]": "opentrader",
    // General, electronically supplied services: a code the provider's managed payments take.
    tax_code: "txcd_10000000",
  });
  price = await call("POST", "/v1/prices", {
    product: product.id, unit_amount: String(amount), currency, "recurring[interval]": "month", lookup_key: LOOKUP,
  });
}

const endpoint = `${url}/billing/webhook`;
const hooks = (await call("GET", "/v1/webhook_endpoints?limit=100")).data.filter((h) => h.url === endpoint);
let secret = null;
const events = Object.fromEntries(EVENTS.map((e, i) => [`enabled_events[${i}]`, e]));
if (hooks.length) await call("POST", `/v1/webhook_endpoints/${hooks[0].id}`, events);
else secret = (await call("POST", "/v1/webhook_endpoints", { url: endpoint, ...events })).secret;

const portalSettings = {
  "features[customer_update][enabled]": "false",
  "features[invoice_history][enabled]": "true",
  "features[payment_method_update][enabled]": "true",
  "features[subscription_cancel][enabled]": "true",
  "features[subscription_cancel][mode]": "at_period_end",
  "features[subscription_update][enabled]": "false",
  "business_profile[privacy_policy_url]": "https://opentrader.markets/privacy.html",
  "business_profile[terms_of_service_url]": "https://opentrader.markets/terms.html",
  "metadata[app]": "opentrader",
};
const portals = (await call("GET", "/v1/billing_portal/configurations?limit=100&active=true")).data.filter((c) => c.metadata?.app === "opentrader");
const portal = portals.length
  ? await call("POST", `/v1/billing_portal/configurations/${portals[0].id}`, portalSettings)
  : await call("POST", "/v1/billing_portal/configurations", portalSettings);

console.log(`mode: ${price.livemode ? "live" : "test"}`);
console.log(`STRIPE_PRICE_ID=${price.id}`);
console.log(`STRIPE_PORTAL_CONFIG=${portal.id}`);
console.log(secret ? `STRIPE_WEBHOOK_SECRET=${secret}` : "STRIPE_WEBHOOK_SECRET: made before; read it in the provider's dashboard (it is shown once here)");
