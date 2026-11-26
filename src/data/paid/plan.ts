/*
 * Paid tier (#252): the offer, the account's plan and its pass.
 *
 * Whether real-time data is offered, and its price, is the accounts server's
 * answer (`GET /paid`): the offer opens and closes without a new version of the
 * app. Nothing is shown while it is closed, but a subscriber keeps its badge.
 *
 * A signed-in account (Community sign-in, ../community/session.ts) asks the
 * accounts server for a pass (`POST /auth/pass`, 15 min) and asks again two
 * minutes before it expires. A pass of the paid plan goes to the Rust side
 * (`marketPassSet`): from then on bars, snapshots and the live stream come
 * real-time (src-tauri/crates/core/src/data/pass.rs). Signed out, free plan,
 * or the server unreachable once the pass expired: delayed data, as before.
 * What this file believes of the plan changes words on screen only: the pass is
 * signed by the server and checked by the gateway.
 *
 * Real-time starts when the live stream's real-time session is up (the
 * gateway answers REST calls real-time only for that session, gateway#19);
 * open charts then load their data again, and again when it ends.
 *
 * The live stream tells why real-time ended (`market-tier`): another device
 * took the account's real-time session (this one stays delayed until the user
 * takes it back), the pass expired or was refused (a new one is asked), or
 * the account is not served real-time (asked again later). Desktop only: the
 * web server is shared by its users.
 *
 * The live data beta: until its end (`beta_until`, from `/paid` and `/me/plan`)
 * every signed-in account gets real-time passes; the badge and the dialog say
 * it is free until then and part of a paid plan after.
 */
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands, events, type MarketTier } from "../../bindings";
import { emitAppEvent } from "../app-events";
import { isTauri } from "../../window/shell/window-bridge";
import { COMMUNITY_ENABLED, CommunityError, request } from "../community/api";
import { initSession, me, ready } from "../community/session";

export type PlanInfo = {
  plan: "free" | "rt";
  status: string;
  /** End of the paid period (UNIX seconds): the renewal, or the end when cancelled. */
  renews_at: number | null;
  cancel_at_period_end: boolean;
  /** This account may subscribe. */
  billing: boolean;
  /** Real-time comes from the live data beta, which ends then (UNIX seconds); null otherwise. */
  beta_until?: number | null;
};

/** What the accounts server offers: to everyone, or (signed in) to this account. */
export type Offer = { open: boolean; price: string; /** End of the live data beta (UNIX seconds), null when none. */ beta: number | null };

type PassAnswer = { pass: string; plan: "free" | "rt"; exp: number };

/** Ask a new pass this long before the current one expires (s). */
const RENEW_BEFORE = 120;
const RETRY_MIN = 30_000;
const RETRY_MAX = 300_000;
/** A pass the gateway refused: a new one is tried after this, longer each time (ms). */
const REFUSED_MIN = 30_000;
const REFUSED_MAX = 15 * 60_000;
/** Back on the window, the plan is read again at most this often (ms). */
const FOCUS_EVERY = 60_000;
/** The offer is read again this often (ms): it may open while the app runs for days. */
const OFFER_EVERY = 6 * 3_600_000;
/** Charts load again this long after the tier changed (ms): the gateway keeps
 *  an account's "no session" answer up to 1 s. */
const RELOAD_AFTER_TIER_MS = 1_500;
/** While a payment page is open in the browser: look for the new plan this often, this long (ms). */
const CHECKOUT_POLL = 10_000;
/** The dialog said it is paid: sooner. */
const PAID_POLL = 2_500;
/** A connection lost for less than this changes nothing on screen (ms). */
const RECONNECT_WITHIN = 5_000;
const CHECKOUT_POLL_FOR = 10 * 60_000;

