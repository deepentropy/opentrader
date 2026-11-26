/*
 * Live data (#252), opened from the title bar's data badge: one line and one
 * button — upgrade, the subscription, or take the live data back from another
 * device. Signed out, the upgrade starts with the sign-in and goes on to the
 * payment. The payment is made here: a frame of the accounts server's payment
 * page (deploy/community/src/pay-page.ts), which holds the payment provider's
 * own form. Built on the shared confirm dialog.
 *
 * During the live data beta the dialog only says so: signed in, live data is on
 * and free until the beta ends; signed out, signing in turns it on.
 */
import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { showConfirm, showNotice } from "../../components/Dialogs";
import { PROVIDER_LABELS, me, signIn } from "../../data/community/session";
import { request } from "../../data/community/api";
import {
  awaitPlan, betaEnds, openPortal, paidOffer, payInBrowser, planInfo, realtimeElsewhere, refreshPass, setCancelled, startCheckout, useRealtimeHere, type PlanInfo,
} from "../../data/paid/plan";
import { translateAs, translateWith } from "../../i18n/translator";

/** dd/mm/yyyy of a UNIX time. */
function day(sec: number): string {
  const d = new Date(sec * 1000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function failed(e: unknown): void {
  showNotice({ title: "Live data", text: e instanceof Error ? e.message : String(e) });
}

const offerText = () => translateWith("Prices without the 15-minute delay, for {0} per month. Cancel any time.", paidOffer()?.price ?? "$10");

/** dd/mm/yyyy of the beta's last day: its end is midnight after it in New York. */
export function betaDay(end: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts((end - 1) * 1000);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")}`;
}

/** What the beta is, and until when. */
export const betaText = (end: number) => translateWith("Live data is in beta: free until {0}, then part of a paid plan.", betaDay(end));

/** Signed in from the upgrade: on to the payment, or to the subscription the account already has. */
async function goOn(): Promise<void> {
  await refreshPass();
  const plan = await request<PlanInfo>("GET", "/me/plan").catch(() => null);
  if (plan && plan.plan === "free" && plan.status !== "past_due" && plan.billing) await showPayment();
  else showPlanDialog();
}

/** The payment page in a frame; tells when it is paid, or could not be loaded. */
function PaymentFrame(props: { address: string; onPaid: () => void; onBrowser: () => void }) {
  let frame!: HTMLIFrameElement;
  const [state, setState] = createSignal<"loading" | "ready" | "failed">("loading");
  onMount(() => {
    const origin = new URL(props.address).origin;
    const onMessage = (e: MessageEvent) => {
      // Of this frame and its server only.
      if (e.source !== frame.contentWindow || e.origin !== origin || e.data?.type !== "opentrader-billing") return;
      if (e.data.event === "complete") props.onPaid();
      else if (e.data.event === "ready" || e.data.event === "failed") setState(e.data.event);
    };
    window.addEventListener("message", onMessage);
    const late = setTimeout(() => state() === "loading" && setState("failed"), 20_000);
    onCleanup(() => {
      window.removeEventListener("message", onMessage);
      clearTimeout(late);
    });
  });
  return (
    <div class="plan-payment" data-qa-id="plan-payment">
      <iframe ref={frame} class="plan-payment-frame" src={props.address} title="Payment" allow="payment" referrerpolicy="no-referrer" />
      <Show when={state() === "failed"}><div class="plan-payment-note">The payment form could not be loaded here.</div></Show>
      <button type="button" class="plan-link" onClick={() => props.onBrowser()}>Pay in the browser instead</button>
    </div>
  );
}

/** On Linux the app's commands cannot tell a frame's calls from the app's own: no other site's page is framed there. */
const FRAMED = !/Linux/.test(navigator.userAgent);

/** Pay in the app, then wait for the plan. */
async function showPayment(): Promise<void> {
  const address = await startCheckout();
  if (!FRAMED) return payInBrowser(address);
  const close = showConfirm({
    title: "Upgrade to live data",
    text: offerText(),
    mainText: translateAs("Close", "action"),
    cancelText: null,
    intent: "neutral",
    body: () => (
      <PaymentFrame
        address={address}
        onPaid={() => {
          close();
          void awaitPlan().then((ok) => showNotice({ title: "Live data", text: ok ? "Payment received. Live data is on." : "Payment received. Live data starts in a few minutes." }));
        }}
        onBrowser={() => {
          close();
          void payInBrowser(address).catch(failed);
        }}
      />
    ),
    onConfirm: () => {},
  });
}

function SignInButtons(props: { onDone: () => void; beta?: boolean }) {
  const [providers] = createResource(() =>
    request<{ providers: string[] }>("GET", "/auth/providers").then((r) => r.providers, () => [] as string[]),
  );
  return (
    <div class="plan-signin">
      <For each={providers() ?? []}>
        {(p) => (
          <button
            type="button"
            class="plan-signin-button"
            onClick={() => signIn(p).then(props.onDone).then(props.beta ? refreshPass : goOn).catch((e) => e?.message !== "cancelled" && failed(e))}
          >
            {props.beta ? translateWith("Continue with {0}", PROVIDER_LABELS[p] ?? p) : translateWith("Upgrade with {0}", PROVIDER_LABELS[p] ?? p)}
          </button>
        )}
      </For>
    </div>
  );
}

/** What the account's subscription does now. */
function state(info: PlanInfo): string {
  const end = info.renews_at ? day(info.renews_at) : null;
  if (info.status === "past_due") return translateWith("The last payment failed. Update your card to keep live data.");
  if (end && info.cancel_at_period_end) return translateWith("Your subscription ends on {0}.", end);
  if (end) return translateWith("Your subscription renews on {0}.", end);
  return translateWith("Your subscription is active.");
}

function confirmCancel(info: PlanInfo): void {
  showConfirm({
    title: "Cancel subscription",
    text: info.renews_at ? translateWith("Live data stays on until {0}, then prices are delayed again. Nothing more is charged.", day(info.renews_at)) : translateWith("Nothing more is charged."),
    mainText: "Cancel subscription",
    cancelText: "Keep my subscription",
    intent: "danger",
    onConfirm: () => void setCancelled(true).then(showPlanDialog, failed),
  });
}

export function showPlanDialog(): void {
  const info = planInfo();
  if (me() && realtimeElsewhere()) {
    showConfirm({
      title: "Live data",
      text: "Live data is in use on another device. Use it here instead?",
      mainText: "Use here",
      cancelText: "Not now",
      onConfirm: () => void useRealtimeHere(),
    });
    return;
  }
  const beta = betaEnds();
  if (beta !== null) {
    if (me()) {
      showNotice({ title: "Live data (beta)", text: betaText(beta) });
      return;
    }
    const close = showConfirm({
      title: "Live data (beta)",
      text: translateWith("Sign in to get live market data. It is in beta: free until {0}, then part of a paid plan.", betaDay(beta)),
      mainText: "Not now",
      cancelText: null,
      intent: "neutral",
      body: () => <SignInButtons beta onDone={() => close()} />,
      onConfirm: () => {},
    });
    return;
  }
  if (me() && info && (info.plan === "rt" || info.status === "past_due")) {
    const close = showConfirm({
      title: "Live data",
      text: state(info),
      mainText: "Card and invoices",
      cancelText: translateAs("Close", "action"),
      intent: "neutral",
      body: () => (
        <button
          type="button"
          class="plan-link"
          data-qa-id="plan-cancel"
          onClick={() => {
            close();
            if (info.cancel_at_period_end) void setCancelled(false).then(showPlanDialog, failed);
            else confirmCancel(info);
          }}
        >
          {info.cancel_at_period_end ? "Keep my subscription" : "Cancel subscription"}
        </button>
      ),
      onConfirm: () => void openPortal().catch(failed),
    });
    return;
  }
  if (!me()) {
    const close = showConfirm({
      title: "Upgrade to live data",
      text: offerText(),
      mainText: "Not now",
      cancelText: null,
      intent: "neutral",
      body: () => <SignInButtons onDone={() => close()} />,
      onConfirm: () => {},
    });
    return;
  }
  showConfirm({
    title: "Upgrade to live data",
    text: offerText(),
    mainText: "Upgrade",
    cancelText: "Not now",
    onConfirm: () => void showPayment().catch(failed),
  });
}
