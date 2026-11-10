/*
 * The real-time data dialog (#252), opened from the title bar's data badge:
 * the account's plan and renewal date, and the one action that fits it —
 * sign in, subscribe, manage the subscription, or take real-time back from
 * another device. Built on the shared confirm dialog.
 */
import { For, createResource } from "solid-js";
import { showConfirm, showNotice } from "../../components/Dialogs";
import { PROVIDER_LABELS, me, signIn } from "../../data/community/session";
import { request } from "../../data/community/api";
import { openPortal, planInfo, realtimeActive, realtimeElsewhere, startCheckout, useRealtimeHere } from "../../data/paid/plan";
import { translateAs } from "../../i18n/translator";

const PRICE = "$10/month";
const WHAT = "Real-time prices on charts, in the watchlist and in the screener, instead of 15-minute delayed data.";

/** dd/mm/yyyy of a UNIX time. */
function day(sec: number): string {
  const d = new Date(sec * 1000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function failed(e: unknown): void {
  showNotice({ title: "Real-time data", text: e instanceof Error ? e.message : String(e) });
}

function SignInButtons(props: { onDone: () => void }) {
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
            onClick={() => signIn(p).then(props.onDone, (e) => e?.message !== "cancelled" && failed(e))}
          >
            Continue with {PROVIDER_LABELS[p] ?? p}
          </button>
        )}
      </For>
    </div>
  );
}

export function showPlanDialog(): void {
  if (!me()) {
    showConfirm({
      title: "Real-time data",
      text: `${WHAT} ${PRICE}. Sign in to your OpenTrader account to subscribe.`,
      mainText: translateAs("Close", "action"),
      cancelText: null,
      intent: "neutral",
      body: () => <SignInButtons onDone={() => setTimeout(showPlanDialog, 500)} />,
      onConfirm: () => {},
    });
    return;
  }
  const info = planInfo();
  if (realtimeElsewhere()) {
    showConfirm({
      title: "Real-time data",
      text: "Real-time data is in use on another device signed in to this account. Use it here: the other device goes back to delayed data.",
      mainText: "Use here",
      cancelText: "Not now",
      onConfirm: () => void useRealtimeHere(),
    });
    return;
  }
  if (info?.plan === "rt") {
    const end = info.renews_at ? day(info.renews_at) : null;
    const when = end ? (info.cancel_at_period_end ? ` It ends on ${end}.` : ` It renews on ${end}.`) : "";
    const state = realtimeActive() ? "Real-time data is on." : "Your subscription is active; real-time data is not served to this account yet.";
    showConfirm({
      title: "Real-time data",
      text: `${state}${when}`,
      mainText: "Manage subscription",
      cancelText: translateAs("Close", "action"),
      intent: "neutral",
      onConfirm: () => void openPortal().catch(failed),
    });
    return;
  }
  if (info && !info.billing) {
    showNotice({ title: "Real-time data", text: "Subscriptions are not open yet." });
    return;
  }
  showConfirm({
    title: "Real-time data",
    text: `${WHAT} ${PRICE}, cancel any time. The payment page opens in your browser.`,
    mainText: "Subscribe",
    cancelText: "Not now",
    onConfirm: () => void startCheckout().catch(failed),
  });
}