const [offer, setOffer] = createSignal<Offer | null>(null);
const [info, setInfo] = createSignal<PlanInfo | null>(null);
/** A paid pass is with the Rust side. */
const [handed, setHanded] = createSignal(false);
/** The live stream's real-time session is up. */
const [live, setLive] = createSignal(false);
const [elsewhere, setElsewhere] = createSignal(false);
/** The gateway refused the account's pass: no pass is handed over until the next try. */
const [refused, setRefused] = createSignal(false);

/** The account's plan, once read (null: signed out or not read yet). */
export { info as planInfo, elsewhere as realtimeElsewhere, offer as paidOffer };

/** Market data comes real-time on this device now. */
export const realtimeActive = () => handed() && live() && !elsewhere() && !refused();

/** The live data beta's end (UNIX seconds) while this user is on it, or may sign in for it; null otherwise. */
export const betaEnds = (): number | null => {
  const i = info();
  if (i) return i.beta_until ?? null;
  const end = offer()?.beta ?? null;
  return end !== null && end > Date.now() / 1000 ? end : null;
};

/** Real-time data is on screen: offered to this user, or theirs. */
export const paidShown = () => !!offer()?.open || betaEnds() !== null || info()?.plan === "rt" || info()?.status === "past_due";

const nowSec = () => Math.floor(Date.now() / 1000);
let timer: ReturnType<typeof setTimeout> | undefined;
let retry = RETRY_MIN;
let refusedTimer: ReturnType<typeof setTimeout> | undefined;
let refusedWait = REFUSED_MIN;
let refreshedAt = 0;
let lostTimer: ReturnType<typeof setTimeout> | undefined;

async function handOver(p: PassAnswer | null): Promise<void> {
  await commands.marketPassSet(p?.pass ?? null, p?.exp ?? null);
  setHanded(!!p);
}

async function loadPlan(): Promise<void> {
  try {
    setInfo(await request<PlanInfo>("GET", "/me/plan"));
  } catch {
    /* kept: the pass still says the plan */
  }
}

/** What is offered now. A server without the paid tier offers nothing. */
export async function refreshOffer(): Promise<void> {
  try {
    const r = await request<{ open?: boolean; price?: string; beta_until?: number | null }>("GET", "/paid");
    setOffer({ open: r.open === true, price: String(r.price), beta: typeof r.beta_until === "number" ? r.beta_until : null });
  } catch (e) {
    if (e instanceof CommunityError && e.status === 404) setOffer(null);
  }
}

/** The gateway takes the account's passes again (or a new plan was paid): try at once. */
function clearRefused(): void {
  clearTimeout(refusedTimer);
  refusedTimer = undefined;
  setRefused(false);
}

/** A new pass now (and the next one before it expires). */
export async function refreshPass(): Promise<void> {
  clearTimeout(timer);
  refreshedAt = Date.now();
  if (!me()) {
    setInfo(null);
    clearRefused();
    await handOver(null);
    return;
  }
  try {
    const r = await request<PassAnswer>("POST", "/auth/pass");
    retry = RETRY_MIN;
    // The plan came back: what was refused before says nothing about it.
    if (r.plan === "rt" && info()?.plan === "free") clearRefused();
    await handOver(r.plan === "rt" && !refused() ? r : null);
    void loadPlan();
    timer = setTimeout(() => void refreshPass(), Math.max(10, r.exp - nowSec() - RENEW_BEFORE) * 1000);
  } catch (e) {
    // No paid tier on this server, or the session ended: free, no retry.
    if (e instanceof CommunityError && (e.status === 404 || e.status === 401)) {
      await handOver(null);
      return;
    }
    // Unreachable: the pass handed over stays good until it expires.
    timer = setTimeout(() => void refreshPass(), retry);
    retry = Math.min(retry * 2, RETRY_MAX);
  }
}

