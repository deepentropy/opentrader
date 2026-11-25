/*
 * The payment page (#252): the payment provider's embedded checkout, shown by
 * the app in a dialog (or by the browser, from the dialog's link).
 *
 *   GET /billing/pay#<client secret>
 *
 * It is a page of this server, not of the app: the provider's script runs away
 * from the app's own (its broker, its files), and over HTTPS as it must. The
 * client secret comes in the fragment, which is sent to no server: it only lets
 * its holder pay. Card numbers go from the provider's own frames to the provider.
 */
import { Env } from "./env";

const STRIPE_JS = "https://js.stripe.com/dahlia/stripe.js";
/** Page origins of the desktop app's webview (Windows; macOS and Linux). */
const APP_ORIGINS = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"];

const SCRIPT = `(async () => {
  const box = document.getElementById("pay");
  const say = (text) => { box.textContent = text; };
  // The app's dialog; the message says only that the payment page ended.
  const tell = (event) => { if (parent !== window) parent.postMessage({ type: "opentrader-billing", event }, "*"); };
  const secret = decodeURIComponent(location.hash.slice(1));
  // Not left in the address, where a reload after the payment would open it again.
  history.replaceState(null, "", location.pathname);
  if (!/^cs_[A-Za-z0-9_]+_secret_/.test(secret) || !window.Stripe) {
    say("The payment page could not be loaded. Close it and try again.");
    return tell("failed");
  }
  try {
    const stripe = Stripe(document.currentScript?.dataset.key ?? document.getElementById("pay-script").dataset.key);
    const checkout = await stripe.createEmbeddedCheckoutPage({
      fetchClientSecret: async () => secret,
      onComplete: () => tell("complete"),
    });
    box.textContent = "";
    checkout.mount(box);
    tell("ready");
  } catch (e) {
    say("The payment page could not be loaded. Close it and try again.");
    tell("failed");
  }
})();`;

/** GET /billing/pay */
export function payPage(env: Env): Response {
  const key = env.STRIPE_PUBLISHABLE_KEY ?? "";
  if (!/^pk_(test|live)_[A-Za-z0-9]+$/.test(key)) return new Response("Not available.", { status: 404 });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>OpenTrader</title>
<style>html,body{margin:0;background:#fff;color:#131722;font:14px system-ui,sans-serif}#pay{min-height:200px;padding:8px}</style>
<script src="${STRIPE_JS}"></script></head><body><div id="pay">…</div><script id="pay-script" src="/billing/pay.js" data-key="${key}" defer></script></body></html>`;
  const ancestors = [...APP_ORIGINS, ...env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)].join(" ");
  const csp = [
    "default-src 'none'",
    "script-src 'self' https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com",
    "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://checkout.stripe.com https://link.com https://*.link.com",
    "connect-src https://api.stripe.com https://checkout.stripe.com https://link.com https://*.link.com",
    "img-src 'self' data: https://*.stripe.com https://*.link.com",
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

/** GET /billing/pay.js */
export function payScript(): Response {
  return new Response(SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
}
