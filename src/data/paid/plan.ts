/*
 * Paid tier (#252): the account's plan and its pass.
 *
 * A signed-in account (Community sign-in, ../community/session.ts) asks the
 * accounts server for a pass (`POST /auth/pass`, 15 min) and asks again two
 * minutes before it expires. A pass of the paid plan goes to the Rust side
 * (`marketPassSet`): from then on bars, snapshots and the live stream come
 * real-time (src-tauri/crates/core/src/data/pass.rs). Signed out, free plan,
 * or the server unreachable once the pass expired: delayed data, as before.
 *
 * Real-time starts when the live stream's real-time session is up (the
 * gateway answers REST calls real-time only for that session, gateway#19);
 * open charts then load their data again, and again when it ends.
 *
 * The live stream tells why real-time ended (`market-tier`): another device
 * took the account's real-time session (this one stays delayed until the user
 * takes it back), the pass expired or was refused (a new one is asked), or
 * the account is not served real-time (pilot allow-list: no more passes this
 * run). Desktop only: the web server is shared by its users.
 *
 * Off unless the build sets VITE_PAID_ENABLED=1.
 */
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands, events, type MarketTier } from "../../bindings";
import { emitAppEvent } from "../app-events";
import { isTauri } from "../../window/shell/window-bridge";
import { CommunityError, request } from "../community/api";
import { initSession, me } from "../community/session";

export const PAID_ENABLED = import.meta.env.VITE_PAID_ENABLED === "1";

export type PlanInfo = {
  plan: "free" | "rt";
  status: string;
  /** End of the paid period (UNIX seconds): the renewal, or the end when cancelled. */
  renews_at: number | null;
  cancel_at_period_end: boolean;
  /** Checkout is set up on the server. */
  billing: boolean;
};

type PassAnswer = { pass: string; plan: "free" | "rt"; exp: number };

/** Ask a new pass this long before the current one expires (s). */
const RENEW_BEFORE = 120;
const RETRY_MIN = 30_000;
const RETRY_MAX = 300_000;
/** Charts load again this long after the tier changed (ms): the gateway keeps
 *  an account's "no session" answer up to 1 s. */
const RELOAD_AFTER_TIER_MS = 1_500;
/** After a checkout: look for the new plan this often, this long (ms). */
const CHECKOUT_POLL = 10_000;
const CHECKOUT_POLL_FOR = 5 * 60_000;

const [info, setInfo] = createSignal<PlanInfo | null>(null);
/** A paid pass is with the Rust side. */
const [handed, setHanded] = createSignal(false);
/** The live stream's real-time session is up. */
const [live, setLive] = createSignal(false);
const [elsewhere, setElsewhere] = createSignal(false);
const [notAllowed, setNotAllowed] = createSignal(false);

/** The account's plan, once read (null: signed out or not read yet). */
export { info as planInfo, elsewhere as realtimeElsewhere };

/** Market data comes real-time on this device now. */
export const realtimeActive = () => handed() && live() && !elsewhere() && !notAllowed();

const nowSec = () => Math.floor(Date.now() / 1000);
let timer: ReturnType<typeof setTimeout> | undefined;
let retry = RETRY_MIN;

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

/** A new pass now (and the next one before it expires). */
export async function refreshPass(): Promise<void> {
  clearTimeout(timer);
  if (!me()) {
    setInfo(null);
    await handOver(null);
    return;
  }
  try {
    const r = await request<PassAnswer>("POST", "/auth/pass");
    retry = RETRY_MIN;
    await handOver(r.plan === "rt" && !notAllowed() ? r : null);
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
  if (payload.tier === "realtime") {
    setLive(true);
    setElsewhere(false);
    return;
  }
  setLive(false);
  switch (payload.reason) {
    case "signed_in_elsewhere":
      setElsewhere(true);
      break;
    case "not_allowed":
      setNotAllowed(true);
      setHanded(false);
      break;
    case null:
      break;
    default:
      // Expired, refused or revoked: a new pass, if the plan still has one.
      setHanded(false);
      setTimeout(() => void refreshPass(), 1000);
  }
}

let started = false;

/** Start once (the title bar mounts it): follows the sign-in and the stream's tier. */
export function initPaid(): void {
  if (!PAID_ENABLED || !isTauri() || started) return;
  started = true;
  void initSession();
  createRoot(() => {
    createEffect(on(() => me()?.user.name ?? null, () => void refreshPass()));
    // Bars loaded on the other tier: load them again (a delayed tail, or real-time bars a free account may not keep).
    createEffect(
      on(realtimeActive, () => void setTimeout(() => emitAppEvent("chart-reload-data"), RELOAD_AFTER_TIER_MS), { defer: true }),
    );
  });
  void events.marketTier.listen(({ payload }) => onMarketTier(payload));
  // Back from the checkout or the portal in the browser: the plan may have changed.
  window.addEventListener("focus", () => {
    if (me()) void refreshPass();
  });
}

/** The provider's checkout page in the browser; the new plan is picked up within a minute. */
export async function startCheckout(): Promise<void> {
  const { url } = await request<{ url: string }>("POST", "/billing/checkout");
  await openUrl(url);
  const until = Date.now() + CHECKOUT_POLL_FOR;
  const poll = async () => {
    await refreshPass();
    if (info()?.plan !== "rt" && Date.now() < until) setTimeout(() => void poll(), CHECKOUT_POLL);
  };
  setTimeout(() => void poll(), CHECKOUT_POLL);
}

/** The provider's page to change the card, cancel, or see the invoices. */
export async function openPortal(): Promise<void> {
  const { url } = await request<{ url: string }>("POST", "/billing/portal");
  await openUrl(url);
}

/** Take the real-time session back from the other device. */
export async function useRealtimeHere(): Promise<void> {
  await commands.marketPassResume();
  setElsewhere(false);
}