/** A `market-tier` event of the live stream. */
export function onMarketTier(payload: MarketTier): void {
  if (payload.tier === "delayed" && payload.reason === null) {
    // Each try that fails says so again: the first loss counts.
    lostTimer ??= setTimeout(() => setLive(false), RECONNECT_WITHIN);
    return;
  }
  clearTimeout(lostTimer);
  lostTimer = undefined;
  if (payload.tier === "realtime") {
    setLive(true);
    setElsewhere(false);
    refusedWait = REFUSED_MIN;
    return;
  }
  setLive(false);
  switch (payload.reason) {
    case "signed_in_elsewhere":
    case "too_many_devices":
      setElsewhere(true);
      break;
    case "not_allowed":
      setRefused(true);
      setHanded(false);
      clearTimeout(refusedTimer);
      refusedTimer = setTimeout(() => {
        clearRefused();
        void refreshPass();
      }, refusedWait);
      refusedWait = Math.min(refusedWait * 2, REFUSED_MAX);
      break;
    default:
      // Expired, refused or revoked: a new pass, if the plan still has one.
      setHanded(false);
      setTimeout(() => void refreshPass(), 1000);
  }
}

let started = false;

/** Start once (the title bar mounts it): follows the offer, the sign-in and the stream's tier. */
export function initPaid(): void {
  if (!COMMUNITY_ENABLED || !isTauri() || started) return;
  started = true;
  createRoot(() => {
    // Once the saved session is known, then on every sign-in and sign-out.
    createEffect(
      on(() => (ready() ? me()?.user.name ?? "" : null), (name) => {
        if (name === null) return;
        void refreshOffer();
        void refreshPass();
      }),
    );
    // Bars loaded on the other tier: load them again (a delayed tail, or real-time bars a free account may not keep).
    createEffect(
      on(realtimeActive, () => void setTimeout(() => emitAppEvent("chart-reload-data"), RELOAD_AFTER_TIER_MS), { defer: true }),
    );
  });
  void initSession();
  setInterval(() => void refreshOffer(), OFFER_EVERY);
  void events.marketTier.listen(({ payload }) => onMarketTier(payload));
  // Back from the checkout or the portal in the browser: the plan may have changed.
  window.addEventListener("focus", () => {
    if (me() && (paidShown() || handed()) && Date.now() - refreshedAt > FOCUS_EVERY) void refreshPass();
  });
}

/** A payment page to show: its address, with the secret it opens the checkout with. */
export async function startCheckout(): Promise<string> {
  const { page, secret } = await request<{ page: string; secret: string }>("POST", "/billing/checkout");
  return `${page}#${encodeURIComponent(secret)}`;
}

/** Look for the plan just paid; true once it is there. The server asks the payment provider, told of it or not. */
export function awaitPlan(every = PAID_POLL, during = CHECKOUT_POLL_FOR): Promise<boolean> {
  const until = Date.now() + during;
  return new Promise((done) => {
    const poll = async () => {
      const plan = await request<PlanInfo>("POST", "/billing/refresh").catch(() => null);
      if (plan?.plan === "rt") {
        await refreshPass();
        return done(true);
      }
      if (Date.now() < until) setTimeout(() => void poll(), every);
      else done(false);
    };
    setTimeout(() => void poll(), every);
  });
}

/** The payment page in the browser instead of the dialog. */
export async function payInBrowser(address: string): Promise<void> {
  await openUrl(address);
  void awaitPlan(CHECKOUT_POLL);
}

/** End the subscription with its paid period, or keep it after all. */
export async function setCancelled(cancelled: boolean): Promise<void> {
  setInfo(await request<PlanInfo>("POST", cancelled ? "/billing/cancel" : "/billing/resume"));
}

/** The provider's page to change the card or see the invoices. */
export async function openPortal(): Promise<void> {
  const { url } = await request<{ url: string }>("POST", "/billing/portal");
  // Back from it, the focus reads the plan again.
  refreshedAt = 0;
  await openUrl(url);
}

/** Take the real-time session back from the other device. */
export async function useRealtimeHere(): Promise<void> {
  await commands.marketPassResume();
  setElsewhere(false);
}
