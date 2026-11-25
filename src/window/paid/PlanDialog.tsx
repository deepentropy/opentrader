/*
 * Live data (#252), opened from the title bar's data badge: one line and one
 * button — upgrade, manage the subscription, or take the live data back from
 * another device. Signed out, the upgrade starts with the sign-in and goes on
 * to the payment page. Built on the shared confirm dialog.
 */
import { For, createResource } from "solid-js";
import { showConfirm, showNotice } from "../../components/Dialogs";
import { PROVIDER_LABELS, me, signIn } from "../../data/community/session";
import { request } from "../../data/community/api";
import { openPortal, paidOffer, planInfo, realtimeElsewhere, refreshPass, startCheckout, useRealtimeHere, type PlanInfo } from "../../data/paid/plan";
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

/** Signed in from the upgrade: on to the payment, or to the subscription the account already has. */
async function goOn(): Promise<void> {
  await refreshPass();
  const plan = await request<PlanInfo>("GET", "/me/plan").catch(() => null);
  if (plan && plan.plan === "free" && plan.status !== "past_due" && plan.billing) await startCheckout();
  else showPlanDialog();
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
            onClick={() => signIn(p).then(props.onDone).then(goOn).catch((e) => e?.message !== "cancelled" && failed(e))}
          >
            {translateWith("Upgrade with {0}", PROVIDER_LABELS[p] ?? p)}
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
  if (me() && info && (info.plan === "rt" || info.status === "past_due")) {
    showConfirm({
      title: "Live data",
      text: state(info),
      mainText: "Manage subscription",
      cancelText: translateAs("Close", "action"),
      intent: "neutral",
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
    onConfirm: () => void startCheckout().catch(failed),
  });
}
