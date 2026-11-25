/*
 * The market data dialog (#252), opened from the title bar's data badge: the
 * two plans side by side, the account's one marked, and the one action that
 * fits it — sign in, subscribe, manage the subscription, or take real-time back
 * from another device. Built on the shared confirm dialog.
 */
import { For, Show, createResource } from "solid-js";
import { showConfirm, showNotice } from "../../components/Dialogs";
import { PROVIDER_LABELS, me, signIn } from "../../data/community/session";
import { request } from "../../data/community/api";
import { openPortal, paidOffer, planInfo, realtimeActive, realtimeElsewhere, startCheckout, useRealtimeHere, type PlanInfo } from "../../data/paid/plan";
import { translateAs, translateWith } from "../../i18n/translator";

/** dd/mm/yyyy of a UNIX time. */
function day(sec: number): string {
  const d = new Date(sec * 1000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function failed(e: unknown): void {
  showNotice({ title: "Market data", text: e instanceof Error ? e.message : String(e) });
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
            {translateWith("Continue with {0}", PROVIDER_LABELS[p] ?? p)}
          </button>
        )}
      </For>
    </div>
  );
}

/** The two plans; `current` is the account's. */
function Plans(props: { current: "free" | "rt" }) {
  return (
    <div class="plan-cards">
      <div class="plan-card" classList={{ "is-current": props.current === "free" }} data-qa-id="plan-free">
        <div class="plan-card-title">Delayed</div>
        <div class="plan-card-price">Free</div>
        <ul>
          <li>Prices 15 minutes late</li>
          <li>Every chart, indicator and tool</li>
        </ul>
        <Show when={props.current === "free"}><div class="plan-card-current">Your plan</div></Show>
      </div>
      <div class="plan-card" classList={{ "is-current": props.current === "rt" }} data-qa-id="plan-rt">
        <div class="plan-card-title">Real-time</div>
        <div class="plan-card-price">{translateWith("{0} per month", paidOffer()?.price ?? "$10")}</div>
        <ul>
          <li>Charts and watchlist move with every trade</li>
          <li>Real-time screener and alerts</li>
          <li>One device at a time</li>
          <li>Paid monthly, cancel any time</li>
        </ul>
        <Show when={props.current === "rt"}><div class="plan-card-current">Your plan</div></Show>
      </div>
    </div>
  );
}

/** What the account's subscription does now. */
function state(info: PlanInfo): string {
  const end = info.renews_at ? day(info.renews_at) : null;
  if (info.status === "past_due") return translateWith("The last payment failed. Update your card to keep real-time data.");
  if (!realtimeActive()) {
    if (end && info.cancel_at_period_end) return translateWith("Your subscription ends on {0}. Real-time data is connecting.", end);
    if (end) return translateWith("Your subscription renews on {0}. Real-time data is connecting.", end);
    return translateWith("Your subscription is active. Real-time data is connecting.");
  }
  if (end && info.cancel_at_period_end) return translateWith("Real-time data is on. Your subscription ends on {0}.", end);
  if (end) return translateWith("Real-time data is on. Your subscription renews on {0}.", end);
  return translateWith("Real-time data is on.");
}

export function showPlanDialog(): void {
  const info = planInfo();
  if (me() && realtimeElsewhere()) {
    showConfirm({
      title: "Market data",
      text: "Real-time data is in use on another device signed in to this account. Use it here: the other device goes back to delayed data.",
      mainText: "Use here",
      cancelText: "Not now",
      onConfirm: () => void useRealtimeHere(),
    });
    return;
  }
  if (me() && info && (info.plan === "rt" || info.status === "past_due")) {
    showConfirm({
      title: "Market data",
      text: state(info),
      mainText: "Manage subscription",
      cancelText: translateAs("Close", "action"),
      intent: "neutral",
      body: () => <Plans current="rt" />,
      onConfirm: () => void openPortal().catch(failed),
    });
    return;
  }
  if (!me()) {
    showConfirm({
      title: "Market data",
      text: "Sign in to your OpenTrader account to subscribe.",
      mainText: translateAs("Close", "action"),
      cancelText: null,
      intent: "neutral",
      body: () => (
        <>
          <Plans current="free" />
          <SignInButtons onDone={() => setTimeout(showPlanDialog, 500)} />
        </>
      ),
      onConfirm: () => {},
    });
    return;
  }
  if (info && !info.billing) {
    showNotice({ title: "Market data", text: "Subscriptions are not open yet." });
    return;
  }
  showConfirm({
    title: "Market data",
    text: "The payment page opens in your browser.",
    mainText: "Subscribe",
    cancelText: "Not now",
    body: () => <Plans current="free" />,
    onConfirm: () => void startCheckout().catch(failed),
  });
}
